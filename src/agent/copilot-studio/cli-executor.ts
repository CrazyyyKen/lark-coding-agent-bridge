import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';

/**
 * Runs lark-cli for the Copilot Studio MCP tool.
 *
 * Safety properties this module owns (the policy module owns "which args"):
 *  - the executable is resolved locally to a *native* binary, never a
 *    `.cmd`/`.bat`/`.ps1` shim: those run through cmd.exe/PowerShell, where
 *    argument quoting is not safe for model-provided strings;
 *  - `spawn(..., { shell: false })` from node:child_process directly — not
 *    cross-spawn, which rewrites shim invocations into `cmd.exe /c`;
 *  - a minimal allowlisted environment plus the profile's lark-channel
 *    projection (never the bridge's Direct Line / MCP secrets);
 *  - stdin closed (no interactive prompts), fixed cwd;
 *  - output caps enforced while reading, deadline, cancellation, and
 *    process-tree cleanup on every platform.
 */

export interface ResolvedLarkCli {
  /** Absolute path of the native executable that is spawned. */
  path: string;
  /** How it was found, for diagnostics. */
  via: 'configured' | 'path' | 'npm-shim';
}

export class LarkCliResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LarkCliResolveError';
  }
}

const SCRIPT_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1', '.vbs', '.js', '.mjs', '.cjs', '.sh']);

export async function resolveLarkCliExecutable(configured?: string): Promise<ResolvedLarkCli> {
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new LarkCliResolveError(`copilotStudio.cli.binaryPath must be an absolute path (got ${configured})`);
    }
    const native = await nativeFromCandidate(configured);
    if (!native) {
      throw new LarkCliResolveError(
        `copilotStudio.cli.binaryPath is not a native lark-cli executable: ${configured}`,
      );
    }
    return { path: native, via: native === configured ? 'configured' : 'npm-shim' };
  }

  for (const candidate of pathCandidates('lark-cli')) {
    if (!(await isFile(candidate))) continue;
    const native = await nativeFromCandidate(candidate);
    if (native) return { path: native, via: native === candidate ? 'path' : 'npm-shim' };
  }
  throw new LarkCliResolveError(
    'native lark-cli executable not found on PATH; install lark-cli or set copilotStudio.cli.binaryPath',
  );
}

/**
 * Map a candidate to a native binary: itself when it already is one, or the
 * binary an npm install of `@larksuite/cli` ships next to its launcher.
 */
async function nativeFromCandidate(candidate: string): Promise<string | undefined> {
  if (!(await isFile(candidate))) return undefined;
  const real = await realpath(candidate).catch(() => candidate);
  const ext = extname(real).toLowerCase();
  if (process.platform === 'win32') {
    if (ext === '.exe') return real;
    // npm global layout: <prefix>/lark-cli{,.cmd,.ps1} + <prefix>/node_modules/@larksuite/cli/bin/lark-cli.exe
    const shimDir = dirname(real);
    const viaNpm = join(shimDir, 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe');
    return (await isFile(viaNpm)) ? viaNpm : undefined;
  }
  if (SCRIPT_EXTENSIONS.has(ext) || (await looksLikeScript(real))) {
    // npm on POSIX symlinks <prefix>/bin/lark-cli -> ../lib/node_modules/@larksuite/cli/scripts/run.js
    if (basename(real) === 'run.js' && basename(dirname(real)) === 'scripts') {
      const viaNpm = join(dirname(dirname(real)), 'bin', 'lark-cli');
      return (await isExecutableFile(viaNpm)) ? viaNpm : undefined;
    }
    return undefined;
  }
  return (await isExecutableFile(real)) ? real : undefined;
}

function pathCandidates(command: string): string[] {
  const out: string[] = [];
  const exts =
    process.platform === 'win32'
      ? ['.exe', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()), '']
      : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of new Set(exts)) out.push(join(dir, `${command}${ext}`));
  }
  return out;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  if (!(await isFile(path))) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeScript(path: string): Promise<boolean> {
  try {
    const head = (await readFile(path)).subarray(0, 2).toString('latin1');
    return head === '#!';
  } catch {
    return false;
  }
}

/**
 * Environment variables lark-cli may inherit. Everything else — API keys of
 * unrelated tools, the bridge's own Direct Line / MCP secrets — stays out.
 */
const ENV_ALLOWLIST = [
  // Windows process basics + profile / credential store locations
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'OS',
  'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  // POSIX basics + keyring access
  'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  // locale / time
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  // proxies the bridge itself honours
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
];

export function buildLarkCliChildEnv(
  larkChannel: LarkChannelEnvContext | undefined,
  stripNames: readonly string[] = [],
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const strip = new Set(stripNames.map((n) => n.toUpperCase()));
  const allow = new Set(ENV_ALLOWLIST.map((n) => n.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (!allow.has(upper) || strip.has(upper)) continue;
    env[key] = value;
  }
  // The profile projection: LARK_CHANNEL*, LARKSUITE_CLI_CONFIG_DIR. Without
  // it lark-cli would silently fall back to the user's global credentials.
  return { ...env, ...buildLarkChannelEnv(larkChannel) };
}

export interface RunLarkCliInput {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Observes the live child (e.g. to register it for run cancellation). */
  onSpawn?: (child: ChildProcess) => void;
}

export interface RunLarkCliOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export function runLarkCli(input: RunLarkCliInput): Promise<RunLarkCliOutput> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      resolve({ exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: true });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(input.executable, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
        // Own process group on POSIX so the whole tree can be signalled.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    input.onSpawn?.(child);

    const out = new BoundedBuffer(input.maxOutputBytes);
    const err = new BoundedBuffer(input.maxOutputBytes);
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const stopChild = (): void => {
      killProcessTree(child);
    };
    const onData = (buffer: BoundedBuffer) => (chunk: Buffer) => {
      if (!buffer.push(chunk)) {
        if (!truncated) {
          truncated = true;
          stopChild();
        }
      }
    };
    child.stdout?.on('data', onData(out));
    child.stderr?.on('data', onData(err));

    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, input.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      stopChild();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        stdout: out.text(),
        stderr: err.text(),
        truncated,
        timedOut,
        cancelled,
      });
    };
    child.once('error', (spawnErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      reject(spawnErr);
    });
    child.once('close', (code) => finish(code));
  });
}

/** Kill a child and its descendants. Best effort; never throws. */
export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private full = false;

  constructor(private readonly max: number) {}

  /** Returns false once the cap was exceeded (the excess is dropped). */
  push(chunk: Buffer): boolean {
    if (this.full) return false;
    const room = this.max - this.size;
    if (chunk.length > room) {
      if (room > 0) this.chunks.push(chunk.subarray(0, room));
      this.size = this.max;
      this.full = true;
      return false;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    return true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
