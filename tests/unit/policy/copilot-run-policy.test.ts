import { describe, expect, it } from 'vitest';
import {
  capabilityForProfile,
  claudeCapability,
  copilotStudioCapability,
} from '../../../src/agent/capability.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { evaluateRunPolicy, type ScopeContext } from '../../../src/policy/run-policy.js';
import type { AccessDecision } from '../../../src/policy/access.js';

const account = { app: { id: 'cli_test', secret: 's', tenant: 'lark' as const } };
const copilotProfile = createDefaultProfileConfig({ agentKind: 'copilot-studio', accounts: account });

function evaluate(scope: Partial<ScopeContext>, access: AccessDecision, profile = copilotProfile) {
  return evaluateRunPolicy({
    scope: { source: 'im', actorId: 'ou_owner', chatId: 'oc_1', ...scope },
    attachments: [],
    prompt: 'hi',
    requestedCwd: '/w',
    cwdRealpath: '/w',
    access,
    capability: capabilityForProfile(profile),
    profileConfig: profile,
    now: 1000,
  });
}

describe('copilot studio run policy', () => {
  it('capabilityForProfile dispatches every agent kind', () => {
    expect(capabilityForProfile(copilotProfile)).toEqual(copilotStudioCapability());
    expect(capabilityForProfile(createDefaultProfileConfig({ agentKind: 'claude', accounts: account })).agentId).toBe('claude');
    expect(copilotStudioCapability()).toMatchObject({
      remote: true,
      ownerDmOnly: true,
      sources: ['im'],
      permissions: { maxAccess: 'read-only' },
    });
    expect(claudeCapability()).toMatchObject({ remote: false, ownerDmOnly: false });
  });

  it('admits the owner in a private chat, read-only', () => {
    const result = evaluate({ chatType: 'p2p' }, { ok: true, reason: 'owner' });
    expect(result).toMatchObject({ ok: true, accessMode: 'read-only', sandbox: 'read-only' });
  });

  it('caps a full-access profile at read-only', () => {
    const wide = createDefaultProfileConfig({
      agentKind: 'copilot-studio',
      accounts: account,
      permissions: { defaultAccess: 'full', maxAccess: 'full' },
    });
    expect(evaluate({ chatType: 'p2p' }, { ok: true, reason: 'owner' }, wide)).toMatchObject({ ok: true, accessMode: 'read-only' });
  });

  it.each([
    ['group chat, owner', { chatType: 'group' }, { ok: true, reason: 'owner' }],
    ['p2p, allowlisted non-owner', { chatType: 'p2p' }, { ok: true, reason: 'allowed-user' }],
    ['p2p, team mode', { chatType: 'p2p' }, { ok: true, reason: 'allowed-team' }],
    ['unknown chat type', {}, { ok: true, reason: 'owner' }],
  ] as const)('rejects %s', (_label, scope, access) => {
    expect(evaluate(scope, access)).toMatchObject({ ok: false, rejectReason: { code: 'owner-dm-required' } });
  });

  it.each(['comment', 'meeting', 'card'] as const)('rejects the %s source before execution', (source) => {
    expect(evaluate({ source, chatType: 'p2p' }, { ok: true, reason: 'owner' })).toMatchObject({
      ok: false,
      rejectReason: { code: 'source-not-supported' },
    });
  });

  it('leaves Claude runs from groups untouched', () => {
    const claude = createDefaultProfileConfig({ agentKind: 'claude', accounts: account });
    expect(evaluate({ chatType: 'group' }, { ok: true, reason: 'allowed-chat' }, claude).ok).toBe(true);
  });
});
