import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CopilotStudioAdapter } from '../../../../src/agent/copilot-studio/adapter.js';
import { createCliPolicy } from '../../../../src/agent/copilot-studio/cli-policy.js';
import { acquireCopilotStudioServices } from '../../../../src/agent/copilot-studio/services.js';
import { supportedModels } from '../../../../src/agent/models.js';
import { recordRunSessionEvent } from '../../../../src/bot/run-flow.js';
import { copilotStudioCapability } from '../../../../src/agent/capability.js';
import { createDefaultProfileConfig } from '../../../../src/config/profile-schema.js';
import { createRuntimeAgent } from '../../../../src/runtime/agent-runtime.js';
import { SessionCatalog } from '../../../../src/session/catalog.js';
import { SessionStore } from '../../../../src/session/store.js';
import { parseOnboardAgentKind } from '../../../../src/ui/onboard.js';
import type { RunPolicyAllow } from '../../../../src/policy/run-policy.js';

const account = { app: { id: 'cli_test', secret: 's', tenant: 'lark' as const } };

describe('copilot-studio runtime wiring', () => {
  it('createRuntimeAgent builds a CopilotStudioAdapter, not a Claude fallback', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({ agentKind: 'copilot-studio', accounts: account }),
      {
        profileDir: tmpdir(),
        profile: 'copilot',
        rootDir: tmpdir(),
        secretsFile: join(tmpdir(), 'secrets.enc'),
        keystoreSaltFile: join(tmpdir(), '.salt'),
      },
    );
    expect(agent).toBeInstanceOf(CopilotStudioAdapter);
    expect(agent.id).toBe('copilot-studio');
    expect(agent.displayName).toBe('Copilot Studio');
  });

  it('reports missing secrets as a remote diagnostic, not a missing binary', async () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({ agentKind: 'copilot-studio', accounts: account }),
      {
        profileDir: tmpdir(),
        profile: 'copilot',
        secretsFile: join(tmpdir(), 'nope.enc'),
        keystoreSaltFile: join(tmpdir(), 'nope.salt'),
      },
    );
    const availability = await agent.checkAvailability!();
    expect(availability).toMatchObject({
      ok: false,
      diagnostic: { code: 'agent-remote-secret-unavailable', agentId: 'copilot-studio' },
    });
  });

  it('offers no bridge-side model choice for Copilot Studio', () => {
    expect(supportedModels('copilot-studio').map((m) => m.value)).toEqual(['default']);
  });

  it('records the Direct Line conversation id in the session catalog as a thread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copilot-catalog-'));
    try {
      const catalog = new SessionCatalog(join(dir, 'sessions.json.catalog.json'));
      const sessions = new SessionStore(join(dir, 'sessions.json'));
      const policy = { cwdRealpath: '/w', policyFingerprint: 'fp' } as RunPolicyAllow;
      recordRunSessionEvent({
        scopeId: 'oc_dm',
        sessions,
        sessionCatalog: catalog,
        capability: copilotStudioCapability(),
        policy,
        event: { type: 'system', threadId: 'conv-1' },
      });
      expect(
        catalog.activeFor({ scopeId: 'oc_dm', agentId: 'copilot-studio', cwdRealpath: '/w', policyFingerprint: 'fp' }),
      ).toMatchObject({ threadId: 'conv-1' });
      expect(sessions.getRaw('oc_dm')).toBeUndefined();
      await catalog.flush();
      const reloaded = new SessionCatalog(join(dir, 'sessions.json.catalog.json'));
      await reloaded.load();
      expect(reloaded.entries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('web onboarding never maps an unknown agent kind to Claude', () => {
    expect(parseOnboardAgentKind(undefined)).toBe('claude');
    expect(parseOnboardAgentKind('codex')).toBe('codex');
    expect(parseOnboardAgentKind('copilot-studio')).toBe('copilot-studio');
    expect(() => parseOnboardAgentKind('copilot')).toThrow(/不支持的 agent 类型/);
  });

  it('shares one MCP listener per profile across adapter instances (restart hand-over)', async () => {
    const settings = {
      bindHost: '127.0.0.1',
      port: 0,
      path: '/mcp',
      authHeader: 'x-api-key',
      allowedOrigins: [],
      apiKey: 'k'.repeat(32),
      policy: createCliPolicy(undefined).policy,
      version: 'test',
      runCli: async () => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: false }),
    };
    const a = await acquireCopilotStudioServices('profile-x', settings);
    const b = await acquireCopilotStudioServices('profile-x', settings);
    expect(b.services).toBe(a.services);
    const url = a.services.mcpUrl!;
    const health = new URL('/healthz', url);
    await a.release();
    expect((await fetch(health)).status).toBe(200);
    await b.release();
    await expect(fetch(health)).rejects.toThrow();
  });
});
