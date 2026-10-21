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
  content: { markdown?: string; text?: string; card?: unknown };
  options?: { replyTo?: string };
}

interface CardClick {
  chatId: string;
  messageId: string;
  operator: { openId: string; name?: string };
  action: { value: Record<string, unknown> };
}

interface FakeLarkChannel {
  handlers: {
    message?: (msg: NormalizedMessage) => Promise<void> | void;
    cardAction?: (evt: CardClick) => Promise<void> | void;
  };
  sent: SentMessage[];
  updated: Array<{ messageId: string; card: unknown }>;
  /** Text the reply stream showed, update by update. */
  streamed: string[];
  [key: string]: unknown;
}

const cleanups: Array<() => Promise<void>> = [];

// Each test starts a whole bridge; under a full parallel run that can take a
// few seconds before the first scheduler tick.
vi.setConfig({ testTimeout: 20_000 });

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
    const header = h.channel.sent.find((m) => JSON.stringify(m.content.card ?? '').includes('⏰ Scheduled task'));
    expect(header?.chatId).toBe('oc_dm');
    const headerCard = JSON.stringify(header?.content.card);
    expect(headerCard).toContain('Triage my unread inbox');
    expect(findButtonValue(header?.content.card, '▶ Run again')).toEqual({ cmd: 'schedule.run', arg: 's1ab' });
    expect(findButtonValue(header?.content.card, '⏸ Pause schedule')).toEqual({
      cmd: 'schedule.pause',
      arg: 's1ab run-card',
    });

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
    const card = JSON.stringify(h.channel.sent[0]?.content.card);
    expect(card).toContain('I was offline');
    expect(card).toContain('"cmd":"schedule.run","arg":"s1ab"');
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it("turns a /schedule add line in the agent's reply into a card only the requester can confirm", async () => {
    const h = await createHarness({
      agentEvents: [
        { type: 'text', delta: 'Tap the card to confirm, or send:\n```\n/schedule add weekdays 08:30 Triage my inbox\n```' },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(dm('Every weekday at 8:30, triage my inbox'));
    const cardMessage = await waitForSent(h, (m) => JSON.stringify(m.content.card ?? '').includes('Create schedule'));
    const value = findButtonValue(cardMessage.content.card, 'Create schedule');
    expect(value).toMatchObject({ cmd: 'schedule.confirm' });
    expect(await readSchedules(h.tmp)).toEqual([]);

    // Someone else tapping it creates nothing.
    await h.channel.handlers.cardAction?.(click('ou_other', 'om_sent_card', value!));
    expect(await readSchedules(h.tmp)).toEqual([]);

    await h.channel.handlers.cardAction?.(click('ou_user', 'om_sent_card', value!));
    await waitFor(async () => (await readSchedules(h.tmp)).length === 1);
    const [saved] = await readSchedules(h.tmp);
    expect(saved).toMatchObject({ ownerId: 'ou_user', chatId: 'oc_dm', prompt: 'Triage my inbox', label: 'weekdays 08:30' });
    expect(JSON.stringify(h.channel.updated.at(-1)?.card)).toContain('Scheduled');

    // A second tap doesn't add a duplicate.
    await h.channel.handlers.cardAction?.(click('ou_user', 'om_sent_card', value!));
    expect(await readSchedules(h.tmp)).toHaveLength(1);
  });

  it('lists tasks as a card whose buttons pause and remove them in place', async () => {
    const h = await createHarness();
    await writeSchedules(h.tmp, [schedule({ nextRunAt: Date.now() + 86_400_000 })]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(dm('/schedule list'));
    const list = await waitForSent(h, (m) => JSON.stringify(m.content.card ?? '').includes('Your scheduled tasks'));
    const pause = findButtonValue(list.content.card, '⏸ Pause');
    expect(pause).toEqual({ cmd: 'schedule.pause', arg: 's1ab' });

    await h.channel.handlers.cardAction?.(click('ou_user', 'om_list', pause!));
    await waitFor(async () => (await readSchedules(h.tmp))[0]?.enabled === false);
    expect(h.channel.updated.at(-1)?.messageId).toBe('om_list');
    const resume = findButtonValue(h.channel.updated.at(-1)?.card, '▶ Resume');
    expect(resume).toEqual({ cmd: 'schedule.resume', arg: 's1ab' });

    const remove = findButtonValue(h.channel.updated.at(-1)?.card, 'Remove');
    await h.channel.handlers.cardAction?.(click('ou_user', 'om_list', remove!));
    await waitFor(async () => (await readSchedules(h.tmp)).length === 0);
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

describe('quick replies and run-card buttons', () => {
  const draftReply = [
    'Draft to Kenny: "Hi Kenny, please see the attached request."',
    '```quick-replies',
    'Send it',
    'Cancel',
    '/schedule list',
    '```',
  ].join('\n');

  it('shows the options as buttons, not text, and only the requester can answer', async () => {
    const h = await createHarness({
      team: true,
      agentEvents: [
        { type: 'text', delta: draftReply },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(dm('Draft a reply to Kenny'));
    const buttonsCard = await waitForSent(h, (m) => JSON.stringify(m.content.card ?? '').includes('quick_reply'));
    const shown = [...h.channel.streamed, ...h.channel.sent.map((m) => m.content.markdown ?? '')].join('\n');
    expect(shown).toContain('Draft to Kenny');
    expect(shown).not.toContain('quick-replies');
    expect(shown).not.toContain('Send it');
    const send = findButtonValue(buttonsCard.content.card, 'Send it')!;
    expect(send).toMatchObject({ i: 0 });

    // Not the requester (a team bot lets them past the access check): nothing happens.
    await h.channel.handlers.cardAction?.(click('ou_other', 'om_buttons', send));
    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.channel.updated.find((u) => u.messageId === 'om_buttons')).toBeUndefined();

    await h.channel.handlers.cardAction?.(click('ou_user', 'om_buttons', send));
    await waitFor(() => h.agent.runOptions.length === 2);
    expect(h.agent.runOptions[1]?.prompt).toContain('Send it');
    expect(JSON.stringify(h.channel.updated.find((u) => u.messageId === 'om_buttons')?.card)).toContain('✔ Send it');

    // Answered already: a second tap only says so.
    await h.channel.handlers.cardAction?.(click('ou_user', 'om_buttons', send));
    await waitForSent(h, (m) => (m.content.markdown ?? '').includes('expired'));
    expect(h.agent.runOptions).toHaveLength(2);
  });

  it('runs a /command option as the command instead of sending it to the agent', async () => {
    const h = await createHarness({
      agentEvents: [
        { type: 'text', delta: draftReply },
        { type: 'done', terminationReason: 'normal' },
      ],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(dm('Draft a reply to Kenny'));
    const buttonsCard = await waitForSent(h, (m) => JSON.stringify(m.content.card ?? '').includes('quick_reply'));
    const list = findButtonValue(buttonsCard.content.card, '/schedule list')!;

    await h.channel.handlers.cardAction?.(click('ou_user', 'om_buttons', list));
    await waitForSent(h, (m) => JSON.stringify(m.content.card ?? '').includes('Your scheduled tasks'));
    expect(h.agent.runOptions).toHaveLength(1);
  });

  it('pauses a schedule from the card posted when it ran, and resumes it there', async () => {
    const h = await createHarness();
    await writeSchedules(h.tmp, [schedule({ nextRunAt: Date.now() - 1000 })]);
    await startTestBridge(h);

    const runCard = await waitForSent(h, (m) => JSON.stringify(m.content.card ?? '').includes('⏰ Scheduled task'));
    const pause = findButtonValue(runCard.content.card, '⏸ Pause schedule')!;
    await h.channel.handlers.cardAction?.(click('ou_user', 'om_run', pause));
    await waitFor(async () => (await readSchedules(h.tmp))[0]?.enabled === false);
    const paused = h.channel.updated.find((u) => u.messageId === 'om_run')?.card;
    const resume = findButtonValue(paused, '▶ Resume schedule')!;

    await h.channel.handlers.cardAction?.(click('ou_user', 'om_run', resume));
    await waitFor(async () => (await readSchedules(h.tmp))[0]?.enabled === true);
  });
});

async function createHarness(
  opts: {
    chatMode?: 'p2p' | 'group';
    /** Team mode: anyone may use the bot, so only the requester checks stop others. */
    team?: boolean;
    agentEvents?: NonNullable<ConstructorParameters<typeof FakeAgentAdapter>[0]>['events'];
  } = {},
) {
  const tmp = await createTmpProfile('scheduled-task-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedChats: ['oc_group'], allowedUsers: ['ou_user'] },
  });
  const profileConfig = {
    ...base,
    ...(opts.team ? { mode: 'team' as const } : {}),
    workspaces: { ...base.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: opts.agentEvents ?? [{ type: 'done', terminationReason: 'normal' }],
  });
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
  const updated: FakeLarkChannel['updated'] = [];
  const streamed: string[] = [];
  return {
    handlers,
    sent,
    updated,
    streamed,
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
    async updateCard(messageId: string, card: unknown) {
      updated.push({ messageId, card });
    },
    async stream(_chatId: string, input: unknown) {
      const producer = (input as { markdown?: unknown }).markdown;
      if (typeof producer === 'function') {
        await producer({
          setContent: async (markdown: string) => {
            streamed.push(markdown);
          },
        });
      }
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

function click(openId: string, messageId: string, value: Record<string, unknown>): CardClick {
  return { chatId: 'oc_dm', messageId, operator: { openId, name: openId }, action: { value } };
}

/** The `value` of the button labelled `text` anywhere in a card. */
function findButtonValue(card: unknown, text: string): Record<string, unknown> | undefined {
  if (!card || typeof card !== 'object') return undefined;
  const node = card as { tag?: string; text?: { content?: string }; value?: Record<string, unknown> };
  if (node.tag === 'button' && node.text?.content === text) return node.value;
  for (const child of Object.values(card)) {
    const found = Array.isArray(child)
      ? child.map((c) => findButtonValue(c, text)).find(Boolean)
      : findButtonValue(child, text);
    if (found) return found;
  }
  return undefined;
}

async function waitForSent(
  h: Awaited<ReturnType<typeof createHarness>>,
  match: (m: SentMessage) => boolean,
): Promise<SentMessage> {
  await waitFor(() => h.channel.sent.some(match));
  return h.channel.sent.find(match)!;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
