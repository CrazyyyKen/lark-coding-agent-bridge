import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { log } from '../../core/logger';
import type { CopilotCliMode } from '../../config/profile-schema';
import type { ApprovalBroker } from './approvals';
import {
  describeCliPolicy,
  evaluateCliArgs,
  evaluateFullModeArgs,
  needsOwnerApproval,
  type CliPolicy,
  type CliRisk,
} from './cli-policy';
import type { RunLarkCliOutput } from './cli-executor';
import type { ExecutionGrant, ExecutionRegistry } from './execution-registry';

/**
 * The bridge's MCP endpoint for Copilot Studio.
 *
 * A dedicated listener (never the localhost management console), loopback by
 * default, reachable from Studio only through a tunnel / ingress the owner
 * chooses. Serves exactly two routes: the MCP path and GET /healthz.
 *
 * Two independent checks guard every tool call:
 *   1. the request carries the MCP API key (identifies the Studio connection);
 *   2. the tool arguments carry an execution token that resolves in the
 *      registry to a live, admitted bridge run (identifies the run).
 * Discovery (initialize, tools/list) needs (1). Execution needs both.
 */

export const MCP_TOOL_NAMES = {
  runCli: 'run_lark_cli',
  listOperations: 'list_lark_cli_operations',
  ping: 'bridge_ping',
} as const;

export interface McpServiceOptions {
  bindHost: string;
  port: number;
  path: string;
  authHeader: string;
  allowedOrigins: readonly string[];
  apiKey: string;
  registry: ExecutionRegistry;
  policy: CliPolicy;
  /** Executes an already-policy-approved canonical argument array. */
  runCli(args: string[], grant: ExecutionGrant): Promise<RunLarkCliOutput>;
  /** `read-only` = curated read operations; `full` = wider policy + owner approval. */
  mode?: CopilotCliMode;
  /** Full mode: risk level lark-cli declares for a command path. */
  riskOf?: (commandPath: string[]) => Promise<CliRisk>;
  /** Full mode: asks the owner before high-risk commands run. */
  approvals?: ApprovalBroker;
  approvalTimeoutMs?: number;
  version: string;
  maxBodyBytes?: number;
  /** Max tool-result text returned to Studio per call. */
  maxResultChars?: number;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESULT_CHARS = 64 * 1024;
const TOOL_EVENT_OUTPUT_CHARS = 2000;

export class McpHttpService {
  private server: Server | undefined;
  private readonly apiKeyDigest: Buffer;
  private toolCallSeq = 0;

  constructor(private readonly opts: McpServiceOptions) {
    if (!opts.apiKey || opts.apiKey.length < 16) {
      throw new Error('MCP API key must be at least 16 characters');
    }
    this.apiKeyDigest = sha256(opts.apiKey);
  }

