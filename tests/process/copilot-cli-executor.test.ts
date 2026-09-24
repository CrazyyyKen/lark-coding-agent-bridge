import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLarkCliChildEnv,
  resolveLarkCliExecutable,
  runLarkCli,
} from '../../src/agent/copilot-studio/cli-executor.js';

// node itself is the stand-in "native executable": a real binary on every
// platform, so Windows argument quoting is exercised for real (no cmd.exe).
const NODE = process.execPath;

let dir: string;
let script: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'copilot-cli-'));
  script = join(dir, 'echo.js');
  await writeFile(
    script,
    [
      "const mode = process.argv[2];",
      "if (mode === 'argv') { process.stdout.write(JSON.stringify(process.argv.slice(3))); }",
      "else if (mode === 'env') { process.stdout.write(JSON.stringify(process.env)); }",
      "else if (mode === 'fail') { process.stderr.write('boom'); process.exit(3); }",
      "else if (mode === 'flood') { process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000); }",
      "else if (mode === 'hang') { setInterval(() => {}, 1000); }",
      "else if (mode === 'stdin') { process.stdin.on('data', () => {}); process.stdin.on('end', () => process.stdout.write('eof')); }",
    ].join('\n'),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function run(args: string[], extra: Partial<Parameters<typeof runLarkCli>[0]> = {}) {
  return runLarkCli({
    executable: NODE,
    args: [script, ...args],
    env: buildLarkCliChildEnv(undefined),
    cwd: dir,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    ...extra,
  });
}

describe('copilot studio lark-cli executor (process)', () => {
  it('passes metacharacters and Unicode through as literal argv entries', async () => {
    const tricky = [
      'a & b | c; rm -rf / > out.txt',
      '$(whoami) `id` %PATH% !VAR!',
      'quote " inside',
      'trailing backslash \\',
      '\\\\server\\share "x"',
      '中文 🚀 ümlaut',
      '--flag=value with spaces',
      '',
    ];
    const out = await run(['argv', ...tricky]);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(tricky);
    // Nothing was interpreted by a shell.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dir, 'out.txt'))).toBe(false);
  });

  it('reports nonzero exits with stderr', async () => {
    const out = await run(['fail']);
    expect(out).toMatchObject({ exitCode: 3, stderr: 'boom', timedOut: false, truncated: false });
  });

  it('caps output while reading and stops the process', async () => {
    const out = await run(['flood'], { maxOutputBytes: 4096 });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(4096);
  });

  it('enforces the deadline and kills the process tree', async () => {
    const started = Date.now();
    const out = await run(['hang'], { timeoutMs: 500 });
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('cancels through the abort signal', async () => {
    const abort = new AbortController();
    const pending = run(['hang'], { signal: abort.signal });
    setTimeout(() => abort.abort(), 200);
    const out = await pending;
    expect(out.cancelled).toBe(true);
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(run(['argv'], { signal: preAborted.signal })).resolves.toMatchObject({ cancelled: true });
  });

  it('closes stdin so nothing can wait for interactive input', async () => {
    const out = await run(['stdin'], { timeoutMs: 5000 });
    expect(out.stdout).toBe('eof');
    expect(out.timedOut).toBe(false);
  });

  it('passes only allowlisted env plus the profile projection, never bridge secrets', async () => {
    const env = buildLarkCliChildEnv(
      {
        profile: 'copilot',
        rootDir: join(dir, 'root'),
        larkCliConfigDir: join(dir, 'root', 'lark-cli'),
      },
      ['COPILOT_DL_SECRET'],
      {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: '/home/x',
        COPILOT_DL_SECRET: 'dl-secret',
        OPENAI_API_KEY: 'sk-unrelated',
        LARKSUITE_CLI_CONFIG_DIR: '/global/should/be/overridden',
      },
    );
    const out = await runLarkCli({
      executable: NODE,
      args: [script, 'env'],
      env,
      cwd: dir,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
    });
    const childEnv = JSON.parse(out.stdout) as Record<string, string>;
    const keys = Object.keys(childEnv).map((k) => k.toUpperCase());
    expect(keys).not.toContain('COPILOT_DL_SECRET');
    expect(keys).not.toContain('OPENAI_API_KEY');
    expect(childEnv.LARK_CHANNEL).toBe('1');
    expect(childEnv.LARK_CHANNEL_PROFILE).toBe('copilot');
    expect(childEnv.LARKSUITE_CLI_CONFIG_DIR).toBe(join(dir, 'root', 'lark-cli'));
  });
});

describe('lark-cli executable resolution', () => {
  it('rejects relative configured paths and script shims', async () => {
    await expect(resolveLarkCliExecutable('lark-cli')).rejects.toThrow(/absolute/);
    const shim = join(dir, process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli.sh');
    await writeFile(shim, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
    await expect(resolveLarkCliExecutable(shim)).rejects.toThrow(/not a native/);
  });

  it('maps an npm launcher to the native binary it ships', async () => {
    if (process.platform === 'win32') {
      const prefix = join(dir, 'npm');
      const bin = join(prefix, 'node_modules', '@larksuite', 'cli', 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(prefix, 'lark-cli.cmd'), '@echo off\r\n');
      await writeFile(join(bin, 'lark-cli.exe'), 'MZ');
      await expect(resolveLarkCliExecutable(join(prefix, 'lark-cli.cmd'))).resolves.toEqual({
        path: join(bin, 'lark-cli.exe'),
        via: 'npm-shim',
      });
    } else {
      const pkg = join(dir, 'lib', 'node_modules', '@larksuite', 'cli');
      await mkdir(join(pkg, 'scripts'), { recursive: true });
      await mkdir(join(pkg, 'bin'), { recursive: true });
      await writeFile(join(pkg, 'scripts', 'run.js'), '#!/usr/bin/env node\n');
      await writeFile(join(pkg, 'bin', 'lark-cli'), '\x7fELF');
      await chmod(join(pkg, 'bin', 'lark-cli'), 0o755);
      await mkdir(join(dir, 'bin'), { recursive: true });
      await symlink(join(pkg, 'scripts', 'run.js'), join(dir, 'bin', 'lark-cli'));
      const resolved = await resolveLarkCliExecutable(join(dir, 'bin', 'lark-cli'));
      expect(resolved.via).toBe('npm-shim');
      expect(resolved.path.endsWith(join('bin', 'lark-cli'))).toBe(true);
    }
  });

  it('accepts a configured native executable as-is', async () => {
    await expect(resolveLarkCliExecutable(NODE)).resolves.toMatchObject({ via: 'configured' });
  });
});
