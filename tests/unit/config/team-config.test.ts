import { describe, expect, it } from 'vitest';
import { claudeCapability } from '../../../src/agent/capability';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
  perUserLoginEnabled,
  type ProfileConfig,
} from '../../../src/config/profile-schema';
import { evaluateRunPolicy } from '../../../src/policy/run-policy';

function profile(overrides: Record<string, unknown> = {}): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'lark' } },
    ...overrides,
  });
}

describe('team config', () => {
  it('defaults to per-person sign-in off, asking for every permission when on', () => {
    expect(profile().team).toEqual({ perUserLogin: false, loginDomains: ['all'], loginExclude: [] });
    expect(
      profile({ team: { perUserLogin: true, loginDomains: ['calendar', 'docs'], loginExclude: ['mail:x'] } }).team,
    ).toEqual({ perUserLogin: true, loginDomains: ['calendar', 'docs'], loginExclude: ['mail:x'] });
  });

  it('enables per-person sign-in only for a Claude team bot', () => {
    const team = { perUserLogin: true };
    expect(perUserLoginEnabled(profile({ mode: 'team', team }))).toBe(true);
    expect(perUserLoginEnabled(profile({ mode: 'personal', team }))).toBe(false);
    expect(perUserLoginEnabled(profile({ mode: 'team' }))).toBe(false);
    expect(
      perUserLoginEnabled(
        profile({ mode: 'team', team, agentKind: 'codex', codex: { binaryPath: '/usr/bin/codex' } }),
      ),
    ).toBe(false);
  });
});

describe('team access ceiling', () => {
  function accessFor(mode: 'personal' | 'team'): string {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      mode,
      accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'lark' } },
      permissions: { defaultAccess: 'full', maxAccess: 'full' },
    });
    const result = evaluateRunPolicy({
      scope: { source: 'im', chatId: 'oc_1', actorId: 'ou_1' },
      attachments: [],
      prompt: 'hi',
      requestedCwd: '/repo',
      cwdRealpath: '/repo',
      access: { ok: true, reason: 'allowed-team' },
      capability: claudeCapability(cfg),
      profileConfig: cfg,
      now: 1000,
    });
    if (!result.ok) throw new Error('expected allow');
    return result.permissionMode;
  }

  it("caps a team bot at workspace access so no member gets an unrestricted shell", () => {
    expect(accessFor('team')).toBe('acceptEdits');
    expect(accessFor('personal')).toBe('bypassPermissions');
  });
});
