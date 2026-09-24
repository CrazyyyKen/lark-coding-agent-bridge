import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AccessMode } from '../../config/permissions';
import type { AgentEvent } from '../types';
import { killProcessTree } from './cli-executor';

/**
 * Server-owned authority for Copilot Studio tool calls.
 *
 * The MCP API key only proves "this is the Studio connection". It says nothing
 * about which Lark user or turn a call belongs to, and Direct Line / MCP
 * session ids are unrelated identifiers. So every tool call must present an
 * execution token minted here for one admitted bridge run; all authority
 * (profile, run, access mode) is read from this registry, never from
 * model-provided fields.
 *
 * The token is a bearer capability that also appears in the prompt sent to
 * Studio (and therefore in Studio's conversation history). That is why grants
 * are short-lived, bound to one run, revoked on completion/stop/timeout, and
 * only issued for owner-only DMs with read-only operations.
 */

export type ExecutionRejectCode = 'missing-token' | 'unknown-token' | 'revoked' | 'expired' | 'call-limit';

export interface ExecutionGrant {
  readonly runId: string;
  readonly profile: string;
  readonly accessMode: AccessMode;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
  /** Deliver a correlated tool event to the owning run. */
  emit(event: AgentEvent): void;
  /** Track a spawned CLI child so revoke/stop can kill it. */
  trackChild(child: ChildProcess): void;
  /** Count one tool call; false when the per-run limit is reached. */
  beginCall(): boolean;
  endCall(): void;
  /**
   * Results of write commands already executed in this run, keyed by their
   * argument list, so a retried identical call is not executed twice.
   */
  readonly completedWrites: Map<string, unknown>;
}

export interface ExecutionHandle {
  readonly token: string;
  readonly grant: ExecutionGrant;
  /** Calls currently executing for this run. */
  inFlight(): number;
  revoke(reason: string): void;
  /** Resolves once every child spawned for this run has exited. */
  waitForChildren(timeoutMs: number): Promise<boolean>;
}

interface GrantState {
  token: string;
  runId: string;
  profile: string;
  accessMode: AccessMode;
  expiresAt: number;
  maxCalls: number;
  calls: number;
  inFlight: number;
  revokedReason?: string;
  abort: AbortController;
  children: Set<ChildProcess>;
  completedWrites: Map<string, unknown>;
  emit: (event: AgentEvent) => void;
}

export interface RegisterExecutionInput {
  runId: string;
  profile: string;
  accessMode: AccessMode;
  ttlMs: number;
  maxCalls: number;
  emit: (event: AgentEvent) => void;
}

export class ExecutionRegistry {
  private readonly grants = new Map<string, GrantState>();

  constructor(private readonly now: () => number = Date.now) {}

  register(input: RegisterExecutionInput): ExecutionHandle {
    this.prune();
    const token = `cst_${randomBytes(32).toString('base64url')}`;
    const state: GrantState = {
      token,
      runId: input.runId,
      profile: input.profile,
      accessMode: input.accessMode,
      expiresAt: this.now() + input.ttlMs,
      maxCalls: input.maxCalls,
      calls: 0,
      inFlight: 0,
      abort: new AbortController(),
      children: new Set(),
      completedWrites: new Map(),
      emit: input.emit,
    };
    this.grants.set(token, state);
    const grant = this.toGrant(state);
    return {
      token,
      grant,
      inFlight: () => state.inFlight,
      revoke: (reason) => this.revokeState(state, reason),
      waitForChildren: (timeoutMs) => waitForChildren(state.children, timeoutMs),
    };
  }

  /** Resolve a token presented by an MCP call. Never trusts caller-supplied ids. */
  resolve(token: unknown): { ok: true; grant: ExecutionGrant } | { ok: false; code: ExecutionRejectCode } {
    if (typeof token !== 'string' || token.length === 0) return { ok: false, code: 'missing-token' };
    const state = this.grants.get(token);
    if (!state) return { ok: false, code: 'unknown-token' };
    if (state.revokedReason) return { ok: false, code: 'revoked' };
    if (state.expiresAt <= this.now()) {
      this.revokeState(state, 'expired');
      return { ok: false, code: 'expired' };
    }
    return { ok: true, grant: this.toGrant(state) };
  }

  /** Revoke every grant (profile shutdown / listener close). */
  revokeAll(reason: string): void {
    for (const state of this.grants.values()) this.revokeState(state, reason);
  }

  activeCount(): number {
    this.prune();
    let n = 0;
    for (const state of this.grants.values()) if (!state.revokedReason) n++;
    return n;
  }

  private toGrant(state: GrantState): ExecutionGrant {
    return {
      runId: state.runId,
      profile: state.profile,
      accessMode: state.accessMode,
      expiresAt: state.expiresAt,
      signal: state.abort.signal,
      emit: (event) => {
        // Events after revocation belong to a finished run: drop them rather
        // than leak into whatever the channel renders next.
        if (!state.revokedReason) state.emit(event);
      },
      trackChild: (child) => {
        if (state.revokedReason) {
          killProcessTree(child);
          return;
        }
        state.children.add(child);
        child.once('close', () => state.children.delete(child));
      },
      beginCall: () => {
        if (state.revokedReason || state.calls >= state.maxCalls) return false;
        state.calls++;
        state.inFlight++;
        return true;
      },
      endCall: () => {
        state.inFlight = Math.max(0, state.inFlight - 1);
      },
      completedWrites: state.completedWrites,
    };
  }

  private revokeState(state: GrantState, reason: string): void {
    if (state.revokedReason) return;
    state.revokedReason = reason;
    state.abort.abort(new Error(`execution revoked: ${reason}`));
    for (const child of state.children) killProcessTree(child);
  }

  /** Drop revoked/expired grants with no live children; keep memory bounded. */
  private prune(): void {
    const now = this.now();
    for (const [token, state] of this.grants.entries()) {
      if (!state.revokedReason && state.expiresAt <= now) this.revokeState(state, 'expired');
      if (state.revokedReason && state.children.size === 0 && state.inFlight === 0) {
        this.grants.delete(token);
      }
    }
  }
}

function waitForChildren(children: Set<ChildProcess>, timeoutMs: number): Promise<boolean> {
  const live = [...children].filter((c) => c.exitCode === null && c.signalCode === null);
  if (live.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let remaining = live.length;
    const timer = setTimeout(() => resolve(false), timeoutMs);
    for (const child of live) {
      child.once('close', () => {
        remaining--;
        if (remaining === 0) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    }
  });
}
