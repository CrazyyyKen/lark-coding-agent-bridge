import type { NormalizedMessage } from '@larksuite/channel';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotStudioAdapter } from '../../../src/agent/copilot-studio/adapter.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeDirectLine } from '../../helpers/fake-direct-line.js';

/**
 * Lark → bridge → Copilot Studio (fake Direct Line) → bridge MCP → lark-cli
 * (stub) → Copilot Studio → Lark, through the real channel, run flow, policy,
 * executor, session catalog and adapter. Only the Lark SDK transport, the
 * Direct Line service and the lark-cli process are faked.
 */

const sdkMock = vi.hoisted(() => ({
  channel: undefined as unknown,
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

const API_KEY = 'e2e-mcp-api-key-0123456789abcdef';
const cleanups: Array<() => Promise<void>> = [];
let fake: FakeDirectLine;

beforeEach(async () => {
  fake = new FakeDirectLine();
  await fake.start();
  fake.mcpApiKey = API_KEY;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await fake.stop();
  sdkMock.channel = undefined;
});

interface Sent {
  chatId: string;
  content: { markdown?: string; text?: string };
  options?: unknown;
}

function fakeLarkChannel() {
  const handlers: { message?: (msg: NormalizedMessage) => Promise<void> } = {};
  const sent: Sent[] = [];
  const channel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: { application: { get: vi.fn(async () => ({ data: { app: { owner: { owner_id: 'ou_owner' } } } })) } },
      },
      im: {
        v1: {
          message: { get: vi.fn(async () => ({ data: { items: [] } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'r1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(next: typeof handlers) {
      Object.assign(handlers, next);
    },
    async getAppInfo() {
      return { ownerId: 'ou_owner' };
    },
    async listChats() {
      return [];
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group' as const;
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId: string, content: Sent['content'], options?: unknown) {
      sent.push({ chatId, content, options });
      return { messageId: `sent_${sent.length}` };
    },
    async stream() {
      throw new Error('text reply mode never streams');
    },
    async addReaction() {
      return 'r1';
    },
    async removeReaction() {},
  };
  return channel;
}

async function harness(options: { full?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'copilot-e2e-'));
  const workspace = await realpath(dir);
  const base = createDefaultProfileConfig({
    agentKind: 'copilot-studio',
    accounts: { app: { id: 'cli_e2e', secret: 'secret', tenant: 'lark' } },
    access: { allowedUsers: ['ou_friend'], allowedChats: ['oc_group'] },
    preferences: { messageReply: 'text', messageReplyMigrated: true },
    ...(options.full ? { permissions: { defaultAccess: 'full', maxAccess: 'full' } } : {}),
  });
  const profileConfig: ProfileConfig = {
    ...base,
    workspaces: { default: workspace },
    copilotStudio: {
      ...base.copilotStudio!,
      directLineBaseUrl: fake.origin,
      pollIntervalMs: 20,
      quietWindowMs: 400,
      mcp: { ...base.copilotStudio!.mcp, port: 0 },
      cli: { ...base.copilotStudio!.cli, ...(options.full ? { mode: 'full' as const } : {}) },
    },
  };
  const executed: string[][] = [];
  const agent = new CopilotStudioAdapter({
    profile: 'copilot',
    profileDir: dir,
    config: profileConfig.copilotStudio!,
    keystorePaths: { secretsFile: join(dir, 'secrets.enc'), keystoreSaltFile: join(dir, '.salt') },
    userSeed: 'cli_e2e',
    version: 'test',
    trustedOriginsForTesting: [fake.origin],
    resolveSecret: async (_input, label) => (label.includes('directLine') ? fake.secret : API_KEY),
    resolveCli: async () => ({ path: process.execPath, via: 'configured' }),
    runCli: async (args) => {
      executed.push(args);
      return {
        exitCode: 0,
        stdout: '{"events":[{"summary":"Standup","start":"09:30"}]}',
        stderr: '',
        truncated: false,
        timedOut: false,
        cancelled: false,
      };
    },
    maintenanceIntervalMs: 0,
    riskOf: async (path) => (path.join(' ') === 'calendar +delete' ? 'high-risk-write' : 'write'),
  });
  await agent.start();
  fake.mcpUrl = agent.mcpLocalUrl;

  const channel = fakeLarkChannel();
  sdkMock.channel = channel;
  const sessions = new SessionStore(join(dir, 'sessions.json'));
  const sessionCatalog = new SessionCatalog(join(dir, 'sessions.json.catalog.json'));
  const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
  const controls = {
    profile: 'copilot',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: join(dir, 'config.json'),
    cfg: profileConfig,
    processId: 'proc_e2e',
  };
  const bridge = await startChannel({ cfg: profileConfig, agent, sessions, sessionCatalog, workspaces, controls });
  cleanups.push(async () => {
    await bridge.disconnect();
    await agent.dispose();
    await Promise.all([sessions.flush(), sessionCatalog.flush(), workspaces.flush()]);
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { channel, executed, sessionCatalog };
}

let msgSeq = 0;
function message(content: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  msgSeq += 1;
  return {
    messageId: `om_${msgSeq}`,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_owner',
    senderName: 'Owner',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
    ...overrides,
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

describe('Lark ↔ Copilot Studio end to end', () => {
  it('answers an owner DM using a read-only lark-cli tool call, then continues the conversation', async () => {
    const { channel, executed } = await harness();
    fake.behavior = async (turn) => {
      const result = await turn.callTool('run_lark_cli', {
        executionToken: turn.executionToken,
        args: ['calendar', '+agenda', '--format', 'json'],
      });
      const events = JSON.parse(JSON.parse(result.text).stdout).events as Array<{ summary: string }>;
      turn.reply(`今天有 ${events.length} 个会议：${events[0]!.summary}\n[[turn-complete]]`);
    };

    await channel.handlers.message?.(message('今天有什么会？'));
    await waitFor(() => channel.sent.length === 1);

    expect(executed).toEqual([['calendar', '+agenda', '--format=json']]);
    const reply = channel.sent[0]!.content.markdown ?? '';
    expect(reply).toContain('今天有 1 个会议：Standup');
    expect(reply).not.toContain('[[turn-complete]]');
    expect(reply).not.toContain('cst_');
    expect(channel.sent[0]!.options).toMatchObject({ replyTo: 'om_1' });

    // The Studio message carried the Lark context but not local-agent instructions.
    const posted = fake.conversation('conv-1').activities.find((a) => a.from.id.startsWith('dl_'))!;
    expect(posted.text).toContain('今天有什么会？');
    expect(posted.text).not.toContain('LARK_CHANNEL');
    // Studio gets no bridge system prompt, so the bot's Lark name rides along.
    expect(posted.text).toContain('"botName":"Bridge"');

    fake.behavior = (turn) => turn.reply('明天也有一个 [[turn-complete]]');
    await channel.handlers.message?.(message('明天呢？'));
    await waitFor(() => channel.sent.length === 2);
    expect(channel.sent[1]!.content.markdown).toContain('明天也有一个');
    expect(fake.conversations.size).toBe(1);
    expect(fake.conversation('conv-1').activities.filter((a) => a.from.id.startsWith('dl_'))).toHaveLength(2);
  }, 20_000);

  it('full mode: a high-risk command waits for /approve from the owner in Lark', async () => {
    const { channel, executed } = await harness({ full: true });
    fake.behavior = async (turn) => {
      const result = await turn.callTool('run_lark_cli', {
        executionToken: turn.executionToken,
        args: ['calendar', '+delete', '--event-id', 'evt_1'],
      });
      turn.reply(`${result.isError ? '没有删除：' + result.text : '已删除'}\n[[turn-complete]]`);
    };

    await channel.handlers.message?.(message('删掉 evt_1 这个会'));
    await waitFor(() => channel.sent.some((s) => s.chatId === 'ou_owner'));
    const ask = channel.sent.find((s) => s.chatId === 'ou_owner')!.content.markdown ?? '';
    expect(ask).toContain('lark-cli calendar +delete --event-id evt_1');
    const code = /\/approve (\d{4})/.exec(ask)![1]!;
    expect(executed).toEqual([]);

    await channel.handlers.message?.(message(`/approve ${code}`));
    await waitFor(() => channel.sent.some((s) => s.chatId === 'oc_dm' && (s.content.markdown ?? '').includes('已删除')));
    expect(executed).toEqual([['calendar', '+delete', '--event-id', 'evt_1', '--yes']]);
  }, 20_000);

  it('full mode: /reject stops a high-risk command, and others cannot approve', async () => {
    const { channel, executed } = await harness({ full: true });
    fake.behavior = async (turn) => {
      const result = await turn.callTool('run_lark_cli', {
        executionToken: turn.executionToken,
        args: ['calendar', '+delete', '--event-id', 'evt_2'],
      });
      turn.reply(`${result.isError ? '没有删除' : '已删除'}\n[[turn-complete]]`);
    };
    await channel.handlers.message?.(message('删掉 evt_2'));
    await waitFor(() => channel.sent.some((s) => s.chatId === 'ou_owner'));
    const code = /\/approve (\d{4})/.exec(channel.sent.find((s) => s.chatId === 'ou_owner')!.content.markdown ?? '')![1]!;

    await channel.handlers.message?.(message(`/approve ${code}`, { chatId: 'oc_friend', senderId: 'ou_friend' }));
    await waitFor(() => channel.sent.some((s) => s.chatId === 'oc_friend'));
    expect(executed).toEqual([]);

    await channel.handlers.message?.(message(`/reject ${code}`));
    await waitFor(() => channel.sent.some((s) => s.chatId === 'oc_dm' && (s.content.markdown ?? '').includes('没有删除')));
    expect(executed).toEqual([]);
  }, 20_000);

  it('/new starts a fresh Copilot Studio conversation', async () => {
    const { channel } = await harness();
    fake.behavior = (turn) => turn.reply('one [[turn-complete]]');
    await channel.handlers.message?.(message('first'));
    await waitFor(() => channel.sent.length === 1);
    await channel.handlers.message?.(message('/new'));
    await waitFor(() => channel.sent.length === 2);
    await channel.handlers.message?.(message('second'));
    await waitFor(() => channel.sent.length === 3);
    expect(fake.conversations.size).toBe(2);
  }, 20_000);

  it('rejects group chats and non-owner DMs before anything reaches Studio', async () => {
    const { channel, executed } = await harness();
    await channel.handlers.message?.(
      message('hi from group', { chatId: 'oc_group', chatType: 'group', mentionedBot: true } as Partial<NormalizedMessage>),
    );
    await waitFor(() => channel.sent.length === 1);
    expect(channel.sent[0]!.content.markdown).toContain('只接受 bot 所有者在私聊中发起的请求');

    await channel.handlers.message?.(message('hi from friend', { chatId: 'oc_friend', senderId: 'ou_friend' }));
    await waitFor(() => channel.sent.length === 2);
    expect(channel.sent[1]!.content.markdown).toContain('只接受 bot 所有者在私聊中发起的请求');

    expect(fake.conversations.size).toBe(0);
    expect(executed).toEqual([]);
  }, 20_000);
});
