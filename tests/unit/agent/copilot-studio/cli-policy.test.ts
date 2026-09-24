import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CLI_OPERATIONS,
  createCliPolicy,
  describeCliPolicy,
  evaluateCliArgs,
} from '../../../../src/agent/copilot-studio/cli-policy.js';

const { policy } = createCliPolicy(undefined);

describe('copilot studio lark-cli policy', () => {
  it('allows a read operation and canonicalizes flags to inline form', () => {
    const decision = evaluateCliArgs(
      policy,
      ['calendar', '+agenda', '--start', '2026-09-24T00:00:00+08:00', '--json'],
      'read-only',
    );
    expect(decision).toEqual({
      ok: true,
      operation: expect.objectContaining({ id: 'calendar.agenda' }),
      args: ['calendar', '+agenda', '--start=2026-09-24T00:00:00+08:00', '--json'],
    });
  });

  it('accepts --flag=value and repeatable string flags', () => {
    const decision = evaluateCliArgs(
      policy,
      ['calendar', '+freebusy', '--user-id=ou_1', '--user-id', 'ou_2', '--type=free'],
      'read-only',
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.args).toEqual(['calendar', '+freebusy', '--user-id=ou_1', '--user-id=ou_2', '--type=free']);
    }
  });

  it.each([
    [['auth', 'login'], 'unknown-operation'],
    [['config', 'strict-mode', 'off'], 'unknown-operation'],
    [['api', 'GET', '/open-apis/x'], 'unknown-operation'],
    [['im', '+messages-send', '--chat-id', 'oc_1', '--text', 'hi'], 'unknown-operation'],
    [['whoami', '--as', 'user'], 'flag-not-allowed'],
    [['calendar', '+agenda', '--profile', 'other'], 'flag-not-allowed'],
    [['calendar', '+agenda', '--jq', '$ENV'], 'flag-not-allowed'],
    [['calendar', '+agenda', '-q', '.'], 'flag-not-allowed'],
    [['im', '+chat-messages-list', '--chat-id', 'oc_1', '--download-resources'], 'flag-not-allowed'],
    [['im', '+chat-messages-list', '--chat-id', 'oc_1', '--page-all'], 'flag-not-allowed'],
    [['calendar', '+agenda', '--unknown-flag', 'x'], 'flag-not-allowed'],
    [['calendar', '+agenda', 'positional'], 'unexpected-positional'],
    [['calendar', '+agenda', '--'], 'flag-not-allowed'],
  ])('rejects %j (%s)', (args, code) => {
    const decision = evaluateCliArgs(policy, args, 'read-only');
    expect(decision).toMatchObject({ ok: false, code });
  });

  it('never lets a value smuggle in another flag', () => {
    for (const args of [
      ['im', '+messages-search', '--query', '--as'],
      ['im', '+messages-search', '--query=--profile=x'],
      ['docs', '+fetch', '--doc', '-q'],
    ]) {
      expect(evaluateCliArgs(policy, args, 'read-only')).toMatchObject({ ok: false, code: 'invalid-flag-value' });
    }
  });

  it('validates enum, int and bool shapes', () => {
    expect(evaluateCliArgs(policy, ['calendar', '+agenda', '--format', 'xml'], 'read-only')).toMatchObject({
      ok: false,
      code: 'invalid-flag-value',
    });
    expect(
      evaluateCliArgs(policy, ['im', '+chat-messages-list', '--chat-id', 'oc_1', '--page-size', '500'], 'read-only'),
    ).toMatchObject({ ok: false, code: 'invalid-flag-value' });
    expect(evaluateCliArgs(policy, ['docs', '+fetch', '--doc', 'x', '--revision-id', '-1'], 'read-only').ok).toBe(true);
    expect(evaluateCliArgs(policy, ['task', '+get-my-tasks', '--complete=maybe'], 'read-only')).toMatchObject({
      ok: false,
      code: 'invalid-flag-value',
    });
    expect(evaluateCliArgs(policy, ['task', '+get-my-tasks', '--complete=false'], 'read-only')).toMatchObject({
      ok: true,
      args: ['task', '+get-my-tasks', '--complete=false'],
    });
  });

  it('rejects duplicate non-repeatable flags, control characters and oversized input', () => {
    expect(evaluateCliArgs(policy, ['calendar', '+agenda', '--start', 'a', '--start', 'b'], 'read-only')).toMatchObject({
      ok: false,
      code: 'invalid-flag-value',
    });
    expect(evaluateCliArgs(policy, ['im', '+messages-search', '--query', 'a\nb'], 'read-only')).toMatchObject({
      ok: false,
      code: 'invalid-args',
    });
    expect(evaluateCliArgs(policy, new Array(65).fill('x'), 'read-only')).toMatchObject({ ok: false, code: 'invalid-args' });
    expect(evaluateCliArgs(policy, [], 'read-only')).toMatchObject({ ok: false, code: 'invalid-args' });
    expect(evaluateCliArgs(policy, 'whoami' as unknown, 'read-only')).toMatchObject({ ok: false, code: 'invalid-args' });
    expect(evaluateCliArgs(policy, [1, 2] as unknown, 'read-only')).toMatchObject({ ok: false, code: 'invalid-args' });
  });

  it('keeps shell metacharacters as inert argument text', () => {
    const decision = evaluateCliArgs(
      policy,
      ['im', '+messages-search', '--query', 'a & b | c; rm -rf / $(x) `y` %PATH% "q"'],
      'read-only',
    );
    expect(decision.ok).toBe(true);
  });

  it('config can only narrow the built-in set', () => {
    const narrowed = createCliPolicy(['whoami', 'shell.exec', 'calendar.agenda']);
    expect(narrowed.policy.operations.map((op) => op.id)).toEqual(['whoami', 'calendar.agenda']);
    expect(narrowed.unknownOperationIds).toEqual(['shell.exec']);
    expect(evaluateCliArgs(narrowed.policy, ['docs', '+fetch', '--doc', 'x'], 'read-only')).toMatchObject({
      ok: false,
      code: 'operation-not-enabled',
    });
    expect(createCliPolicy([]).policy.operations).toEqual([]);
  });

  it('ships read operations only in this release', () => {
    expect(BUILTIN_CLI_OPERATIONS.every((op) => op.risk === 'read')).toBe(true);
    for (const op of BUILTIN_CLI_OPERATIONS) {
      for (const blocked of ['--as', '--profile', '--jq', '-q', '--download-resources', '--output', '--page-all']) {
        expect(op.flags[blocked], `${op.id} ${blocked}`).toBeUndefined();
      }
    }
  });

  it('describes the policy for the model', () => {
    const described = describeCliPolicy(policy);
    expect(described.find((op) => op.id === 'calendar.agenda')).toMatchObject({
      command: 'calendar +agenda',
      risk: 'read',
      flags: expect.arrayContaining(['--start <value>', '--format <json|pretty|table|ndjson|csv>', '--json']),
    });
  });
});
