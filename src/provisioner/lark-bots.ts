import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BotGetResult } from './knowledge';

/** Exit codes of `lark-bots.sh add` (deploy/docker/lark-bots.sh, --json). */
export const EXIT = { ok: 0, failed: 1, args: 2, inUse: 3, larkApp: 4 } as const;

export interface AddResult {
  ok: boolean;
  code: number;
  /** Parsed last JSON line, when the script got as far as printing one. */
  result?: {
    ok: boolean;
    bot?: string;
    claude?: 'ok' | 'failed' | 'missing';
    step?: string;
    error?: string;
  };
  /** Tail of the combined output, for the Provision log field. */
  output: string;
}

export interface RunResult {
  code: number;
  output: string;
}

export type Runner = (args: string[], stdin?: string) => Promise<RunResult>;

const OUTPUT_TAIL = 4000;
// add builds nothing but runs a few containers and waits for the bot to start.
const TIMEOUT_MS = 10 * 60_000;

/** Runs lark-bots.sh with an argument list (never a shell string) and optional stdin. */
export function scriptRunner(script: string): Runner {
  return (args, stdin) =>
    new Promise((resolve) => {
      // From the script's folder: docker compose needs a working directory it can read,
      // and the provisioner image's default one belongs to another user.
      const child = spawn('bash', [script, ...args], { cwd: dirname(script), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const collect = (d: Buffer) => {
        output = (output + d.toString('utf8')).slice(-64_000);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: 1, output: `${output}\n${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, output });
      });
      child.stdin.end(stdin ?? '');
    });
}

function lastJson(output: string): AddResult['result'] {
  const lines = output.split(/\r?\n/).filter((l) => l.startsWith('{'));
  const line = lines[lines.length - 1];
  if (!line) return undefined;
  try {
    return JSON.parse(line) as AddResult['result'];
  } catch {
    return undefined;
  }
}

// Colour codes from step()/warn() make the log field unreadable in Base.
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

const lastLineOf = (s: string) => s.trim().split(/\r?\n/).pop() ?? '';

export class LarkBots {
  constructor(
    private readonly run: Runner,
    private readonly dir: string,
  ) {}

  async add(opts: {
    name: string;
    appId: string;
    appSecret: string;
    mode: 'personal' | 'team';
    tenant: string;
    claudeAccount?: string;
  }): Promise<AddResult> {
    const args = ['add', opts.name, '--app-id', opts.appId, '--mode', opts.mode, '--tenant', opts.tenant];
    if (opts.claudeAccount) args.push('--claude-account', opts.claudeAccount);
    args.push('--app-secret-stdin', '--yes', '--json');
    const { code, output } = await this.run(args, `${opts.appSecret}\n`);
    return { ok: code === EXIT.ok, code, result: lastJson(output), output: stripAnsi(output).slice(-OUTPUT_TAIL) };
  }

  /** Save an API key as a Claude account (lark-bots.sh claude-account set --api-key --stdin). */
  async setApiKey(account: string, key: string): Promise<RunResult> {
    const r = await this.run(['claude-account', 'set', account, '--api-key', '--stdin', '--restart'], `${key}\n`);
    return { code: r.code, output: stripAnsi(r.output).slice(-OUTPUT_TAIL) };
  }

  /** Save a seat's subscription token and restart the bots on it. */
  async setToken(account: string, token: string): Promise<RunResult> {
    const r = await this.run(['claude-account', 'set', account, '--stdin', '--restart'], `${token}\n`);
    return { code: r.code, output: stripAnsi(r.output).slice(-OUTPUT_TAIL) };
  }

  /** One-word question with the account's credential (claude-account check). */
  async checkAccount(account: string): Promise<RunResult> {
    const r = await this.run(['claude-account', 'check', account]);
    return { code: r.code, output: stripAnsi(r.output).slice(-OUTPUT_TAIL) };
  }

  /** A text DM from the bot itself, by email (lark-bots.sh bot-message). */
  async sendMessage(name: string, email: string, text: string): Promise<RunResult> {
    const r = await this.run(['bot-message', name, email], text);
    return { code: r.code, output: stripAnsi(r.output).slice(-OUTPUT_TAIL) };
  }

  /** Writes the bot's CLAUDE.md unless it already has one. */
  async setInstructions(name: string, text: string): Promise<RunResult> {
    const r = await this.run(['set-instructions', name], text);
    return { code: r.code, output: stripAnsi(r.output).slice(-OUTPUT_TAIL) };
  }

  /** Read-only API call as the bot (lark-bots.sh bot-get); ok=false on any API or script error. */
  async botGet(name: string, path: string, params?: Record<string, string | number>): Promise<BotGetResult> {
    const args = ['bot-get', name, path];
    if (params) args.push(JSON.stringify(params));
    const r = await this.run(args);
    const start = r.output.indexOf('{');
    try {
      const j = JSON.parse(start >= 0 ? r.output.slice(start) : '') as { ok?: boolean; data?: unknown; error?: { message?: string } };
      return { ok: r.code === 0 && j.ok === true, data: j.data, error: j.error?.message };
    } catch {
      return { ok: false, error: lastLineOf(stripAnsi(r.output)) };
    }
  }

  /** Bot names in use on the server (bots/<name>.env). */
  async botNames(): Promise<Set<string>> {
    const names = new Set<string>();
    for (const f of await readdir(join(this.dir, 'bots')).catch(() => [] as string[])) {
      if (f.endsWith('.env') && !f.endsWith('.claude.env')) names.add(f.slice(0, -'.env'.length));
    }
    return names;
  }

  /** The bot already running this Lark app, if any (APP_ID recorded by add). */
  async botForApp(appId: string): Promise<string | undefined> {
    for (const name of await this.botNames()) {
      const env = await readFile(join(this.dir, 'bots', `${name}.env`), 'utf8').catch(() => '');
      if (env.split(/\r?\n/).includes(`APP_ID=${appId}`)) return name;
    }
    return undefined;
  }

  /** Whether a Claude account's credential is saved on the server. */
  async hasAccount(account: string): Promise<boolean> {
    const files = await readdir(join(this.dir, 'claude-accounts')).catch(() => [] as string[]);
    return files.includes(`${account}.env`);
  }
}
