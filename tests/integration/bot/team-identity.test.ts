import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { claudeCapability } from '../../../src/agent/capability';
import type { AgentLarkIdentity } from '../../../src/agent/types';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { startRunFlow } from '../../../src/bot/run-flow';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';
import { PerUserLogins } from '../../../src/lark-cli/per-user-login';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('team identity in the run flow', () => {
  it("runs a member's DM in their own folder with their identity, ignoring /cd", async () => {
    const root = await makeRoot();
    const shared = join(root, 'shared');
    const own = join(root, 'shared', '.lark-users', 'ou_alice0001');
    await mkdir(own, { recursive: true });
    const agent = new FakeAgentAdapter({ events: [{ type: 'done', terminationReason: 'normal' }] });
    const executor = new RunExecutor({
      agent,
      pool: new ProcessPool(() => 1),
      activeRuns: new ActiveRuns(),
      createRunId: () => 'run-1',
      now: () => 1000,
    });
    const profileConfig = teamProfile(shared);
    const workspaces = new WorkspaceStore(join(root, 'workspaces.json'));
    // An admin once pointed this chat elsewhere; a member's DM still runs in their own folder.
    workspaces.setCwd('chat-1', shared);
    const identity: AgentLarkIdentity = {
      kind: 'user',
      openId: 'ou_alice0001',
      signedIn: true,
      larkCliConfigDir: '/x/users/ou_alice0001/lark-cli',
      blockedDirs: ['/x'],
    };

    const flow = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_alice0001' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-team' },
      capability: claudeCapability(profileConfig),
      profileConfig,
      sessions: new SessionStore(join(root, 'sessions.json')),
      workspaces,
      executor,
      now: 1000,
      larkIdentity: identity,
      cwdOverride: own,
    });

    expect(flow.ok).toBe(true);
    expect(agent.runOptions[0]?.cwd).toBe(await realpath(own));
    expect(agent.runOptions[0]?.larkIdentity).toEqual(identity);
    await workspaces.flush();
  });
});

describe('team sign-in commands', () => {
  it('explains that personal sign-in is off when the bot has no per-person logins', async () => {
    const h = await harness({ logins: false });
    await tryHandleCommand(h.ctx('ou_alice0001', '/login'));
    expect(lastMarkdown(h.channel)).toMatch(/isn't turned on/);
  });

  it('refuses to send a sign-in link in a group chat', async () => {
    const h = await harness({ logins: true });
    await tryHandleCommand(h.ctx('ou_alice0001', '/login', 'group'));
    expect(lastMarkdown(h.channel)).toMatch(/private chat/);
  });

  it('reports a member who has not signed in, with a Sign in button', async () => {
    const h = await harness({ logins: true });
    await tryHandleCommand(h.ctx('ou_alice0001', '/whoami'));
    const card = JSON.stringify((h.channel.sent.at(-1)?.content as { card?: unknown }).card);
    expect(card).toContain('Not signed in');
    expect(card).toContain('"value":{"cmd":"login"}');
  });

  it("keeps a team bot's shared session list away from non-admins", async () => {
    const h = await harness({ logins: false });
    await tryHandleCommand(h.ctx('ou_member01', '/resume'));
    expect(lastMarkdown(h.channel)).toContain('admins only');
  });
});

async function harness(opts: { logins: boolean }) {
  const root = await makeRoot();
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(root, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(root, 'workspaces.json'));
  const profileConfig = teamProfile(workspace);
  const controls: Controls = {
    profile: 'team',
    profileConfig,
    botOwnerId: 'ou_owner0001',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    configPath: join(root, 'config.json'),
    cfg: profileConfig,
    processId: 'self',
    async restart() {},
    async exit() {},
    teamLogin: {
      shared: { kind: 'shared-bot', blockedDirs: [] },
      ...(opts.logins
        ? {
            logins: new PerUserLogins({
              profile: 'team',
              rootDir: join(root, 'home'),
              profileDir: join(root, 'home', 'profiles', 'team'),
              workspaceRoot: workspace,
              team: profileConfig.team,
              // No login folder exists yet, so status never calls lark-cli.
              exec: async () => ({ code: 1, stdout: '', stderr: 'unexpected', timedOut: false }),
            }),
          }
        : {}),
    },
  };
  const ctx = (senderId: string, content: string, chatType: 'p2p' | 'group' = 'p2p'): CommandContext => ({
    channel: channel as unknown as CommandContext['channel'],
    msg: {
      messageId: 'om-1',
      chatId: 'chat-1',
      chatType,
      senderId,
      senderName: 'User',
      content,
      resources: [],
      mentionedBot: true,
    } as unknown as NormalizedMessage,
    scope: 'chat-1',
    chatMode: chatType,
    sessions,
    workspaces,
    agent: new FakeAgentAdapter({ events: [] }),
    activeRuns: new ActiveRuns(),
    controls,
  });
  return { channel, ctx };
}

function teamProfile(workspace: string): ProfileConfig {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    mode: 'team',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'lark' } },
  });
  cfg.workspaces.default = workspace;
  cfg.team = { perUserLogin: true, loginDomains: ['all'], loginExclude: [] };
  return cfg;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-team-identity-'));
  roots.push(root);
  return root;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  return content?.markdown ?? '';
}
