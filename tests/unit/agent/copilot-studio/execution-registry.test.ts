import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../../src/agent/types.js';
import { ExecutionRegistry } from '../../../../src/agent/copilot-studio/execution-registry.js';

function register(registry: ExecutionRegistry, overrides: Partial<Parameters<ExecutionRegistry['register']>[0]> = {}) {
  const events: AgentEvent[] = [];
  const handle = registry.register({
    runId: 'run-1',
    profile: 'copilot',
    accessMode: 'read-only',
    ttlMs: 60_000,
    maxCalls: 2,
    emit: (event) => events.push(event),
    ...overrides,
  });
  return { handle, events };
}

describe('copilot studio execution registry', () => {
  it('mints unguessable per-run tokens and resolves server-owned state', () => {
    const registry = new ExecutionRegistry();
    const a = register(registry);
    const b = register(registry, { runId: 'run-2' });
    expect(a.handle.token).toMatch(/^cst_[A-Za-z0-9_-]{43}$/);
    expect(a.handle.token).not.toBe(b.handle.token);
    const resolved = registry.resolve(a.handle.token);
    expect(resolved).toMatchObject({ ok: true, grant: { runId: 'run-1', profile: 'copilot', accessMode: 'read-only' } });
  });

  it('rejects missing, unknown, revoked and expired tokens', () => {
    let now = 1000;
    const registry = new ExecutionRegistry(() => now);
    const { handle } = register(registry, { ttlMs: 500 });
    expect(registry.resolve(undefined)).toEqual({ ok: false, code: 'missing-token' });
    expect(registry.resolve('')).toEqual({ ok: false, code: 'missing-token' });
    expect(registry.resolve('cst_guess')).toEqual({ ok: false, code: 'unknown-token' });
    now = 1600;
    expect(registry.resolve(handle.token)).toEqual({ ok: false, code: 'expired' });

    const second = register(registry);
    second.handle.revoke('turn-complete');
    const afterRevoke = registry.resolve(second.handle.token);
    expect(afterRevoke.ok).toBe(false);
  });

  it('drops events after revocation so a finished run never receives late tool output', () => {
    const registry = new ExecutionRegistry();
    const { handle, events } = register(registry);
    const resolved = registry.resolve(handle.token);
    if (!resolved.ok) throw new Error('expected grant');
    resolved.grant.emit({ type: 'tool_use', id: 'a', name: 'lark-cli', input: {} });
    handle.revoke('interrupted');
    resolved.grant.emit({ type: 'tool_result', id: 'a', output: 'late', isError: false });
    expect(events).toEqual([{ type: 'tool_use', id: 'a', name: 'lark-cli', input: {} }]);
    expect(resolved.grant.signal.aborted).toBe(true);
  });

  it('enforces the per-run call limit and tracks in-flight calls', () => {
    const registry = new ExecutionRegistry();
    const { handle } = register(registry, { maxCalls: 2 });
    const resolved = registry.resolve(handle.token);
    if (!resolved.ok) throw new Error('expected grant');
    expect(resolved.grant.beginCall()).toBe(true);
    expect(handle.inFlight()).toBe(1);
    expect(resolved.grant.beginCall()).toBe(true);
    expect(resolved.grant.beginCall()).toBe(false);
    resolved.grant.endCall();
    resolved.grant.endCall();
    expect(handle.inFlight()).toBe(0);
  });

  it('revokeAll revokes every live grant', () => {
    const registry = new ExecutionRegistry();
    const a = register(registry);
    const b = register(registry, { runId: 'run-2' });
    expect(registry.activeCount()).toBe(2);
    registry.revokeAll('profile-shutdown');
    expect(registry.resolve(a.handle.token).ok).toBe(false);
    expect(registry.resolve(b.handle.token).ok).toBe(false);
  });
});
