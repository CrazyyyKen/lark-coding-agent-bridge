import type { AgentAvailability } from './preflight';
import type { ClaudePermissionMode, CodexSandboxMode } from '../config/permissions';

export type { ClaudePermissionMode } from '../config/permissions';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; threadId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'final_text'; content: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      sessionId?: string;
      threadId?: string;
      terminationReason: 'normal' | 'interrupted' | 'timeout';
    }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };

export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';

/**
 * Whose Lark identity a team-mode run may use, chosen by the bridge per run.
 * Personal-mode runs carry none and keep the profile's own lark-cli login.
 *
 *   - `user`: a DM run acting for one person through their own lark-cli
 *     login folder (team.perUserLogin).
 *   - `shared-bot`: any other team-mode run (groups, doc comments, meetings,
 *     or DMs when per-person sign-in is off). The bot's own identity only.
 */
export interface AgentLarkIdentity {
  kind: 'user' | 'shared-bot';
  /** The sender's open_id, for `user`. */
  openId?: string;
  /** Whether that person has finished signing in, for `user`. */
  signedIn?: boolean;
  /** Replaces the profile's LARKSUITE_CLI_CONFIG_DIR for this run. */
  larkCliConfigDir?: string;
  /**
   * Directories the agent's file tools must not read or edit: other people's
   * folders, every session history, bridge logs. Enforced as Claude Code
   * permission deny rules, so it is a fence for the agent's tools, not an OS
   * boundary.
   */
  blockedDirs: string[];
  /**
   * Permission rules carried over from the shared workspace's
   * `.claude/settings.json` (e.g. `Bash(lark-cli:*)`). A person's folder is a
   * project Claude Code has never trusted, so rules in its own project
   * settings would be ignored; passing them with the run keeps them in force.
   */
  inheritedRules?: { allow: string[]; deny: string[] };
}

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  cwd?: string;
  sessionId?: string;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  sandbox?: CodexSandboxMode;
  permissionMode?: ClaudePermissionMode;
  /** Team-mode Lark identity for this run. See {@link AgentLarkIdentity}. */
  larkIdentity?: AgentLarkIdentity;
  /**
   * Grace period (ms) between SIGTERM and SIGKILL when stop() is called on
   * the returned run. Lets the agent (and any subprocess it spawned, e.g.
   * lark-cli mid-OAuth) clean up before the kernel reaps the tree.
   * Adapters that don't kill via signals are free to ignore this. Defaults
   * are adapter-specific.
  */
  stopGraceMs?: number;
}

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
  /**
   * Wait up to `timeoutMs` for the agent process to exit on its own.
   * Resolves true if it exited within the window, false if the timer
   * fired first (caller usually wants to fall back to stop()).
   *
   * Use this after a terminal stream event (`done` / `error`): the
   * stream-json `result` line arrives before claude has actually closed
   * stdout — there's a brief telemetry/cleanup tail in between. Calling
   * stop() in that window forces a SIGTERM and the run exits with code
   * 143 instead of 0; waiting it out lets it exit cleanly.
   */
  waitForExit(timeoutMs: number): Promise<boolean>;
}

/**
 * The bridge bot's own IM identity, resolved by the channel after the WS
 * handshake (`/open-apis/bot/v3/info`). Injected into adapters so the agent
 * system prompt can state "this open_id is you" with the real value.
 */
export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  /**
   * Late-bound identity injection: the adapter is constructed before the
   * channel connects, so the channel calls this once botIdentity is known.
   * Adapters that don't bake identity into their prompts may omit it.
   */
  setBotIdentity?(identity: AgentBotIdentity): void;
}
