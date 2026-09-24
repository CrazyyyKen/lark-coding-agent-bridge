import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CopilotStudioAdapter,
  type CopilotStudioAdapterOptions,
  type CopilotTurnEndInfo,
} from '../../../src/agent/copilot-studio/adapter.js';
import type { AgentEvent, AgentRun } from '../../../src/agent/types.js';
import type { CopilotStudioConfig } from '../../../src/config/profile-schema.js';
import { callMcpTool, FakeDirectLine } from '../../helpers/fake-direct-line.js';

const API_KEY = 'adapter-test-mcp-key-0123456789';

let fake: FakeDirectLine;
let origin: string;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  fake = new FakeDirectLine();
  origin = await fake.start();
  fake.mcpApiKey = API_KEY;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await fake.stop();
});

function testConfig(overrides: Partial<CopilotStudioConfig> = {}): CopilotStudioConfig {
  return {
    directLineBaseUrl: origin,
    directLineSecret: { source: 'keystore', id: 'dl' },
    pollIntervalMs: 20,
    turnTimeoutMs: 5000,
    quietWindowMs: 300,
    completionMarker: '[[turn-complete]]',
    maxMessageChars: 24_000,
    mcp: {
      bindHost: '127.0.0.1',
      port: 0,
      path: '/mcp',
      authSecret: { source: 'keystore', id: 'mcp' },
      authHeader: 'x-api-key',
      allowedOrigins: [],
      maxCallsPerRun: 5,
    },
    cli: { mode: 'read-only', approvalTimeoutMs: 5000, timeoutMs: 5000, maxOutputBytes: 64 * 1024 },
    ...overrides,
  };
}

