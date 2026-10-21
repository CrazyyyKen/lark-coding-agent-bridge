import type { NormalizedMessage } from '@larksuite/channel';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { Schedule } from '../../../src/scheduler/store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return { ...actual, createLarkChannel: sdkMock.createLarkChannel };
});

import { startChannel } from '../../../src/bot/channel.js';

interface SentMessage {
  chatId: string;
  content: { markdown?: string; text?: string };
  options?: { replyTo?: string };
}

interface FakeLarkChannel {
  handlers: { message?: (msg: NormalizedMessage) => Promise<void> | void };
  sent: SentMessage[];
  [key: string]: unknown;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('scheduled tasks through the bridge', () => {
  it("posts a due task in the owner's DM and runs it as a message from them", async () => {
    const h = await createHarness();
    await writeSchedules(h.tmp, [schedule({ nextRunAt: Date.now() - 1000 })]);
    await startTestBridge(h);

    await waitFor(() => h.agent.runOptions.length === 1);
    const header = h.channel.sent.find((m) => m.content.markdown?.startsWith('⏰ **Scheduled task**'));
    expect(header?.chatId).toBe('oc_dm');
    expect(header?.content.markdown).toContain('Triage my unread inbox');

    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('[Scheduled task s1ab · weekdays 08:30');
    expect(prompt).toContain('Triage my unread inbox');
    expect(prompt).toContain('"senderId":"ou_user"');

    await waitFor(async () => (await readSchedules(h.tmp))[0]?.lastResult === 'ran');
    const [saved] = await readSchedules(h.tmp);
    expect(saved!.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('does not run a task for someone who may no longer use the bot', async () => {
    const h = await createHarness();
    await writeSchedules(h.tmp, [schedule({ ownerId: 'ou_removed', nextRunAt: Date.now() - 1000 })]);
    await startTestBridge(h);

    await waitFor(async () => (await readSchedules(h.tmp))[0]?.lastResult === 'not-allowed');
    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('tells the owner about a run it missed while offline instead of running hours late', async () => {
    const h = await createHarness();
    await writeSchedules(h.tmp, [schedule({ nextRunAt: Date.now() - 3 * 60 * 60 * 1000 })]);
    await startTestBridge(h);

    await waitFor(() => h.channel.sent.length === 1);
    expect(h.channel.sent[0]?.content.markdown).toContain('I was offline');
    expect(h.channel.sent[0]?.content.markdown).toContain('/schedule run s1ab');
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('adds a task with /schedule add and runs it on /schedule run', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(dm('/schedule add weekdays 08:30 Summarize my unread mail'));
    await waitFor(() => h.channel.sent.length === 1);
    const reply = h.channel.sent[0]!;
    expect(reply.options?.replyTo).toBe('om_cmd');
    expect(reply.content.markdown).toContain('**weekdays 08:30**');
    expect(h.agent.runOptions).toHaveLength(0);

    await waitFor(async () => (await readSchedules(h.tmp)).length === 1);
    const [saved] = await readSchedules(h.tmp);
    expect(saved).toMatchObject({ ownerId: 'ou_user', chatId: 'oc_dm', prompt: 'Summarize my unread mail' });

    await h.channel.handlers.message?.(dm(`/schedule run ${saved!.id}`, 'om_run'));
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]?.prompt).toContain('Summarize my unread mail');
  });

  it('refuses /schedule in a group chat', async () => {
    const h = await createHarness({ chatMode: 'group' });
    await startTestBridge(h);

    await h.channel.handlers.message?.({
      ...dm('/schedule add daily 09:00 x'),
      chatId: 'oc_group',
      chatType: 'group',
      mentionedBot: true,
    });
    await waitFor(() => h.channel.sent.length === 1);
    expect(h.channel.sent[0]?.content.markdown).toContain('private chat');
    expect(await readSchedules(h.tmp)).toEqual([]);
  });
});

async function createHarness(opts: { chatMode?: 'p2p' | 'group' } = {}) {
  const tmp = await createTmpProfile('scheduled-task-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_group'], allowedUsers: ['ou_user'] },
  });
  const profileConfig = { ...base, workspaces: { ...base.workspaces, default: workspace } };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
  const channel = createFakeLarkChannel(opts.chatMode ?? 'p2p');
  sdkMock.channel = channel;
  const controls = {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: join(tmp.root, 'config.json'),
    cfg: profileConfig,
    processId: 'proc_test',
  };
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return { tmp, channel, agent, sessions, workspaces, profileConfig, controls };
}

async function startTestBridge(h: Awaited<ReturnType<typeof createHarness>>): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    appPaths: {
      secretsFile: join(h.tmp.profile, 'secrets.enc'),
      keystoreSaltFile: join(h.tmp.profile, '.keystore.salt'),
      mediaDir: join(h.tmp.profile, 'media'),
      profileDir: h.tmp.profile,
    },
  });
  cleanups.unshift(() => bridge.disconnect());
}

function createFakeLarkChannel(chatMode: 'p2p' | 'group'): FakeLarkChannel {
  const handlers: FakeLarkChannel['handlers'] = {};
  const sent: SentMessage[] = [];
  return {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })),
          },
        },
      },
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(next: FakeLarkChannel['handlers']) {
      Object.assign(handlers, next);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return chatMode;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId: string, content: SentMessage['content'], options?: SentMessage['options']) {
      sent.push({ chatId, content, ...(options ? { options } : {}) });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(_chatId: string, input: unknown) {
      const producer = (input as { markdown?: unknown }).markdown;
      if (typeof producer === 'function') await producer({ setContent: async () => {} });
    },
  };
}

function schedule(patch: Partial<Schedule>): Schedule {
  return {
    id: 's1ab',
    ownerId: 'ou_user',
    ownerName: 'User',
    chatId: 'oc_dm',
    prompt: 'Triage my unread inbox',
    label: 'weekdays 08:30',
    when: { kind: 'cron', expr: '30 8 * * 1-5' },
    timeZone: 'Asia/Kuala_Lumpur',
    enabled: true,
    createdAt: Date.now() - 86_400_000,
    ...patch,
  };
}

async function writeSchedules(tmp: TmpProfile, schedules: Schedule[]): Promise<void> {
  await writeFile(join(tmp.profile, 'schedules.json'), JSON.stringify({ schedules }), 'utf8');
}

async function readSchedules(tmp: TmpProfile): Promise<Schedule[]> {
  try {
    const text = await readFile(join(tmp.profile, 'schedules.json'), 'utf8');
    return (JSON.parse(text) as { schedules: Schedule[] }).schedules;
  } catch {
    return [];
  }
}

function dm(content: string, messageId = 'om_cmd'): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
