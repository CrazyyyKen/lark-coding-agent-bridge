import { describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../../../../src/agent/copilot-studio/approvals.js';
import {
  createRiskResolver,
  evaluateFullModeArgs,
  needsOwnerApproval,
  parseRiskFromHelp,
} from '../../../../src/agent/copilot-studio/cli-policy.js';

describe('copilot studio full-mode policy', () => {
  it('passes ordinary reads and writes through unchanged', () => {
    const send = evaluateFullModeArgs(['im', '+messages-send', '--chat-id', 'oc_1', '--text', 'hello\nsecond line']);
    expect(send).toEqual({
      ok: true,
      args: ['im', '+messages-send', '--chat-id', 'oc_1', '--text', 'hello\nsecond line'],
      commandPath: ['im', '+messages-send'],
      help: false,
    });
    expect(evaluateFullModeArgs(['calendar', 'events', 'delete', '--event-id=e1'])).toMatchObject({
      ok: true,
      commandPath: ['calendar', 'events', 'delete'],
    });
    expect(evaluateFullModeArgs(['calendar', '--help'])).toMatchObject({ ok: true, help: true });
    expect(evaluateFullModeArgs(['docs', '+fetch', '--max-depth', '-1'])).toMatchObject({ ok: true });
  });

  it.each([
    [['auth', 'login'], 'unknown-operation'],
    [['config', 'strict-mode', 'off'], 'unknown-operation'],
    [['profile', 'list'], 'unknown-operation'],
    [['update'], 'unknown-operation'],
    [['api', 'DELETE', '/open-apis/x'], 'unknown-operation'],
    [['--help'], 'unknown-operation'],
    [['whoami', '--as', 'user'], 'flag-not-allowed'],
    [['im', '+messages-send', '--text', 'x', '--profile=other'], 'flag-not-allowed'],
    [['calendar', '+agenda', '--jq', '$ENV'], 'flag-not-allowed'],
    [['calendar', '+delete', '--event-id', 'e1', '--yes'], 'flag-not-allowed'],
    [['calendar', '+agenda', '-q', '.'], 'flag-not-allowed'],
    [['calendar', '+agenda', '--', '--as'], 'flag-not-allowed'],
  ])('rejects %j (%s)', (args, code) => {
    expect(evaluateFullModeArgs(args)).toMatchObject({ ok: false, code });
  });

  it('keeps local file access inside the bridge working folder', () => {
    for (const args of [
      ['drive', '+upload', '--file', 'C:\\Users\\me\\secrets.txt'],
      ['drive', '+upload', '--file=C:/Users/me/secrets.txt'],
      ['drive', '+upload', '--file', '\\\\server\\share\\x'],
      ['drive', '+upload', '--file', '/etc/passwd'],
      ['drive', '+upload', '--file', '~/.ssh/id_rsa'],
      ['drive', '+upload', '--file', '..\\..\\secrets.txt'],
      ['drive', '+download', '--output-dir', '../outside'],
    ]) {
      expect(evaluateFullModeArgs(args), JSON.stringify(args)).toMatchObject({ ok: false, code: 'invalid-flag-value' });
    }
    expect(evaluateFullModeArgs(['drive', '+upload', '--file', 'report.pdf']).ok).toBe(true);
    expect(evaluateFullModeArgs(['drive', '+download', '--output-dir', 'downloads/today']).ok).toBe(true);
    // Text that merely mentions a path in a non-path flag is fine.
    expect(evaluateFullModeArgs(['im', '+messages-send', '--text', 'see /docs/page']).ok).toBe(true);
  });

  it('rejects control characters other than newline and tab', () => {
    expect(evaluateFullModeArgs(['im', '+messages-send', '--text', 'a\u0000b'])).toMatchObject({ ok: false });
    expect(evaluateFullModeArgs(['im', '+messages-send', '--text', 'a\tb\nc']).ok).toBe(true);
  });

  it('reads risk from lark-cli help and decides when the owner must approve', async () => {
    expect(parseRiskFromHelp('Usage:\n  lark-cli calendar +delete\n\nRisk: high-risk-write\n')).toBe('high-risk-write');
    expect(parseRiskFromHelp('Risk: write')).toBe('write');
    expect(parseRiskFromHelp('Risk levels (read | write | high-risk-write) appear in …')).toBe('unknown');

    expect(needsOwnerApproval(['calendar', '+delete'], 'high-risk-write')).toBe(true);
    expect(needsOwnerApproval(['calendar', 'events', 'delete'], 'write')).toBe(true);
    expect(needsOwnerApproval(['im', 'message', 'recall'], 'write')).toBe(true);
    expect(needsOwnerApproval(['drive', '+member-remove'], 'write')).toBe(true);
    expect(needsOwnerApproval(['skills', 'list'], 'unknown')).toBe(true);
    expect(needsOwnerApproval(['im', '+messages-send'], 'write')).toBe(false);
    expect(needsOwnerApproval(['calendar', '+agenda'], 'read')).toBe(false);

    let calls = 0;
    const riskOf = createRiskResolver(async () => {
      calls++;
      return 'Risk: write';
    });
    await riskOf(['im', '+messages-send']);
    await riskOf(['im', '+messages-send']);
    expect(calls).toBe(1);
    const failing = createRiskResolver(async () => {
      throw new Error('boom');
    });
    await expect(failing(['x'])).resolves.toBe('unknown');
  });
});

describe('approval broker', () => {
  const signal = () => new AbortController().signal;

  it('asks through the notifier and resolves on the owner answer', async () => {
    const broker = new ApprovalBroker();
    const asked: string[] = [];
    broker.setNotifier(async (request) => {
      asked.push(request.code);
    });
    const pending = broker.request({ runId: 'r', commandText: 'lark-cli x', reason: 'why', timeoutMs: 5000, signal: signal() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^\d{4}$/);
    expect(broker.resolve('0000', 'approved')).toBe(false);
    expect(broker.resolve(asked[0]!, 'approved')).toBe(true);
    await expect(pending).resolves.toBe('approved');
    expect(broker.resolve(asked[0]!, 'approved')).toBe(false);
  });

  it('expires, cancels on abort, and refuses when it cannot ask', async () => {
    const broker = new ApprovalBroker();
    await expect(broker.request({ runId: 'r', commandText: 'x', reason: 'y', timeoutMs: 1000, signal: signal() })).resolves.toBe(
      'rejected',
    );
    broker.setNotifier(async () => {});
    await expect(broker.request({ runId: 'r', commandText: 'x', reason: 'y', timeoutMs: 30, signal: signal() })).resolves.toBe(
      'expired',
    );
    const abort = new AbortController();
    const pending = broker.request({ runId: 'r', commandText: 'x', reason: 'y', timeoutMs: 5000, signal: abort.signal });
    abort.abort();
    await expect(pending).resolves.toBe('cancelled');
    broker.setNotifier(async () => {
      throw new Error('send failed');
    });
    await expect(broker.request({ runId: 'r', commandText: 'x', reason: 'y', timeoutMs: 5000, signal: signal() })).resolves.toBe(
      'rejected',
    );
    expect(broker.list()).toEqual([]);
  });
});
