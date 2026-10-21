import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  BRIDGE_SYSTEM_PROMPT,
  buildBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import {
  buildIdentitySettings,
  claudeAbsolutePath,
} from '../../../src/agent/claude/identity-settings';
import type { AgentLarkIdentity } from '../../../src/agent/types';

const USER: AgentLarkIdentity = {
  kind: 'user',
  openId: 'ou_alice0001',
  signedIn: true,
  larkCliConfigDir: '/home/bot/.lark-channel/profiles/team/users/ou_alice0001/lark-cli',
  blockedDirs: ['/home/bot/.lark-channel', '/home/bot/.claude/projects', '/home/bot/workspace/.lark-users/ou_bob000002'],
};

const SHARED: AgentLarkIdentity = { kind: 'shared-bot', blockedDirs: ['/home/bot/.claude/projects'] };

describe('Claude permission rules for a team-mode run', () => {
  it('writes absolute paths in Claude Code rule form', () => {
    expect(claudeAbsolutePath('/home/bot/workspace/')).toBe('//home/bot/workspace');
    expect(claudeAbsolutePath('C:\\Users\\bot\\.claude')).toBe('//c/Users/bot/.claude');
  });

  it("denies reading and editing every blocked folder", () => {
    const { deny } = buildIdentitySettings(USER).permissions;
    for (const dir of ['//home/bot/.lark-channel', '//home/bot/.claude/projects', '//home/bot/workspace/.lark-users/ou_bob000002']) {
      expect(deny).toContain(`Read(${dir}/**)`);
      expect(deny).toContain(`Edit(${dir}/**)`);
    }
  });

  it("keeps the shared workspace's allow and deny rules in force", () => {
    const settings = buildIdentitySettings({
      ...USER,
      inheritedRules: { allow: ['Bash(lark-cli:*)', 'Bash(date)'], deny: ['Read(~/.claude.json)'] },
    });
    expect(settings.permissions.allow).toEqual(['Bash(lark-cli:*)', 'Bash(date)']);
    expect(settings.permissions.deny).toContain('Read(~/.claude.json)');
    expect(settings.permissions.deny).toContain('Bash(lark-cli config:*)');
    expect(buildIdentitySettings(SHARED).permissions.allow).toBeUndefined();
  });

  it('denies signing in, switching identity policy and redirecting the login folder', () => {
    const { deny } = buildIdentitySettings(SHARED).permissions;
    expect(deny).toEqual(
      expect.arrayContaining([
        'Bash(lark-cli auth login:*)',
        'Bash(lark-cli auth logout:*)',
        'Bash(lark-cli config:*)',
        'Bash(lark-cli --profile:*)',
        'Bash(env:*)',
        'Bash(export:*)',
      ]),
    );
  });
});

describe('team-mode system prompt', () => {
  it('leaves the personal-mode prompt unchanged', () => {
    expect(buildBridgeSystemPrompt(undefined)).toBe(BRIDGE_SYSTEM_PROMPT);
    expect(BRIDGE_SYSTEM_PROMPT).toContain('lark-cli auth login --no-wait --json');
  });

  it('replaces the agent-driven OAuth flow with bridge-owned sign-in rules', () => {
    for (const identity of [USER, SHARED, { ...USER, signedIn: false }]) {
      const prompt = buildBridgeSystemPrompt(undefined, identity);
      expect(prompt).not.toContain('lark-cli auth login --no-wait --json');
      expect(prompt).not.toContain('lark-cli config default-as auto');
      expect(prompt).toContain('团队版：飞书身份与授权');
      expect(prompt).toContain('等用户在下一条消息里明确确认');
    }
  });

  it('tells the agent which identity this run has', () => {
    expect(buildBridgeSystemPrompt(undefined, USER)).toContain('`--as user`');
    expect(buildBridgeSystemPrompt(undefined, { ...USER, signedIn: false })).toContain('发送 `/login`');
    expect(buildBridgeSystemPrompt(undefined, SHARED)).toContain('**只能用 bot 身份**');
  });

  it('still appends the bot self-identity line', () => {
    expect(buildBridgeSystemPrompt({ openId: 'ou_bot', name: 'Team' }, SHARED)).toContain('`ou_bot`');
  });
});

describe('ClaudeAdapter with a team-mode identity', () => {
  beforeEach(() => {
    spawnMock.spawnProcess.mockReset();
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
  });

  it("passes the block list via --settings and points lark-cli at the person's folder", () => {
    const adapter = new ClaudeAdapter({
      larkChannel: { profile: 'team', rootDir: '/home/bot/.lark-channel', larkCliConfigDir: '/shared/lark-cli' },
    });
    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp', larkIdentity: USER });

    const [, args, options] = spawnMock.spawnProcess.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    const flag = args.indexOf('--settings');
    expect(flag).toBeGreaterThan(-1);
    const settings = JSON.parse(readFileSync(args[flag + 1] as string, 'utf8'));
    expect(settings).toEqual(buildIdentitySettings(USER));
    expect(options.env.LARKSUITE_CLI_CONFIG_DIR).toBe(USER.larkCliConfigDir);
    expect(options.env.LARK_CHANNEL_PROFILE).toBe('team');
  });

  it('keeps the profile login folder for a shared-bot run', () => {
    const adapter = new ClaudeAdapter({ larkChannel: { profile: 'team', larkCliConfigDir: '/shared/lark-cli' } });
    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp', larkIdentity: SHARED });
    const [, args, options] = spawnMock.spawnProcess.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args).toContain('--settings');
    expect(options.env.LARKSUITE_CLI_CONFIG_DIR).toBe('/shared/lark-cli');
  });

  it('adds no settings file to personal-mode runs', () => {
    const adapter = new ClaudeAdapter({ larkChannel: { profile: 'me', larkCliConfigDir: '/me/lark-cli' } });
    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    const [, args] = spawnMock.spawnProcess.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--settings');
  });
});

function fakeChild(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}
