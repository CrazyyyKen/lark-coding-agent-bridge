import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * In-process fake of the Bot Framework Direct Line 3.0 endpoints a Copilot
 * Studio agent exposes, with a scriptable "agent" that can reply, send typing
 * indicators and call the bridge's MCP tools (via the official MCP client),
 * the way a published Studio agent would.
 */

export interface FakeActivity {
  type: string;
  id: string;
  from: { id: string; role?: string };
  text?: string;
  replyToId?: string;
  channelData?: Record<string, unknown>;
  attachments?: unknown[];
}

export interface FakeConversation {
  id: string;
  activities: FakeActivity[];
  tokens: Set<string>;
}

export interface AgentTurn {
  conversation: FakeConversation;
  message: FakeActivity;
  /** Execution token parsed from the bridge_execution block. */
  executionToken?: string;
  reply(text: string, opts?: { replyToId?: string | null; attachments?: unknown[] }): void;
  typing(): void;
  /** Event activity (e.g. Studio's `turn.complete`), correlated to this turn. */
  event(name: string): void;
  endOfConversation(): void;
  callTool(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }>;
}

export type AgentBehavior = (turn: AgentTurn) => Promise<void> | void;

export class FakeDirectLine {
  private server: Server | undefined;
  readonly conversations = new Map<string, FakeConversation>();
  readonly secret = 'fake-direct-line-secret-value';
  behavior: AgentBehavior = (turn) => turn.reply('ok [[turn-complete]]');
  /** One-shot failures, keyed by `${METHOD} ${pathSuffix}` (e.g. 'POST /activities'). */
  failNext = new Map<string, { status: number; afterAccept?: boolean }>();
  mcpUrl: string | undefined;
  mcpApiKey: string | undefined;
  readonly requests: string[] = [];
  private seq = 0;
  private tokenSeq = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this.origin;
  }

  get origin(): string {
    const addr = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      this.server?.closeAllConnections();
    });
  }

  conversation(id: string): FakeConversation {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`no conversation ${id}`);
    return conv;
  }

  /** Append a bot activity out of band (e.g. a late reply). */
  pushBot(conversationId: string, text: string, replyToId?: string): void {
    const conv = this.conversation(conversationId);
    conv.activities.push({
      type: 'message',
      id: this.nextId(conv),
      from: { id: 'bot', role: 'bot' },
      text,
      ...(replyToId ? { replyToId } : {}),
    });
  }

  private nextId(conv: FakeConversation): string {
    this.seq += 1;
    return `${conv.id}|${String(this.seq).padStart(7, '0')}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const auth = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const body = await readJson(req);
    const key = `${req.method} ${url.pathname}`;
    this.requests.push(key);

    // Keys are `${METHOD} ${pathSuffix}`, e.g. 'POST /activities'.
    const failure = [...this.failNext.entries()].find(([k]) => {
      const [method, suffix] = k.split(' ');
      return req.method === method && suffix !== undefined && url.pathname.endsWith(suffix);
    });
    if (failure && !failure[1].afterAccept) {
      this.failNext.delete(failure[0]);
      return send(res, failure[1].status, {});
    }

    if (req.method === 'POST' && url.pathname === '/v3/directline/tokens/generate') {
      if (auth !== this.secret) return send(res, 403, {});
      const id = `conv-${this.conversations.size + 1}`;
      const token = `tok-${++this.tokenSeq}`;
      this.conversations.set(id, { id, activities: [], tokens: new Set([token]) });
      return send(res, 200, { conversationId: id, token, expires_in: 1800 });
    }
    if (req.method === 'POST' && url.pathname === '/v3/directline/tokens/refresh') {
      const conv = [...this.conversations.values()].find((c) => c.tokens.has(auth));
      if (!conv) return send(res, 403, {});
      const token = `tok-${++this.tokenSeq}`;
      conv.tokens.add(token);
      return send(res, 200, { conversationId: conv.id, token, expires_in: 1800 });
    }
    if (req.method === 'POST' && url.pathname === '/v3/directline/conversations') {
      const conv = [...this.conversations.values()].find((c) => c.tokens.has(auth));
      if (!conv) return send(res, 403, {});
      return send(res, 201, { conversationId: conv.id });
    }
    const m = /^\/v3\/directline\/conversations\/([^/]+)\/activities$/.exec(url.pathname);
    if (m) {
      const conv = this.conversations.get(decodeURIComponent(m[1]!));
      if (!conv || !conv.tokens.has(auth)) return send(res, 403, {});
      if (req.method === 'GET') {
        const watermark = url.searchParams.get('watermark');
        const from = watermark === null ? 0 : Number(watermark);
        return send(res, 200, { activities: conv.activities.slice(from), watermark: String(conv.activities.length) });
      }
      const activity = body as Omit<FakeActivity, 'id'>;
      const stored: FakeActivity = { ...activity, id: this.nextId(conv) } as FakeActivity;
      conv.activities.push(stored);
      void Promise.resolve().then(() => this.runBehavior(conv, stored));
      if (failure?.[1].afterAccept) {
        this.failNext.delete(failure[0]);
        return send(res, failure[1].status, {});
      }
      return send(res, 200, { id: stored.id });
    }
    send(res, 404, {});
  }

  private async runBehavior(conv: FakeConversation, message: FakeActivity): Promise<void> {
    const executionToken = /"executionToken":"([^"]+)"/.exec(message.text ?? '')?.[1];
    const turn: AgentTurn = {
      conversation: conv,
      message,
      ...(executionToken ? { executionToken } : {}),
      reply: (text, opts = {}) => {
        const replyToId = opts.replyToId === null ? undefined : (opts.replyToId ?? message.id);
        conv.activities.push({
          type: 'message',
          id: this.nextId(conv),
          from: { id: 'bot', role: 'bot' },
          text,
          ...(replyToId ? { replyToId } : {}),
          ...(opts.attachments ? { attachments: opts.attachments } : {}),
        });
      },
      typing: () => {
        conv.activities.push({ type: 'typing', id: this.nextId(conv), from: { id: 'bot' }, replyToId: message.id });
      },
      event: (name) => {
        conv.activities.push({ type: 'event', name, id: this.nextId(conv), from: { id: 'bot' }, replyToId: message.id } as FakeActivity);
      },
      endOfConversation: () => {
        conv.activities.push({ type: 'endOfConversation', id: this.nextId(conv), from: { id: 'bot' } });
      },
      callTool: async (name, args) => callMcpTool(this.mcpUrl!, this.mcpApiKey!, name, args),
    };
    try {
      await this.behavior(turn);
    } catch {
      /* behaviors may fail on purpose (e.g. calling a revoked tool) */
    }
  }
}

export async function callMcpTool(
  url: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ isError?: boolean; text: string; structured?: unknown }> {
  const client = new Client({ name: 'fake-studio', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'x-api-key': apiKey, ...headers } },
  });
  await client.connect(transport);
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
    };
    return {
      ...(result.isError ? { isError: true } : {}),
      text: (result.content ?? []).map((c) => c.text ?? '').join(''),
      ...(result.structuredContent ? { structured: result.structuredContent } : {}),
    };
  } finally {
    await client.close();
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