  async start(): Promise<{ url: string }> {
    if (this.server) return { url: this.localUrl() };
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        log.warn('copilot-mcp', 'request-failed', { err: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal error');
        else res.end();
      });
    });
    server.headersTimeout = 30_000;
    server.requestTimeout = 10 * 60_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.bindHost, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    log.info('copilot-mcp', 'listening', { url: this.localUrl() });
    return { url: this.localUrl() };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    log.info('copilot-mcp', 'closed', {});
  }

  address(): AddressInfo | undefined {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr : undefined;
  }

  localUrl(): string {
    const addr = this.address();
    const host = this.opts.bindHost.includes(':') ? `[${this.opts.bindHost}]` : this.opts.bindHost;
    return `http://${host}:${addr?.port ?? this.opts.port}${this.opts.path}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (url.pathname !== this.opts.path) {
      res.writeHead(404).end();
      return;
    }

    // A browser can reach a loopback port; Studio is a server-side client and
    // sends no Origin. Refuse browser-originated requests unless allowlisted.
    const origin = req.headers.origin;
    if (origin && !this.opts.allowedOrigins.includes(origin)) {
      log.warn('copilot-mcp', 'rejected-origin', { origin });
      sendJsonRpcError(res, 403, -32001, 'Forbidden origin');
      return;
    }
    if (!this.authorized(req)) {
      log.warn('copilot-mcp', 'rejected-auth', { method: req.method, hasHeader: this.hasAuthHeader(req) });
      sendJsonRpcError(res, 401, -32001, 'Unauthorized');
      return;
    }
    if (req.method !== 'POST') {
      // Stateless JSON-response mode: no standalone SSE stream, no sessions.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES));
    } catch (err) {
      const tooLarge = err instanceof BodyTooLargeError;
      sendJsonRpcError(res, tooLarge ? 413 : 400, -32700, tooLarge ? 'Request body too large' : 'Parse error');
      return;
    }

    // Stateless: a fresh server + transport per request (the SDK's
    // recommended pattern); authority lives in the execution registry.
    const mcp = this.createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private hasAuthHeader(req: IncomingMessage): boolean {
    return Boolean(req.headers[this.opts.authHeader] ?? req.headers.authorization);
  }

  private authorized(req: IncomingMessage): boolean {
    const candidates: string[] = [];
    const custom = req.headers[this.opts.authHeader];
    if (typeof custom === 'string') candidates.push(custom.trim());
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string' && /^bearer\s+/i.test(authorization)) {
      candidates.push(authorization.replace(/^bearer\s+/i, '').trim());
    }
    return candidates.some((candidate) => candidate && timingSafeEqual(sha256(candidate), this.apiKeyDigest));
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'lark-bridge', version: this.opts.version },
      {
        instructions:
          'Tools that run read-only lark-cli commands on the bridge owner\'s computer. Every call needs the ' +
          'executionToken given in the current message\'s bridge_execution block; pass it unchanged.',
      },
    );
    const tokenSchema = z
      .string()
      .min(8)
      .max(512)
      .describe('The executionToken from the bridge_execution block of the current user message. Pass it unchanged.');

    const full = this.opts.mode === 'full';
    server.registerTool(
      MCP_TOOL_NAMES.runCli,
      {
        title: full ? 'Run a lark-cli command' : 'Run a read-only lark-cli command',
        description: full
          ? 'Run one lark-cli command for the bridge owner (reads and writes) and return its output. ' +
            'args is the argument array WITHOUT the leading "lark-cli", e.g. ["im","+messages-send","--chat-id","oc_x","--text","hi"]. ' +
            'No shell: no pipes, redirects or quoting. Discover commands with ["<domain>","--help"] or ["schema","<service.resource.method>"]. ' +
            'Not allowed: auth, config, profile, update, api; --as, --profile, --jq, --yes; absolute file paths. ' +
            'High-risk commands (deletes, permission changes, anything lark-cli marks high-risk) wait for the owner to approve in Lark; ' +
            'if the owner rejects, do not retry.'
          : 'Run one allowlisted, read-only lark-cli command for the bridge owner and return its output. ' +
            'args is the argument array WITHOUT the leading "lark-cli", e.g. ["calendar","+agenda","--start","2026-09-24"]. ' +
            'No shell: no pipes, redirects or quoting. Identity (--as), --profile, --jq and file downloads are not allowed. ' +
            `Allowed commands: ${this.opts.policy.operations.map((op) => op.command.join(' ')).join('; ')}. ` +
            'Call list_lark_cli_operations for the flags of each command.',
        inputSchema: {
          executionToken: tokenSchema,
          args: z.array(z.string().max(4000)).min(1).max(64).describe('lark-cli arguments, one token per element.'),
        },
        outputSchema: {
          exitCode: z.number().nullable(),
          stdout: z.string(),
          stderr: z.string(),
          truncated: z.boolean(),
          timedOut: z.boolean(),
        },
        annotations: full
          ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
          : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ executionToken, args }, extra) =>
        full
          ? this.runFullModeTool(executionToken, args, extra.signal)
          : this.runCliTool(executionToken, args, extra.signal),
    );

    server.registerTool(
      MCP_TOOL_NAMES.listOperations,
      {
        title: 'List allowed lark-cli operations',
        description: 'List the lark-cli commands and flags this bridge allows, with a one-line summary each.',
        inputSchema: { executionToken: tokenSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ executionToken }) => {
        const resolved = this.opts.registry.resolve(executionToken);
        if (!resolved.ok) return tokenRejected(resolved.code);
        if (full) {
          return textResult(
            JSON.stringify(
              {
                mode: 'full',
                rules: [
                  'Any lark-cli command except auth, config, profile, update and api.',
                  'Discover commands with run_lark_cli ["<domain>","--help"] (domains: calendar, im, docs, drive, base, sheets, slides, mail, task, wiki, contact, okr, approval, attendance, vc, minutes, note, whiteboard, mindnotes, markdown, event, application).',
                  'Inspect raw API methods with ["schema","<service.resource.method>"]; read domain guides with ["skills","read","lark-<domain>"].',
                  'Never pass --as, --profile, --jq or --yes, and only use relative file paths.',
                  'High-risk commands wait for the owner to approve in Lark.',
                ],
                readOnlyShortcuts: describeCliPolicy(this.opts.policy),
              },
              null,
              2,
            ),
          );
        }
        return textResult(JSON.stringify({ operations: describeCliPolicy(this.opts.policy) }, null, 2));
      },
    );

    server.registerTool(
      MCP_TOOL_NAMES.ping,
      {
        title: 'Bridge connectivity check',
        description:
          'Harmless fixture tool: confirms this MCP connection and the executionToken work. Returns a fixed payload.',
        inputSchema: { executionToken: tokenSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ executionToken }) => {
        const resolved = this.opts.registry.resolve(executionToken);
        if (!resolved.ok) return tokenRejected(resolved.code);
        const id = this.nextToolCallId();
        resolved.grant.emit({ type: 'tool_use', id, name: MCP_TOOL_NAMES.ping, input: {} });
        const payload = { ok: true, fixture: 'lark-bridge-pong', receivedAt: new Date().toISOString() };
        resolved.grant.emit({ type: 'tool_result', id, output: JSON.stringify(payload), isError: false });
        log.info('copilot-mcp', 'call', { tool: MCP_TOOL_NAMES.ping, runId: resolved.grant.runId });
        return textResult(JSON.stringify(payload));
      },
    );
    return server;
  }

  private async runCliTool(
    executionToken: string,
    args: string[],
    requestSignal: AbortSignal,
  ): Promise<ToolResult> {
    const resolved = this.opts.registry.resolve(executionToken);
    if (!resolved.ok) {
      log.warn('copilot-mcp', 'token-rejected', { tool: MCP_TOOL_NAMES.runCli, code: resolved.code });
      return tokenRejected(resolved.code);
    }
    const grant = resolved.grant;
    const decision = evaluateCliArgs(this.opts.policy, args, grant.accessMode);
    const id = this.nextToolCallId();
    if (!decision.ok) {
      log.warn('copilot-mcp', 'policy-rejected', { runId: grant.runId, code: decision.code });
      grant.emit({ type: 'tool_use', id, name: 'lark-cli', input: { args } });
      grant.emit({ type: 'tool_result', id, output: decision.message, isError: true });
      return errorResult(`rejected by bridge policy (${decision.code}): ${decision.message}`);
    }
    if (!grant.beginCall()) {
      return errorResult('this reply reached the bridge tool-call limit; answer with what you have');
    }
    const startedAt = Date.now();
    grant.emit({ type: 'tool_use', id, name: 'lark-cli', input: { args: decision.args } });
    try {
      if (requestSignal.aborted || grant.signal.aborted) return tokenRejected('revoked');
      const output = await this.opts.runCli(decision.args, grant);
      const isError = output.exitCode !== 0 || output.timedOut || output.cancelled;
      log.info('copilot-mcp', 'call', {
        tool: MCP_TOOL_NAMES.runCli,
        runId: grant.runId,
        operation: decision.operation.id,
        exitCode: output.exitCode,
        truncated: output.truncated,
        timedOut: output.timedOut,
        cancelled: output.cancelled,
        durationMs: Date.now() - startedAt,
      });
      grant.emit({
        type: 'tool_result',
        id,
        output: clip(output.stdout || output.stderr, TOOL_EVENT_OUTPUT_CHARS),
        isError,
      });
      if (output.cancelled) return errorResult('the bridge run was stopped; do not retry');
      const maxChars = this.opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
      const structured = {
        exitCode: output.exitCode,
        stdout: clip(output.stdout, maxChars),
        stderr: clip(output.stderr, 8000),
        truncated: output.truncated || output.stdout.length > maxChars,
        timedOut: output.timedOut,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured,
        ...(isError ? { isError: true } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('copilot-mcp', 'call-failed', { runId: grant.runId, operation: decision.operation.id, err: message });
      grant.emit({ type: 'tool_result', id, output: 'lark-cli failed to start', isError: true });
      return errorResult('lark-cli failed to start on the bridge host');
    } finally {
      grant.endCall();
    }
  }

  /** Full mode: wider policy, lark-cli risk levels, owner approval, write dedup. */
  private async runFullModeTool(
    executionToken: string,
    args: string[],
    requestSignal: AbortSignal,
  ): Promise<ToolResult> {
    const resolved = this.opts.registry.resolve(executionToken);
    if (!resolved.ok) {
      log.warn('copilot-mcp', 'token-rejected', { tool: MCP_TOOL_NAMES.runCli, code: resolved.code });
      return tokenRejected(resolved.code);
    }
    const grant = resolved.grant;
    const id = this.nextToolCallId();
    const decision = evaluateFullModeArgs(args);
    if (!decision.ok) {
      log.warn('copilot-mcp', 'policy-rejected', { runId: grant.runId, code: decision.code });
      grant.emit({ type: 'tool_use', id, name: 'lark-cli', input: { args } });
      grant.emit({ type: 'tool_result', id, output: decision.message, isError: true });
      return errorResult(`rejected by bridge policy (${decision.code}): ${decision.message}`);
    }
    if (grant.accessMode !== 'full') {
      return errorResult('this run is read-only; write commands are not available');
    }
    if (!grant.beginCall()) {
      return errorResult('this reply reached the bridge tool-call limit; answer with what you have');
    }
    const commandLabel = decision.commandPath.join(' ');
    grant.emit({ type: 'tool_use', id, name: 'lark-cli', input: { args: decision.args } });
    try {
      const risk: CliRisk = decision.help
        ? 'read'
        : ((await this.opts.riskOf?.(decision.commandPath)) ?? 'unknown');
      const isWrite = risk !== 'read';
      const dedupKey = JSON.stringify(decision.args);
      if (isWrite && grant.completedWrites.has(dedupKey)) {
        grant.emit({ type: 'tool_result', id, output: 'already executed in this reply', isError: false });
        const previous = grant.completedWrites.get(dedupKey) as Record<string, unknown>;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                alreadyExecuted: true,
                note: 'This exact command already ran in this reply; it was not run again.',
                ...previous,
              }),
            },
          ],
          structuredContent: previous,
        };
      }

      let finalArgs = decision.args;
      if (!decision.help && needsOwnerApproval(decision.commandPath, risk)) {
        const approvals = this.opts.approvals;
        if (!approvals?.canAsk) {
          grant.emit({ type: 'tool_result', id, output: 'owner approval unavailable', isError: true });
          return errorResult('this command needs the owner approval, but the bridge cannot ask right now; do not retry');
        }
        const approval = await approvals.request({
          runId: grant.runId,
          commandText: `lark-cli ${decision.args.map(quoteForDisplay).join(' ')}`,
          reason:
            risk === 'high-risk-write'
              ? 'lark-cli 标记为高风险操作'
              : risk === 'unknown'
                ? '无法确认该命令的风险等级'
                : '删除/撤回/转移类操作',
          timeoutMs: this.opts.approvalTimeoutMs ?? 120_000,
          signal: AbortSignal.any([grant.signal, requestSignal]),
        });
        log.info('copilot-mcp', 'approval', { runId: grant.runId, command: commandLabel, decision: approval });
        if (approval !== 'approved') {
          grant.emit({ type: 'tool_result', id, output: `owner ${approval}`, isError: true });
          return errorResult(
            approval === 'rejected'
              ? 'The owner rejected this operation. Do not retry it; tell the user it was not done.'
              : `The owner did not approve this operation (${approval}). Do not retry; tell the user it was not done.`,
          );
        }
        if (risk === 'high-risk-write') finalArgs = [...decision.args, '--yes'];
      }

      if (requestSignal.aborted || grant.signal.aborted) return tokenRejected('revoked');
      const startedAt = Date.now();
      const output = await this.opts.runCli(finalArgs, grant);
      const isError = output.exitCode !== 0 || output.timedOut || output.cancelled;
      log.info('copilot-mcp', 'call', {
        tool: MCP_TOOL_NAMES.runCli,
        runId: grant.runId,
        operation: commandLabel,
        risk,
        exitCode: output.exitCode,
        truncated: output.truncated,
        timedOut: output.timedOut,
        cancelled: output.cancelled,
        durationMs: Date.now() - startedAt,
      });
      grant.emit({
        type: 'tool_result',
        id,
        output: clip(output.stdout || output.stderr, TOOL_EVENT_OUTPUT_CHARS),
        isError,
      });
      if (output.cancelled) return errorResult('the bridge run was stopped; do not retry');
      const maxChars = this.opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
      const structured = {
        exitCode: output.exitCode,
        stdout: clip(output.stdout, maxChars),
        stderr: clip(output.stderr, 8000),
        truncated: output.truncated || output.stdout.length > maxChars,
        timedOut: output.timedOut,
      };
      if (isWrite && output.exitCode === 0) grant.completedWrites.set(dedupKey, structured);
      return {
        content: [{ type: 'text', text: JSON.stringify(structured) }],
        structuredContent: structured,
        ...(isError ? { isError: true } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('copilot-mcp', 'call-failed', { runId: grant.runId, operation: commandLabel, err: message });
      grant.emit({ type: 'tool_result', id, output: 'lark-cli failed to start', isError: true });
      return errorResult('lark-cli failed to start on the bridge host');
    } finally {
      grant.endCall();
    }
  }

  private nextToolCallId(): string {
    this.toolCallSeq += 1;
    return `mcp-${this.toolCallSeq}`;
  }
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function tokenRejected(code: string): ToolResult {
  return errorResult(
    `executionToken rejected (${code}). Tools only work while the bridge is handling the current message; ` +
      'use the executionToken from the latest bridge_execution block, and do not retry with an old one.',
  );
}

/** Display-only quoting for the approval message; execution never uses a shell. */
function quoteForDisplay(arg: string): string {
  return /^[A-Za-z0-9_+.,:=@/-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLargeError());
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res
    .writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}
