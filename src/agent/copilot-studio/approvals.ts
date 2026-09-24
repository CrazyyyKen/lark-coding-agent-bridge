import { randomInt } from 'node:crypto';
import { log } from '../../core/logger';

/**
 * Owner approval for high-risk lark-cli commands in full mode.
 *
 * The MCP tool call that wants to run a high-risk command waits here while
 * the bridge asks the owner in Lark ("reply /approve 4821"). Only the owner
 * can answer (the /approve command checks that), a request expires on its own,
 * and a stopped/finished run cancels its pending requests. The model never
 * sees the code and cannot pass `--yes` itself.
 */

export type ApprovalDecision = 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface ApprovalRequest {
  code: string;
  runId: string;
  /** Human-readable command line shown to the owner. */
  commandText: string;
  reason: string;
  expiresAt: number;
}

export type ApprovalNotifier = (request: ApprovalRequest) => Promise<void>;

interface Pending {
  request: ApprovalRequest;
  settle(decision: ApprovalDecision): void;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private notifier: ApprovalNotifier | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Set by the channel once it can message the owner; undefined = cannot ask. */
  setNotifier(notifier: ApprovalNotifier | undefined): void {
    this.notifier = notifier;
  }

  get canAsk(): boolean {
    return this.notifier !== undefined;
  }

  get currentNotifier(): ApprovalNotifier | undefined {
    return this.notifier;
  }

  async request(input: {
    runId: string;
    commandText: string;
    reason: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<ApprovalDecision> {
    const notifier = this.notifier;
    if (!notifier) return 'rejected';
    if (input.signal.aborted) return 'cancelled';
    const code = this.newCode();
    const request: ApprovalRequest = {
      code,
      runId: input.runId,
      commandText: input.commandText,
      reason: input.reason,
      expiresAt: this.now() + input.timeoutMs,
    };
    const decision = new Promise<ApprovalDecision>((resolve) => {
      let done = false;
      const settle = (value: ApprovalDecision): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        this.pending.delete(code);
        log.info('copilot-approval', 'settled', { runId: input.runId, decision: value });
        resolve(value);
      };
      const timer = setTimeout(() => settle('expired'), input.timeoutMs);
      timer.unref?.();
      const onAbort = (): void => settle('cancelled');
      input.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(code, { request, settle });
    });
    try {
      await notifier(request);
      log.info('copilot-approval', 'requested', { runId: input.runId });
    } catch (err) {
      log.warn('copilot-approval', 'notify-failed', { err: err instanceof Error ? err.message : String(err) });
      this.pending.get(code)?.settle('rejected');
    }
    return decision;
  }

  /** Answer a pending request. Returns false for an unknown or already-settled code. */
  resolve(code: string, decision: 'approved' | 'rejected'): boolean {
    const entry = this.pending.get(code.trim());
    if (!entry) return false;
    entry.settle(decision);
    return true;
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.request }));
  }

  cancelAll(): void {
    for (const entry of [...this.pending.values()]) entry.settle('cancelled');
  }

  private newCode(): string {
    for (;;) {
      const code = String(randomInt(1000, 10_000));
      if (!this.pending.has(code)) return code;
    }
  }
}
