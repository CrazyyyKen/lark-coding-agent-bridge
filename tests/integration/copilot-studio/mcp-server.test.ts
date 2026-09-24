import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBroker } from '../../../src/agent/copilot-studio/approvals.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCliPolicy } from '../../../src/agent/copilot-studio/cli-policy.js';
import { ExecutionRegistry } from '../../../src/agent/copilot-studio/execution-registry.js';
import { McpHttpService } from '../../../src/agent/copilot-studio/mcp-server.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { callMcpTool } from '../../helpers/fake-direct-line.js';

const API_KEY = 'test-mcp-api-key-0123456789';

let registry: ExecutionRegistry;
let service: McpHttpService;
let url: string;
let executed: string[][];

beforeEach(async () => {
  registry = new ExecutionRegistry();
  executed = [];
  service = new McpHttpService({
    bindHost: '127.0.0.1',
    port: 0,
    path: '/mcp',
    authHeader: 'x-api-key',
    allowedOrigins: [],
    apiKey: API_KEY,
    registry,
    policy: createCliPolicy(undefined).policy,
    version: 'test',
    runCli: async (args) => {
      executed.push(args);
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '', truncated: false, timedOut: false, cancelled: false };
    },
  });
  url = (await service.start()).url;
});

afterEach(async () => {
  await service.close();
});

function grant(events: AgentEvent[] = []) {
  return registry.register({
    runId: 'run-1',
    profile: 'copilot',
    accessMode: 'read-only',
    ttlMs: 60_000,
    maxCalls: 5,
    emit: (event) => events.push(event),
  });
}

async function post(body: unknown, headers: Record<string, string>) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