async function createAdapter(
  overrides: Partial<CopilotStudioAdapterOptions> = {},
  config: Partial<CopilotStudioConfig> = {},
): Promise<{ adapter: CopilotStudioAdapter; ends: CopilotTurnEndInfo[]; executed: string[][] }> {
  const profileDir = await mkdtemp(join(tmpdir(), 'copilot-adapter-'));
  const ends: CopilotTurnEndInfo[] = [];
  const executed: string[][] = [];
  const adapter = new CopilotStudioAdapter({
    profile: 'copilot',
    profileDir,
    config: testConfig(config),
    keystorePaths: { secretsFile: join(profileDir, 'secrets.enc'), keystoreSaltFile: join(profileDir, '.salt') },
    userSeed: 'cli_test',
    version: 'test',
    trustedOriginsForTesting: [origin],
    resolveSecret: async (_input, label) => (label.includes('directLine') ? fake.secret : API_KEY),
    resolveCli: async () => ({ path: process.execPath, via: 'configured' }),
    runCli: async (args) => {
      executed.push(args);
      return { exitCode: 0, stdout: '{"identity":"bot"}', stderr: '', truncated: false, timedOut: false, cancelled: false };
    },
    maintenanceIntervalMs: 0,
    onTurnEnd: (info) => ends.push(info),
    ...overrides,
  });
  await adapter.start();
  fake.mcpUrl = adapter.mcpLocalUrl;
  cleanups.push(async () => {
    await adapter.dispose();
    await rm(profileDir, { recursive: true, force: true });
  });
  return { adapter, ends, executed };
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

function text(events: AgentEvent[]): string {
  return events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
}

let runSeq = 0;
function runOpts(prompt: string, threadId?: string) {
  runSeq += 1;
  return { runId: `run-${runSeq}`, prompt, sandbox: 'read-only' as const, ...(threadId ? { threadId } : {}) };
}

describe('CopilotStudioAdapter over Direct Line', () => {
  it('sends the prompt with a per-turn token, renders the reply and strips the marker', async () => {
    const { adapter, ends } = await createAdapter();
    fake.behavior = (turn) => turn.reply('Hello from Copilot Studio\n[[turn-complete]]');

    const events = await collect(adapter.run(runOpts('<user_input>{"text":"hi"}</user_input>')));

    expect(events[0]).toEqual({ type: 'system', threadId: 'conv-1' });
    expect(text(events)).toBe('Hello from Copilot Studio');
    expect(events.at(-1)).toEqual({ type: 'done', threadId: 'conv-1', terminationReason: 'normal' });
    expect(ends[0]).toMatchObject({ outcome: 'complete', completion: 'marker', sawReply: true });

    const posted = fake.conversation('conv-1').activities.find((a) => a.from.id.startsWith('dl_lcb_'))!;
    expect(posted.text).toContain('"executionToken":"cst_');
    expect(posted.text).toContain('<user_input>');
    expect(posted.channelData?.clientActivityID).toEqual(expect.any(String));
  });

  it('executes a Studio tool call through MCP with the per-turn token, then revokes it', async () => {
    const { adapter, executed } = await createAdapter();
    let token: string | undefined;
    fake.behavior = async (turn) => {
      token = turn.executionToken;
      turn.typing();
      const result = await turn.callTool('run_lark_cli', { executionToken: turn.executionToken, args: ['whoami'] });
      turn.reply(`identity: ${result.text}\n[[turn-complete]]`);
    };

    const events = await collect(adapter.run(runOpts('who am i')));

    expect(executed).toEqual([['whoami']]);
    const toolUse = events.find((e) => e.type === 'tool_use');
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolUse).toMatchObject({ name: 'lark-cli', input: { args: ['whoami'] } });
    expect(toolResult).toMatchObject({ id: (toolUse as { id: string }).id, isError: false });
    expect(text(events)).toContain('identity');
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });

    const late = await callMcpTool(fake.mcpUrl!, API_KEY, 'run_lark_cli', { executionToken: token, args: ['whoami'] });
    expect(late.isError).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('ends the turn on the Studio turn.complete event, without needing the marker', async () => {
    const { adapter, ends } = await createAdapter({}, { quietWindowMs: 60_000 });
    fake.behavior = (turn) => {
      turn.reply('first part');
      turn.reply('second part');
      turn.event('turn.complete');
    };
    const events = await collect(adapter.run(runOpts('hi')));
    expect(text(events)).toBe('first part\n\nsecond part');
    expect(ends[0]).toMatchObject({ outcome: 'complete', completion: 'studio-event' });
    expect(ends[0]!.durationMs).toBeLessThan(5000);
  });

  it('does not cut a turn short while Studio thinks between tool calls once it is known to send turn.complete', async () => {
    const { adapter, ends, executed } = await createAdapter({}, { quietWindowMs: 200 });
    fake.behavior = (turn) => {
      turn.reply('hi');
      turn.event('turn.complete');
    };
    await collect(adapter.run(runOpts('warm up')));

    // Interim message, then a pause far longer than the quiet window, then a
    // tool call and the real answer (what "Put this into the doc…" looked like).
    fake.behavior = async (turn) => {
      turn.reply('Let me find that doc…');
      await new Promise((resolve) => setTimeout(resolve, 900));
      const result = await turn.callTool('run_lark_cli', { executionToken: turn.executionToken, args: ['whoami'] });
      turn.reply(result.isError ? `tool failed: ${result.text}` : 'Updated the doc.');
      turn.event('turn.complete');
    };
    const events = await collect(adapter.run(runOpts('put this into the doc', 'conv-1')));
    expect(text(events)).toBe('Let me find that doc…\n\nUpdated the doc.');
    expect(executed).toEqual([['whoami']]);
    expect(ends[1]).toMatchObject({ outcome: 'complete', completion: 'studio-event' });

    // The observation survives a bridge restart (new adapter, same profile dir).
    const { readFile } = await import('node:fs/promises');
    const profileDir = (adapter as unknown as { opts: { profileDir: string } }).opts.profileDir;
    const learned = JSON.parse(await readFile(join(profileDir, 'copilot-studio', 'learned.json'), 'utf8'));
    expect(learned).toEqual({ studioSignalsTurnEnd: true });
  });

  it('ignores a turn.complete that belongs to an earlier turn', async () => {
    const { adapter, ends } = await createAdapter();
    fake.behavior = (turn) => turn.reply('one [[turn-complete]]');
    await collect(adapter.run(runOpts('one')));
    const firstUserId = fake.conversation('conv-1').activities.find((a) => a.from.id.startsWith('dl_'))!.id;
    fake.behavior = (turn) => {
      turn.conversation.activities.push({
        type: 'event',
        name: 'turn.complete',
        id: `${turn.conversation.id}|late`,
        from: { id: 'bot' },
        replyToId: firstUserId,
      } as never);
      setTimeout(() => turn.reply('two [[turn-complete]]'), 100);
    };
    const events = await collect(adapter.run(runOpts('two', 'conv-1')));
    expect(text(events)).toBe('two');
    expect(ends[1]).toMatchObject({ completion: 'marker' });
  });

  it('explains a Studio tool-consent prompt instead of echoing an unclickable card', async () => {
    const { adapter } = await createAdapter();
    fake.behavior = (turn) => {
      turn.reply('', {
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              type: 'AdaptiveCard',
              body: [{ type: 'TextBlock', text: 'Allow lark-bridge to use your connection?' }],
              actions: [
                { type: 'Action.Submit', title: 'Allow', data: { action: 'Allow' } },
                { type: 'Action.Submit', title: 'Cancel', data: { action: 'Cancel' } },
              ],
            },
          },
        ],
      });
      turn.event('turn.awaitConsent');
      turn.event('turn.complete');
    };
    const events = await collect(adapter.run(runOpts('calendar please')));
    const out = text(events);
    expect(out).toContain('Maker-provided credentials');
    expect(out).not.toContain('Allow lark-bridge to use your connection');
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
  });

  it('falls back to the quiet window when no completion marker arrives (degraded)', async () => {
    const { adapter, ends } = await createAdapter();
    fake.behavior = (turn) => {
      turn.reply('part one');
      turn.reply('part two');
    };
    const events = await collect(adapter.run(runOpts('hi')));
    expect(text(events)).toBe('part one\n\npart two');
    expect(ends[0]).toMatchObject({ outcome: 'complete', completion: 'quiet-window' });
  });

  it('continues the same conversation on the next turn and never replays earlier replies', async () => {
    const { adapter } = await createAdapter();
    fake.behavior = (turn) => turn.reply('first answer [[turn-complete]]');
    const first = await collect(adapter.run(runOpts('one')));
    const firstUserId = fake.conversation('conv-1').activities.find((a) => a.from.id.startsWith('dl_'))!.id;

    // A late reply to turn 1 lands between turns, and another one during turn 2.
    fake.pushBot('conv-1', 'late reply to turn one', firstUserId);
    fake.behavior = (turn) => {
      fake.pushBot('conv-1', 'another late one', firstUserId);
      turn.reply('second answer [[turn-complete]]');
    };
    const second = await collect(adapter.run(runOpts('two', 'conv-1')));

    expect(text(first)).toBe('first answer');
    expect(second[0]).toEqual({ type: 'system', threadId: 'conv-1' });
    expect(text(second)).toBe('second answer');
    expect(fake.conversations.size).toBe(1);
  });

  it('stop() interrupts, revokes the token and replaces the conversation next time', async () => {
    const { adapter, executed } = await createAdapter();
    let token: string | undefined;
    let received!: () => void;
    const gotMessage = new Promise<void>((resolve) => {
      received = resolve;
    });
    fake.behavior = (turn) => {
      token = turn.executionToken;
      turn.typing();
      received();
    };
    const run = adapter.run(runOpts('long task'));
    const eventsPromise = collect(run);
    await gotMessage;
    await run.stop();
    const events = await eventsPromise;
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    expect(await run.waitForExit(1000)).toBe(true);

    const late = await callMcpTool(fake.mcpUrl!, API_KEY, 'run_lark_cli', { executionToken: token, args: ['whoami'] });
    expect(late.isError).toBe(true);
    expect(executed).toEqual([]);

    fake.behavior = (turn) => turn.reply('fresh [[turn-complete]]');
    const next = await collect(adapter.run(runOpts('again', 'conv-1')));
    expect(next[0]).toMatchObject({ type: 'text' });
    expect(text(next)).toContain('已开始新会话');
    expect(next.find((e) => e.type === 'system')).toEqual({ type: 'system', threadId: 'conv-2' });
  });

  it('times out a turn that never completes and quarantines the conversation', async () => {
    const { adapter, ends } = await createAdapter({}, { turnTimeoutMs: 400 });
    fake.behavior = (turn) => turn.typing();
    const events = await collect(adapter.run(runOpts('stuck')));
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((events.at(-1) as { message: string }).message).toContain('没有完成本轮回复');
    expect(ends[0]).toMatchObject({ outcome: 'timeout' });

    fake.behavior = (turn) => turn.reply('ok [[turn-complete]]');
    const next = await collect(adapter.run(runOpts('retry', 'conv-1')));
    expect(next.find((e) => e.type === 'system')).toEqual({ type: 'system', threadId: 'conv-2' });
  });

  it('reconciles an ambiguous POST (502 after acceptance) instead of resending', async () => {
    const { adapter } = await createAdapter();
    fake.failNext.set('POST /activities', { status: 502, afterAccept: true });
    fake.behavior = (turn) => turn.reply('answered once [[turn-complete]]');
    const events = await collect(adapter.run(runOpts('hello')));
    expect(text(events)).toBe('answered once');
    const userMessages = fake.conversation('conv-1').activities.filter((a) => a.from.id.startsWith('dl_'));
    expect(userMessages).toHaveLength(1);
  });

  it('reports rejected Direct Line credentials without leaking them', async () => {
    const { adapter } = await createAdapter({
      resolveSecret: async (_input, label) => (label.includes('directLine') ? 'wrong-secret-value-xxxxx' : API_KEY),
    });
    const events = await collect(adapter.run(runOpts('hello')));
    const error = events.at(-1) as { type: string; message: string };
    expect(error.type).toBe('error');
    expect(error.message).toContain('401/403');
    expect(error.message).not.toContain('wrong-secret-value');
  });

  it('announces a fresh conversation after a bridge restart (no in-memory state)', async () => {
    const first = await createAdapter();
    fake.behavior = (turn) => turn.reply('one [[turn-complete]]');
    await collect(first.adapter.run(runOpts('one')));

    const restarted = await createAdapter();
    const events = await collect(restarted.adapter.run(runOpts('two', 'conv-1')));
    expect(text(events)).toContain('bridge 重启后无法接续');
    expect(events.find((e) => e.type === 'system')).toEqual({ type: 'system', threadId: 'conv-2' });
  });

  it('refreshes a conversation token that is close to expiry', async () => {
    let clock = Date.now();
    const { adapter } = await createAdapter({ now: () => clock });
    fake.behavior = (turn) => turn.reply('a [[turn-complete]]');
    await collect(adapter.run(runOpts('one')));
    clock += 27 * 60_000;
    await collect(adapter.run(runOpts('two', 'conv-1')));
    expect(fake.requests).toContain('POST /v3/directline/tokens/refresh');
  });

  it('ends the turn on endOfConversation and starts over next time', async () => {
    const { adapter, ends } = await createAdapter();
    fake.behavior = (turn) => {
      turn.reply('bye');
      turn.endOfConversation();
    };
    const events = await collect(adapter.run(runOpts('end it')));
    expect(text(events)).toBe('bye');
    expect(ends[0]).toMatchObject({ completion: 'end-of-conversation' });
    fake.behavior = (turn) => turn.reply('hi again [[turn-complete]]');
    const next = await collect(adapter.run(runOpts('again', 'conv-1')));
    expect(next.find((e) => e.type === 'system')).toEqual({ type: 'system', threadId: 'conv-2' });
  });

  it('serializes turns per profile and lets a queued turn be stopped cleanly', async () => {
    const { adapter } = await createAdapter();
    let active = 0;
    let maxActive = 0;
    fake.behavior = async (turn) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 150));
      active -= 1;
      turn.reply('done [[turn-complete]]');
    };
    const [a, b] = await Promise.all([
      collect(adapter.run(runOpts('first'))),
      collect(adapter.run(runOpts('second'))),
    ]);
    expect(a.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(b.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(maxActive).toBe(1);

    // A turn stopped while queued never reaches Studio and quarantines nothing.
    fake.behavior = async (turn) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      turn.reply('slow [[turn-complete]]');
    };
    const running = collect(adapter.run(runOpts('slow', 'conv-1')));
    const queuedRun = adapter.run(runOpts('queued', 'conv-1'));
    const queued = collect(queuedRun);
    await queuedRun.stop();
    expect((await queued).at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    expect((await running).at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    fake.behavior = (turn) => turn.reply('still conv-1 [[turn-complete]]');
    const after = await collect(adapter.run(runOpts('after', 'conv-1')));
    expect(after[0]).toEqual({ type: 'system', threadId: 'conv-1' });
  });

  it('is unavailable with an untrusted Direct Line origin', async () => {
    const adapter = new CopilotStudioAdapter({
      profile: 'copilot',
      profileDir: tmpdir(),
      config: testConfig({ directLineBaseUrl: 'https://evil.example' }),
      keystorePaths: { secretsFile: 'x', keystoreSaltFile: 'y' },
      userSeed: 'cli',
      version: 'test',
      resolveSecret: async () => 'x'.repeat(32),
      resolveCli: async () => ({ path: process.execPath, via: 'configured' }),
      maintenanceIntervalMs: 0,
    });
    const availability = await adapter.checkAvailability();
    expect(availability).toMatchObject({ ok: false, diagnostic: { code: 'agent-remote-config-invalid' } });
  });
});
