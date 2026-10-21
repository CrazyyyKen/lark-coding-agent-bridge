import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PerUserLogins,
  isValidOpenId,
  sharedBotIdentity,
} from '../../../src/lark-cli/per-user-login';
import type { LarkCliExec } from '../../../src/lark-cli/user-im';

const ALICE = 'ou_alice0001';
const BOB = 'ou_bob000002';

interface SignedIn {
  openId: string;
  userName: string;
}

/**
 * A fake lark-cli keyed by LARKSUITE_CLI_CONFIG_DIR: each login folder holds
 * at most one signed-in user, like the real one. `approver` decides which
 * Lark account approves a device-flow link opened for a given folder.
 */
function fakeLarkCli() {
  const signedIn = new Map<string, SignedIn>();
  const calls: Array<{ args: string[]; dir: string | undefined }> = [];
  const state = {
    approver: (_dir: string): SignedIn => ({ openId: ALICE, userName: 'Alice' }),
  };
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
  const exec: LarkCliExec = vi.fn(async (args, env) => {
    const dir = env.LARKSUITE_CLI_CONFIG_DIR;
    calls.push({ args, dir });
    if (!dir) return { code: 1, stdout: '', stderr: 'no config dir', timedOut: false };
    if (args[0] === 'config' && args[1] === 'bind') {
      mkdirSync(join(dir, 'lark-channel'), { recursive: true });
      writeFileSync(join(dir, 'lark-channel', 'config.json'), '{"apps":[]}');
      return ok();
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      const user = signedIn.get(dir);
      return ok(
        JSON.stringify({
          identities: {
            user: user
              ? { available: true, tokenStatus: 'valid', userName: user.userName, openId: user.openId, scope: 'a b c' }
              : { available: false },
          },
        }),
      );
    }
    if (args[0] === 'auth' && args[1] === 'login' && args.includes('--no-wait')) {
      return ok(
        JSON.stringify({ verification_url: 'https://lark.example/verify?c=1', device_code: 'dev-1', expires_in: 600 }),
      );
    }
    if (args[0] === 'auth' && args[1] === 'login' && args.includes('--device-code')) {
      signedIn.set(dir, state.approver(dir));
      return ok('{}');
    }
    if (args[0] === 'auth' && args[1] === 'logout') {
      signedIn.delete(dir);
      return ok();
    }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}`, timedOut: false };
  });
  return { exec, calls, signedIn, state };
}

let tmp: string;
let paths: {
  rootDir: string;
  profileDir: string;
  workspaceRoot: string;
  claudeProjectsDir: string;
  larkCliDataDir: string;
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'per-user-login-'));
  const rootDir = join(tmp, 'lark-home');
  paths = {
    rootDir,
    profileDir: join(rootDir, 'profiles', 'team'),
    workspaceRoot: join(tmp, 'workspace'),
    claudeProjectsDir: join(tmp, 'claude', 'projects'),
    larkCliDataDir: join(tmp, 'local', 'share', 'lark-cli'),
  };
  mkdirSync(paths.workspaceRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function logins(exec: LarkCliExec): PerUserLogins {
  return new PerUserLogins({
    profile: 'team',
    ...paths,
    team: { perUserLogin: true, loginDomains: ['all'], loginExclude: [] },
    exec,
  });
}

describe('per-user login folders', () => {
  it('only accepts real open_ids, so a sender id can never escape its folder', () => {
    expect(isValidOpenId(ALICE)).toBe(true);
    expect(isValidOpenId('../ou_x')).toBe(false);
    expect(isValidOpenId('ou_a/../../etc')).toBe(false);
    expect(() => logins(fakeLarkCli().exec).folders('../../etc')).toThrow(/invalid open_id/);
  });

  it("gives a DM run the sender's own login folder and working folder", async () => {
    const cli = fakeLarkCli();
    const run = await logins(cli.exec).runFor(ALICE);

    expect(run.identity).toMatchObject({ kind: 'user', openId: ALICE, signedIn: false });
    expect(run.identity.larkCliConfigDir).toBe(join(paths.profileDir, 'users', ALICE, 'lark-cli'));
    expect(run.cwd).toBe(join(paths.workspaceRoot, '.lark-users', ALICE));
    expect(run.attachmentsDir).toBe(join(run.cwd, '.attachments'));
    // Bound once to the app with user identity allowed, in Alice's folder only.
    const binds = cli.calls.filter((c) => c.args[0] === 'config');
    expect(binds).toEqual([
      {
        args: ['config', 'bind', '--source', 'lark-channel', '--identity', 'user-default'],
        dir: run.identity.larkCliConfigDir,
      },
    ]);
  });

  it('binds a login folder only once', async () => {
    const cli = fakeLarkCli();
    const l = logins(cli.exec);
    await l.runFor(ALICE);
    await l.runFor(ALICE);
    expect(cli.calls.filter((c) => c.args[0] === 'config')).toHaveLength(1);
  });

  it("blocks a person's run from the bridge home, lark-cli's credential store, every session history and other people's folders", async () => {
    const l = logins(fakeLarkCli().exec);
    const bob = await l.runFor(BOB);
    const alice = await l.runFor(ALICE);

    expect(alice.identity.blockedDirs).toEqual(
      expect.arrayContaining([paths.rootDir, paths.larkCliDataDir, paths.claudeProjectsDir, bob.cwd]),
    );
    expect(alice.identity.blockedDirs).not.toContain(alice.cwd);
    expect(bob.identity.blockedDirs).not.toContain(alice.cwd); // Bob's run predates Alice's folder
  });

  it('never blocks a folder that contains the person\'s own working folder', async () => {
    const l = new PerUserLogins({
      profile: 'team',
      ...paths,
      // A workspace configured inside the bridge home must stay usable.
      workspaceRoot: join(paths.rootDir, 'workspace'),
      team: { perUserLogin: true, loginDomains: ['all'], loginExclude: [] },
      exec: fakeLarkCli().exec,
    });
    const run = await l.runFor(ALICE);
    expect(run.identity.blockedDirs).not.toContain(paths.rootDir);
    expect(run.identity.blockedDirs).toContain(paths.claudeProjectsDir);
  });

  it("carries the shared workspace's permission rules into the run, since a new folder isn't trusted", async () => {
    mkdirSync(join(paths.workspaceRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(paths.workspaceRoot, '.claude', 'settings.json'),
      '{"permissions":{"allow":["Bash(lark-cli:*)"],"deny":["Read(~/.claude.json)"]}}',
    );
    const run = await logins(fakeLarkCli().exec).runFor(ALICE);
    expect(run.identity.inheritedRules).toEqual({
      allow: ['Bash(lark-cli:*)'],
      deny: ['Read(~/.claude.json)'],
    });
  });
});

describe('per-user sign-in', () => {
  it('welcomes a new DM once with a sign-in link asking for every enabled permission', async () => {
    const cli = fakeLarkCli();
    const notify = vi.fn(async (_markdown: string) => {});
    const l = logins(cli.exec);

    await l.welcomeIfNew(ALICE, notify);
    await l.welcomeIfNew(ALICE, notify);
    // A restart doesn't welcome again either.
    await logins(cli.exec).welcomeIfNew(ALICE, notify);

    const welcome = notify.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m) => m.includes('https://lark.example/verify?c=1'));
    expect(welcome).toHaveLength(1);
    const start = cli.calls.find((c) => c.args.includes('--no-wait'));
    expect(start?.args).toEqual(['auth', 'login', '--no-wait', '--json', '--domain', 'all']);
  });

  it("signs the person in when they approve with their own account", async () => {
    const cli = fakeLarkCli();
    const notify = vi.fn(async (_markdown: string) => {});
    const l = logins(cli.exec);

    await l.startLogin(ALICE, notify);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    expect(String(notify.mock.calls[0]?.[0])).toMatch(/Signed in as \*\*Alice\*\*/);
    expect((await l.status(ALICE, true)).loggedIn).toBe(true);
  });

  it('discards a sign-in approved by a different Lark account', async () => {
    const cli = fakeLarkCli();
    // Alice forwarded her link and Bob opened it.
    cli.state.approver = () => ({ openId: BOB, userName: 'Bob' });
    const notify = vi.fn(async (_markdown: string) => {});
    const l = logins(cli.exec);

    await l.startLogin(ALICE, notify);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());

    expect(String(notify.mock.calls[0]?.[0])).toMatch(/different Lark account/);
    expect(cli.calls.some((c) => c.args[0] === 'auth' && c.args[1] === 'logout')).toBe(true);
    expect((await l.status(ALICE, true)).loggedIn).toBe(false);
  });

  it("never treats another account's token in a person's folder as their sign-in", async () => {
    const cli = fakeLarkCli();
    const l = logins(cli.exec);
    const folders = await l.prepare(ALICE);
    cli.signedIn.set(folders.larkCliConfigDir, { openId: BOB, userName: 'Bob' });

    expect((await l.status(ALICE, true)).loggedIn).toBe(false);
  });

  it('reuses a pending link instead of starting a new sign-in each time', async () => {
    const cli = fakeLarkCli();
    // Keep the device-code wait pending so the first link stays live.
    const exec: LarkCliExec = vi.fn<LarkCliExec>((args, env, timeout) =>
      args.includes('--device-code') ? new Promise(() => {}) : cli.exec(args, env, timeout),
    );
    const l = logins(exec);
    const first = await l.startLogin(ALICE, async () => {});
    const second = await l.startLogin(ALICE, async () => {});
    expect(second.deviceCode).toBe(first.deviceCode);
    expect(cli.calls.filter((c) => c.args.includes('--no-wait'))).toHaveLength(1);
  });

  it("logs a person out of their own folder only", async () => {
    const cli = fakeLarkCli();
    const l = logins(cli.exec);
    const alice = await l.prepare(ALICE);
    const bob = await l.prepare(BOB);
    cli.signedIn.set(alice.larkCliConfigDir, { openId: ALICE, userName: 'Alice' });
    cli.signedIn.set(bob.larkCliConfigDir, { openId: BOB, userName: 'Bob' });

    expect((await l.logout(ALICE)).ok).toBe(true);
    expect(cli.signedIn.has(alice.larkCliConfigDir)).toBe(false);
    expect(cli.signedIn.has(bob.larkCliConfigDir)).toBe(true);
  });
});

describe('shared bot identity', () => {
  it('blocks group, comment and meeting runs from personal folders, session histories and logs', () => {
    const identity = sharedBotIdentity(paths);
    expect(identity.kind).toBe('shared-bot');
    expect(identity.larkCliConfigDir).toBeUndefined();
    expect(identity.blockedDirs).toEqual(
      expect.arrayContaining([
        join(paths.profileDir, 'users'),
        join(paths.profileDir, 'logs'),
        join(paths.rootDir, 'logs'),
        paths.claudeProjectsDir,
        paths.larkCliDataDir,
        join(paths.workspaceRoot, '.lark-users'),
      ]),
    );
  });
});