describe('copilot studio MCP endpoint', () => {
  it('requires the API key for discovery and execution', async () => {
    expect((await post(initialize, {})).status).toBe(401);
    expect((await post(initialize, { 'x-api-key': 'wrong-key-wrong-key' })).status).toBe(401);
    expect((await post(initialize, { 'x-api-key': API_KEY })).status).toBe(200);
    expect((await post(initialize, { authorization: `Bearer ${API_KEY}` })).status).toBe(200);
  });

  it('refuses browser-originated requests and serves nothing but MCP + healthz', async () => {
    expect((await post(initialize, { 'x-api-key': API_KEY, origin: 'https://evil.example' })).status).toBe(403);
    const base = new URL(url);
    expect((await fetch(new URL('/healthz', base))).status).toBe(200);
    expect((await fetch(new URL('/', base))).status).toBe(404);
    expect((await fetch(new URL('/api/config', base))).status).toBe(404);
    expect((await fetch(url, { headers: { 'x-api-key': API_KEY } })).status).toBe(405);
  });

  it('lists the lark-bridge tools to an authenticated client', async () => {
    const client = new Client({ name: 'fake-studio', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'x-api-key': API_KEY } } }),
    );
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name).sort()).toEqual(['bridge_ping', 'list_lark_cli_operations', 'run_lark_cli']);
    const run = tools.find((t) => t.name === 'run_lark_cli')!;
    expect(run.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(run.inputSchema)).toContain('executionToken');
  });

  it('runs an allowed command only with a live execution token, and correlates events', async () => {
    const events: AgentEvent[] = [];
    const handle = grant(events);
    const ok = await callMcpTool(url, API_KEY, 'run_lark_cli', {
      executionToken: handle.token,
      args: ['calendar', '+agenda', '--start', '2026-09-24'],
    });
    expect(ok.isError).toBeUndefined();
    expect(ok.structured).toMatchObject({ exitCode: 0, stdout: '{"ok":true}' });
    expect(executed).toEqual([['calendar', '+agenda', '--start=2026-09-24']]);
    expect(events.map((e) => e.type)).toEqual(['tool_use', 'tool_result']);
    expect(events[0]).toMatchObject({ name: 'lark-cli', input: { args: ['calendar', '+agenda', '--start=2026-09-24'] } });

    const badToken = await callMcpTool(url, API_KEY, 'run_lark_cli', { executionToken: 'cst_guessguess', args: ['whoami'] });
    expect(badToken.isError).toBe(true);
    expect(badToken.text).toContain('unknown-token');

    handle.revoke('turn-complete');
    const revoked = await callMcpTool(url, API_KEY, 'run_lark_cli', { executionToken: handle.token, args: ['whoami'] });
    expect(revoked.isError).toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('rejects policy violations before spawning anything', async () => {
    const events: AgentEvent[] = [];
    const handle = grant(events);
    const result = await callMcpTool(url, API_KEY, 'run_lark_cli', {
      executionToken: handle.token,
      args: ['whoami', '--as', 'user'],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('flag-not-allowed');
    expect(executed).toEqual([]);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true });
  });

  it('full mode: runs writes, asks the owner for high-risk ones, and never runs a write twice', async () => {
    await service.close();
    const broker = new ApprovalBroker();
    const asked: Array<{ code: string; commandText: string }> = [];
    broker.setNotifier(async (request) => {
      asked.push(request);
    });
    const risks: Record<string, 'read' | 'write' | 'high-risk-write'> = {
      'im +messages-send': 'write',
      'calendar +delete': 'high-risk-write',
      'calendar +agenda': 'read',
    };
    service = new McpHttpService({
      bindHost: '127.0.0.1',
      port: 0,
      path: '/mcp',
      authHeader: 'x-api-key',
      allowedOrigins: [],
      apiKey: API_KEY,
      registry,
      policy: createCliPolicy(undefined).policy,
      version: 'test',
      mode: 'full',
      riskOf: async (path) => risks[path.join(' ')] ?? 'unknown',
      approvals: broker,
      approvalTimeoutMs: 5000,
      runCli: async (args) => {
        executed.push(args);
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '', truncated: false, timedOut: false, cancelled: false };
      },
    });
    url = (await service.start()).url;
    const handle = registry.register({
      runId: 'run-full',
      profile: 'copilot',
      accessMode: 'full',
      ttlMs: 60_000,
      maxCalls: 10,
      emit: () => {},
    });
    const call = (args: string[]) => callMcpTool(url, API_KEY, 'run_lark_cli', { executionToken: handle.token, args });

    // A normal write runs straight away, and a retried identical write is not re-run.
    const send = ['im', '+messages-send', '--chat-id', 'oc_1', '--text', 'hi'];
    expect((await call(send)).isError).toBeUndefined();
    const again = await call(send);
    expect(again.text).toContain('alreadyExecuted');
    expect(executed.filter((a) => a[1] === '+messages-send')).toHaveLength(1);

    // High-risk: waits for the owner; approval appends --yes.
    const pending = call(['calendar', '+delete', '--event-id', 'e1']);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]!.commandText).toBe('lark-cli calendar +delete --event-id e1');
    expect(executed.some((a) => a[1] === '+delete')).toBe(false);
    broker.resolve(asked[0]!.code, 'approved');
    expect((await pending).isError).toBeUndefined();
    expect(executed.at(-1)).toEqual(['calendar', '+delete', '--event-id', 'e1', '--yes']);

    // Rejected: nothing runs.
    const rejected = call(['calendar', '+delete', '--event-id', 'e2']);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    broker.resolve(asked[1]!.code, 'rejected');
    const result = await rejected;
    expect(result.isError).toBe(true);
    expect(result.text).toContain('rejected');
    expect(executed.some((a) => a.includes('e2'))).toBe(false);

    // Still blocked in full mode.
    expect((await call(['auth', 'login'])).text).toContain('unknown-operation');
    expect((await call(['calendar', '+delete', '--event-id', 'e3', '--yes'])).text).toContain('flag-not-allowed');
  });

  it('full mode tools are unavailable to a read-only grant', async () => {
    await service.close();
    service = new McpHttpService({
      bindHost: '127.0.0.1',
      port: 0,
      path: '/mcp',
      authHeader: 'x-api-key',
      allowedOrigins: [],
      apiKey: API_KEY,
      registry,
      policy: createCliPolicy(undefined).policy,
      version: 'test',
      mode: 'full',
      riskOf: async () => 'write',
      runCli: async (args) => {
        executed.push(args);
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: false };
      },
    });
    url = (await service.start()).url;
    const handle = grant();
    const result = await callMcpTool(url, API_KEY, 'run_lark_cli', {
      executionToken: handle.token,
      args: ['im', '+messages-send', '--text', 'x'],
    });
    expect(result.isError).toBe(true);
    expect(executed).toEqual([]);
  });

  it('answers the fixture ping and the operations listing only for a live token', async () => {
    const handle = grant();
    const ping = await callMcpTool(url, API_KEY, 'bridge_ping', { executionToken: handle.token });
    expect(JSON.parse(ping.text)).toMatchObject({ ok: true, fixture: 'lark-bridge-pong' });
    const ops = await callMcpTool(url, API_KEY, 'list_lark_cli_operations', { executionToken: handle.token });
    expect(JSON.parse(ops.text).operations.map((op: { id: string }) => op.id)).toContain('calendar.agenda');
    const noToken = await callMcpTool(url, API_KEY, 'bridge_ping', { executionToken: 'cst_nope_nope' });
    expect(noToken.isError).toBe(true);
  });
});
