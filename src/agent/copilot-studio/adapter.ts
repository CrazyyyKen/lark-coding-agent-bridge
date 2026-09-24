import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeystorePaths } from '../../config/keystore';
import type { AccessMode } from '../../config/permissions';
import type { CopilotSecretInput, CopilotStudioConfig } from '../../config/profile-schema';
import type { SecretsConfig } from '../../config/schema';
import { copilotSecretEnvNames, resolveCopilotSecret } from '../../config/secret-resolver';
import { log } from '../../core/logger';
import { SpawnFailed } from '../../runtime/errors';
import type { LarkChannelEnvContext } from '../lark-channel-env';
import {
  AgentPreflightError,
  type AgentAvailability,
  type AgentPreflightDiagnostic,
} from '../preflight';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import {
  renderBotMessage,
  sanitizeActivity,
  stripCompletionMarker,
  type DirectLineActivity,
} from './activities';
import {
  buildLarkCliChildEnv,
  resolveLarkCliExecutable,
  runLarkCli,
  type ResolvedLarkCli,
} from './cli-executor';
import type { ApprovalNotifier, ApprovalRequest } from './approvals';
import { createCliPolicy, createRiskResolver, type CliPolicy, type CliRisk } from './cli-policy';
import {
  abortableSleep,
  assertTrustedDirectLineOrigin,
  DirectLineClient,
  DirectLineError,
} from './direct-line';
import type { ExecutionHandle } from './execution-registry';
import {
  acquireCopilotStudioServices,
  type CopilotStudioServices,
  type McpListenerSettings,
} from './services';
import { buildStudioMessage } from './studio-message';

export interface CopilotStudioAdapterOptions {
  profile: string;
  profileDir: string;
  config: CopilotStudioConfig;
  /** Root/profile secret providers (for env/file/exec refs). */
  secrets?: SecretsConfig;
  keystorePaths: KeystorePaths;
  larkChannel?: LarkChannelEnvContext;
  /** Stable per-profile seed for the Direct Line user id (e.g. the app id). */
  userSeed: string;
  version: string;
  // --- test seams (not reachable from profile config) ---
  fetch?: typeof fetch;
  trustedOriginsForTesting?: readonly string[];
  resolveSecret?: (input: CopilotSecretInput | undefined, label: string) => Promise<string>;
  resolveCli?: () => Promise<ResolvedLarkCli>;
  /** Replaces the real lark-cli spawn (policy checks still run first). */
  runCli?: McpListenerSettings['runCli'];
  /** Replaces the `--help`-based risk lookup (full mode). */
  riskOf?: (commandPath: string[]) => Promise<CliRisk>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Refresh-loop interval; 0 disables the background loop (tests). */
  maintenanceIntervalMs?: number;
  /**
   * Observer for sanitized (shape-only) activities, e.g. `copilot-studio
   * probe --capture`. Never receives message text or card content.
   */
  onActivity?: (event: { phase: 'drain' | 'turn'; activity: Record<string, unknown> }) => void;
  /** Observer for how each turn ended (probe / diagnostics). */
  onTurnEnd?: (info: CopilotTurnEndInfo) => void;
}

/**
 * How a turn ended. `studio-event` is the `turn.complete` event activity a
 * published Copilot Studio agent sends after its reply (observed on live
 * Direct Line traffic, correlated by replyToId); `marker` is the
 * instructions-based fallback; `quiet-window` is the degraded last resort.
 */
export type CopilotTurnCompletion = 'studio-event' | 'marker' | 'end-of-conversation' | 'quiet-window';

export interface CopilotTurnEndInfo {
  runId: string;
  outcome: 'complete' | 'interrupted' | 'timeout' | 'failed';
  completion?: CopilotTurnCompletion;
  sawReply: boolean;
  durationMs: number;
}

interface ConversationState {
  id: string;
  token: string;
  tokenExpiresAt: number;
  watermark?: string;
  quarantined?: string;
  busy: boolean;
  lastUsedAt: number;
  seen: Set<string>;
}

interface ReadyState {
  directLineSecret: string;
  services: CopilotStudioServices;
  release(): Promise<void>;
  policy: CliPolicy;
  cli: ResolvedLarkCli;
}

/** Refresh a token when it has less than this left (Direct Line tokens last ~30 min). */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Drop conversations idle this long; Direct Line would expire them anyway. */
const CONVERSATION_IDLE_EVICT_MS = 12 * 60 * 60_000;
const MAX_CONVERSATIONS = 50;
const MAX_SEEN_IDS = 500;

export class CopilotStudioAdapter implements AgentAdapter {
  readonly id = 'copilot-studio';
  readonly displayName = 'Copilot Studio';

  private readonly opts: CopilotStudioAdapterOptions;
  private readonly client: DirectLineClient | undefined;
  private readonly clientError: Error | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly userId: string;
  private readonly conversations = new Map<string, ConversationState>();
  private ready: ReadyState | undefined;
  private starting: Promise<void> | undefined;
  private maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  /** Tail of the per-profile turn queue (see run()). */
  private turnTail: Promise<void> = Promise.resolve();
  /**
   * Set once this agent has been seen sending Studio's `turn.complete` event.
   * From then on the quiet-window guess is never used: a pause while the
   * model thinks between tool calls must not end the turn (and revoke its
   * execution token) early.
   */
  private studioSignalsTurnEnd = false;

  constructor(opts: CopilotStudioAdapterOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? abortableSleep;
    // Opaque and stable per profile. Direct Line never authenticates it, and
    // neither does the bridge: it only keeps Studio's per-user state stable.
    this.userId = `dl_lcb_${createHash('sha256').update(`${opts.profile}\u0000${opts.userSeed}`).digest('hex').slice(0, 24)}`;
    try {
      this.client = new DirectLineClient({
        baseUrl: opts.config.directLineBaseUrl,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.trustedOriginsForTesting ? { trustedOriginsForTesting: opts.trustedOriginsForTesting } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
      });
    } catch (err) {
      // Reported by checkAvailability()/prepareRun() with a clear diagnostic.
      this.clientError = err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Local MCP URL once started (for status output and the probe command). */
  get mcpLocalUrl(): string | undefined {
    return this.ready?.services.mcpUrl;
  }

  /**
   * Called by the channel with a way to message the owner. Returns a disposer
   * that only clears the notifier if it is still the current one, so a
   * reconnect's new channel is not undone by the old one disconnecting.
   */
  setApprovalNotifier(notifier: ApprovalNotifier): () => void {
    const approvals = this.ready?.services.approvals;
    if (!approvals) return () => {};
    approvals.setNotifier(notifier);
    return () => {
      if (approvals.currentNotifier === notifier) approvals.setNotifier(undefined);
    };
  }

  /** Answer a pending approval (from `/approve` / `/reject`). */
  resolveApproval(code: string, decision: 'approved' | 'rejected'): boolean {
    return this.ready?.services.approvals.resolve(code, decision) ?? false;
  }

  pendingApprovals(): ApprovalRequest[] {
    return this.ready?.services.approvals.list() ?? [];
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      await this.validateConfig();
      await this.resolveSecret(this.opts.config.directLineSecret, 'copilotStudio.directLineSecret');
      await this.resolveSecret(this.opts.config.mcp.authSecret, 'copilotStudio.mcp.authSecret');
      await this.resolveCli();
      return { ok: true };
    } catch (err) {
      return unavailable(err);
    }
  }

  /** Resolve secrets and start this profile's MCP listener. Idempotent. */
  async start(): Promise<void> {
    if (this.ready) return;
    this.starting ??= this.doStart().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private async doStart(): Promise<void> {
    await this.validateConfig();
    const directLineSecret = await this.resolveSecret(
      this.opts.config.directLineSecret,
      'copilotStudio.directLineSecret',
    );
    const apiKey = await this.resolveSecret(this.opts.config.mcp.authSecret, 'copilotStudio.mcp.authSecret');
    const cli = await this.resolveCli();
    const { policy, unknownOperationIds } = createCliPolicy(this.opts.config.cli.allowedOperations);
    if (unknownOperationIds.length > 0) {
      log.warn('copilot', 'unknown-operations-ignored', { ids: unknownOperationIds });
    }
    const cliCwd = join(this.opts.profileDir, 'copilot-studio', 'cli-cwd');
    await mkdir(cliCwd, { recursive: true, mode: 0o700 });
    const stripEnv = [
      ...copilotSecretEnvNames(this.opts.config.directLineSecret),
      ...copilotSecretEnvNames(this.opts.config.mcp.authSecret),
    ];
    const cliConfig = this.opts.config.cli;
    const larkChannel = this.opts.larkChannel;
    // Full mode asks lark-cli itself how risky a command is (its --help
    // carries "Risk: read | write | high-risk-write").
    const riskOf =
      this.opts.riskOf ??
      createRiskResolver(async (commandPath) => {
        const out = await runLarkCli({
          executable: cli.path,
          args: [...commandPath, '--help'],
          env: buildLarkCliChildEnv(larkChannel, stripEnv),
          cwd: cliCwd,
          timeoutMs: 15_000,
          maxOutputBytes: 64 * 1024,
        });
        return `${out.stdout}\n${out.stderr}`;
      });
    let acquired: Awaited<ReturnType<typeof acquireCopilotStudioServices>>;
    try {
      acquired = await acquireCopilotStudioServices(this.opts.profileDir, {
        bindHost: this.opts.config.mcp.bindHost,
        port: this.opts.config.mcp.port,
        path: this.opts.config.mcp.path,
        authHeader: this.opts.config.mcp.authHeader,
        allowedOrigins: this.opts.config.mcp.allowedOrigins,
        apiKey,
        policy,
        version: this.opts.version,
        mode: cliConfig.mode,
        riskOf,
        approvalTimeoutMs: cliConfig.approvalTimeoutMs,
        runCli: this.opts.runCli ?? ((args, grant) =>
          runLarkCli({
            executable: cli.path,
            args,
            env: buildLarkCliChildEnv(larkChannel, stripEnv),
            cwd: cliCwd,
            timeoutMs: cliConfig.timeoutMs,
            maxOutputBytes: cliConfig.maxOutputBytes,
            signal: grant.signal,
            onSpawn: (child) => grant.trackChild(child),
          })),
      });
    } catch (err) {
      throw new AgentPreflightError(
        this.diagnostic('agent-remote-service-failed', err instanceof Error ? err.message : String(err)),
      );
    }
    this.ready = { directLineSecret, services: acquired.services, release: acquired.release, policy, cli };
    this.studioSignalsTurnEnd = await this.readLearnedTurnEnd();
    log.info('copilot', 'ready', {
      profile: this.opts.profile,
      mcp: acquired.services.mcpUrl,
      publicUrl: this.opts.config.mcp.publicUrl ?? null,
      operations: policy.operations.map((op) => op.id),
      cliVia: cli.via,
    });
    const interval = this.opts.maintenanceIntervalMs ?? 60_000;
    if (interval > 0) {
      this.maintenanceTimer = setInterval(() => void this.maintainConversations(), interval);
      this.maintenanceTimer.unref?.();
    }
  }

  /** Stop the refresh loop and release the shared MCP listener. */
  async dispose(): Promise<void> {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    const ready = this.ready;
    this.ready = undefined;
    this.conversations.clear();
    await ready?.release();
  }

  async prepareRun(): Promise<void> {
    try {
      await this.start();
    } catch (err) {
      const availability = unavailable(err);
      if (availability.ok) return;
      throw new SpawnFailed(
        'copilot studio adapter not ready',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    const abort = new AbortController();
    const queue = new EventQueue<AgentEvent>();
    // One Copilot turn at a time per profile (on top of the bridge's per-scope
    // serialization): the MVP shares one execution registry and tool budget,
    // and nothing is gained by racing turns against one Studio agent.
    const previous = this.turnTail;
    let releaseTurn!: () => void;
    this.turnTail = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const done = (async () => {
      await untilSettledOrAborted(previous, abort.signal);
      await this.executeTurn(opts, abort.signal, queue);
    })()
      .catch((err) => {
        log.warn('copilot', 'turn-crashed', { runId: opts.runId, err: err instanceof Error ? err.message : String(err) });
        queue.push({ type: 'error', message: 'Copilot Studio 运行失败（bridge 内部错误）', terminationReason: 'failed' });
      })
      .finally(() => {
        releaseTurn();
        queue.end();
      });
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: queue.iterate(),
      async stop() {
        abort.abort();
        await Promise.race([done, delay(stopGraceMs)]);
      },
      async waitForExit(timeoutMs: number): Promise<boolean> {
        return Promise.race([done.then(() => true), delay(timeoutMs).then(() => false)]);
      },
    };
  }

  private async executeTurn(
    opts: AgentRunOptions,
    signal: AbortSignal,
    queue: EventQueue<AgentEvent>,
  ): Promise<void> {
    const ready = this.ready;
    const client = this.client;
    if (!ready || !client) {
      queue.push({
        type: 'error',
        message: 'Copilot Studio 尚未就绪（MCP 服务或密钥未初始化），请运行 /doctor 或检查 bridge 日志。',
        terminationReason: 'failed',
      });
      return;
    }
    if (signal.aborted) {
      // Stopped while still queued behind another turn: nothing was sent, so
      // the conversation stays healthy.
      queue.push({ type: 'done', terminationReason: 'interrupted' });
      return;
    }
    const cfg = this.opts.config;
    const startedAt = this.now();
    // turnTimeoutMs is an *idle* limit (no reply, typing or tool activity for
    // that long); a long multi-step turn that keeps working is capped here.
    const hardCapMs = Math.max(cfg.turnTimeoutMs * 5, 15 * 60_000);
    let handle: ExecutionHandle | undefined;
    let conversation: ConversationState | undefined;
    let outcome: CopilotTurnEndInfo['outcome'] = 'failed';
    let completedBy: CopilotTurnCompletion | undefined;
    let sawReply = false;
    let lastActivityAt = startedAt;

    try {
      const opened = await this.openConversation(opts.threadId, ready.directLineSecret, signal);
      conversation = opened.conversation;
      conversation.busy = true;
      if (opened.notice) queue.push({ type: 'text', delta: `${opened.notice}\n\n` });
      queue.push({ type: 'system', threadId: conversation.id });

      // Advance past anything already in the conversation (greetings, late
      // replies to an earlier turn) so it is never replayed into this run.
      const drained = await this.drain(client, conversation, signal);
      if (drained > 0) log.info('copilot', 'drained-stale-activities', { runId: opts.runId, count: drained });

      handle = ready.services.registry.register({
        runId: opts.runId,
        profile: this.opts.profile,
        accessMode: accessModeFor(opts.sandbox),
        ttlMs: hardCapMs + 30_000,
        maxCalls: cfg.mcp.maxCallsPerRun,
        emit: (event) => {
          lastActivityAt = this.now();
          queue.push(event);
        },
      });

      const clientActivityId = randomUUID();
      const text = buildStudioMessage({
        prompt: opts.prompt,
        executionToken: handle.token,
        completionMarker: cfg.completionMarker,
        maxChars: cfg.maxMessageChars,
      });
      const pending: DirectLineActivity[] = [];
      const ourActivityId = await this.postWithReconcile(client, conversation, text, clientActivityId, pending, signal);
      log.info('copilot', 'turn-posted', {
        runId: opts.runId,
        chars: text.length,
        resumed: Boolean(opts.threadId) && !opened.notice,
      });

      let completion: CopilotTurnCompletion | undefined;
      let firstMessage = true;
      let consentPending = false;
      const handleActivity = (activity: DirectLineActivity): void => {
        if (!conversation) return;
        if (activity.id) {
          if (conversation.seen.has(activity.id)) return;
          rememberSeen(conversation, activity.id);
        }
        if (activity.from?.id === this.userId) return; // our own echo
        if (activity.replyToId && ourActivityId && activity.replyToId !== ourActivityId) {
          log.info('copilot', 'late-activity-dropped', { runId: opts.runId, type: activity.type ?? null });
          return;
        }
        const shape = sanitizeActivity(activity, this.userId);
        log.info('copilot', 'activity', { runId: opts.runId, ...shape });
        this.opts.onActivity?.({ phase: 'turn', activity: shape });
        lastActivityAt = this.now();
        switch (activity.type) {
          case 'message': {
            // Studio's tool-connection consent cards (Allow / Cancel) cannot be
            // acted on from Lark; the awaitConsent event below explains instead.
            if (isConsentCard(activity)) {
              // Studio's own prompt wording (not user data), so the owner can
              // tell which Studio setting is asking for consent.
              log.warn('copilot', 'tool-consent-card', {
                runId: opts.runId,
                text: renderBotMessage(activity).slice(0, 400),
              });
              return;
            }
            const { text: body, found } = stripCompletionMarker(renderBotMessage(activity), cfg.completionMarker);
            if (body.trim()) {
              queue.push({ type: 'text', delta: firstMessage ? body : `\n\n${body}` });
              firstMessage = false;
              sawReply = true;
            }
            if (found) completion = 'marker';
            return;
          }
          case 'event':
            // Studio's own end-of-turn signal. It arrives after the reply in
            // activity order, so the final message has already been handled.
            if (activity.name === 'turn.complete') {
              completion ??= 'studio-event';
              if (!this.studioSignalsTurnEnd) {
                this.studioSignalsTurnEnd = true;
                void this.rememberLearnedTurnEnd();
              }
            }
            if (activity.name === 'turn.awaitConsent' && !consentPending) {
              consentPending = true;
              log.warn('copilot', 'tool-consent-requested', { runId: opts.runId });
              queue.push({ type: 'text', delta: `${firstMessage ? '' : '\n\n'}${CONSENT_NOTICE}` });
              firstMessage = false;
              sawReply = true;
            }
            return;
          case 'endOfConversation':
            completion = 'end-of-conversation';
            if (conversation) conversation.quarantined = 'end-of-conversation';
            return;
          default:
            // typing and other activities only prove the turn is still alive.
            return;
        }
      };

      for (const activity of pending) handleActivity(activity);
      while (!completion) {
        if (signal.aborted) throw new DirectLineError('aborted', 'aborted');
        const now = this.now();
        // A tool call still running (or waiting for owner approval) is activity.
        if (handle.inFlight() > 0) lastActivityAt = now;
        if (now - lastActivityAt >= cfg.turnTimeoutMs || now - startedAt >= hardCapMs) {
          outcome = 'timeout';
          break;
        }
        await this.sleep(cfg.pollIntervalMs, signal);
        await this.ensureFreshToken(client, conversation, signal);
        const set = await client.getActivities(conversation.token, conversation.id, conversation.watermark, signal);
        if (set.watermark !== undefined) conversation.watermark = set.watermark;
        for (const activity of set.activities) handleActivity(activity);
        // Degraded last resort, only for agents never seen sending turn.complete.
        if (
          !completion &&
          !this.studioSignalsTurnEnd &&
          sawReply &&
          handle.inFlight() === 0 &&
          this.now() - lastActivityAt >= cfg.quietWindowMs
        ) {
          completion = 'quiet-window';
        }
      }

      if (completion) {
        outcome = 'complete';
        completedBy = completion;
        log.info('copilot', 'turn-complete', {
          runId: opts.runId,
          completion,
          degraded: completion === 'quiet-window',
          durationMs: this.now() - startedAt,
        });
        if (!sawReply) {
          queue.push({ type: 'text', delta: '（Copilot Studio 本轮没有返回文字回复。）' });
        }
        queue.push({ type: 'done', threadId: conversation.id, terminationReason: 'normal' });
      } else {
        queue.push({
          type: 'error',
          message: `Copilot Studio 已 ${Math.round(cfg.turnTimeoutMs / 1000)} 秒没有任何回应（或本轮总时长超过上限），没有完成本轮回复，已停止等待。`,
          terminationReason: 'failed',
        });
      }
    } catch (err) {
      if (signal.aborted || (err instanceof DirectLineError && err.code === 'aborted')) {
        outcome = 'interrupted';
        queue.push({ type: 'done', ...(conversation ? { threadId: conversation.id } : {}), terminationReason: 'interrupted' });
      } else {
        outcome = 'failed';
        const message = describeTurnError(err);
        log.warn('copilot', 'turn-failed', {
          runId: opts.runId,
          code: err instanceof DirectLineError ? err.code : 'internal',
          status: err instanceof DirectLineError ? (err.status ?? null) : null,
        });
        queue.push({ type: 'error', message, terminationReason: 'failed' });
      }
    } finally {
      handle?.revoke(outcome === 'complete' ? 'turn-complete' : outcome);
      if (conversation) {
        conversation.busy = false;
        conversation.lastUsedAt = this.now();
        // Remote computation may continue after a stop/timeout, and nothing
        // tested yet can tell its late replies from the next turn's: replace
        // the conversation instead of risking cross-turn leakage.
        if (outcome !== 'complete' && !conversation.quarantined) conversation.quarantined = outcome;
      }
      await handle?.waitForChildren(5000);
      this.opts.onTurnEnd?.({
        runId: opts.runId,
        outcome,
        ...(completedBy ? { completion: completedBy } : {}),
        sawReply,
        durationMs: this.now() - startedAt,
      });
    }
  }

  private learnedStateFile(): string {
    return join(this.opts.profileDir, 'copilot-studio', 'learned.json');
  }

  private async readLearnedTurnEnd(): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(this.learnedStateFile(), 'utf8')) as { studioSignalsTurnEnd?: unknown };
      return raw.studioSignalsTurnEnd === true;
    } catch {
      return false;
    }
  }

  /** Persist the observation so a bridge restart does not fall back to the quiet window. */
  private async rememberLearnedTurnEnd(): Promise<void> {
    try {
      await mkdir(join(this.opts.profileDir, 'copilot-studio'), { recursive: true, mode: 0o700 });
      await writeFile(this.learnedStateFile(), `${JSON.stringify({ studioSignalsTurnEnd: true })}\n`, { mode: 0o600 });
    } catch (err) {
      log.warn('copilot', 'learned-state-write-failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Reuse a live in-memory conversation, or start a clearly announced new one. */
  private async openConversation(
    threadId: string | undefined,
    secret: string,
    signal: AbortSignal,
  ): Promise<{ conversation: ConversationState; notice?: string }> {
    const client = this.client!;
    let notice: string | undefined;
    if (threadId) {
      const existing = this.conversations.get(threadId);
      if (!existing) {
        notice = '（bridge 重启后无法接续之前的 Copilot Studio 会话，已开始新会话；之前的上下文不会带过来。）';
      } else if (existing.quarantined) {
        notice = '（上一轮 Copilot Studio 回复被中断或未正常结束，已开始新会话以免串话；之前的上下文不会带过来。）';
        this.conversations.delete(threadId);
      } else if (existing.busy) {
        throw new DirectLineError('protocol', 'conversation is already handling a turn');
      } else {
        try {
          await this.ensureFreshToken(client, existing, signal);
          return { conversation: existing };
        } catch (err) {
          if (!(err instanceof DirectLineError) || !err.conversationGone) throw err;
          this.conversations.delete(threadId);
          notice = '（之前的 Copilot Studio 会话已过期，已开始新会话；之前的上下文不会带过来。）';
        }
      }
    }
    const minted = await client.generateToken(secret, this.userId, signal);
    const started = await client.startConversation(minted.token, signal);
    const conversation: ConversationState = {
      id: started.conversationId,
      token: minted.token,
      tokenExpiresAt: this.now() + minted.expiresInSec * 1000,
      busy: false,
      lastUsedAt: this.now(),
      seen: new Set(),
    };
    this.conversations.set(conversation.id, conversation);
    this.evictExcessConversations();
    log.info('copilot', 'conversation-started', { replaced: Boolean(threadId) });
    return { conversation, ...(notice ? { notice } : {}) };
  }

  private async drain(client: DirectLineClient, conversation: ConversationState, signal: AbortSignal): Promise<number> {
    const set = await client.getActivities(conversation.token, conversation.id, conversation.watermark, signal);
    if (set.watermark !== undefined) conversation.watermark = set.watermark;
    let count = 0;
    for (const activity of set.activities) {
      if (activity.id) rememberSeen(conversation, activity.id);
      if (activity.from?.id !== this.userId) count++;
      this.opts.onActivity?.({ phase: 'drain', activity: sanitizeActivity(activity, this.userId) });
    }
    return count;
  }

  /**
   * POST the user message. A POST that failed ambiguously (timeout, network,
   * 5xx — Direct Line even returns 502 when the bot is slow) may already have
   * been accepted: look for our own echo by clientActivityID before resending
   * once. Activities read while reconciling are handed back via `pending`.
   */
  private async postWithReconcile(
    client: DirectLineClient,
    conversation: ConversationState,
    text: string,
    clientActivityId: string,
    pending: DirectLineActivity[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const activity = {
      type: 'message',
      from: { id: this.userId },
      text,
      textFormat: 'plain',
      channelData: { clientActivityID: clientActivityId },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const posted = await client.postActivity(conversation.token, conversation.id, activity, signal);
        return posted.id;
      } catch (err) {
        if (!(err instanceof DirectLineError)) throw err;
        const ambiguous = err.code === 'timeout' || err.code === 'network' || err.code === 'server';
        if (!ambiguous) throw err;
        log.warn('copilot', 'post-ambiguous', { code: err.code, status: err.status ?? null, attempt });
        const set = await client.getActivities(conversation.token, conversation.id, conversation.watermark, signal);
        if (set.watermark !== undefined) conversation.watermark = set.watermark;
        const echo = set.activities.find(
          (a) => a.from?.id === this.userId && a.channelData?.clientActivityID === clientActivityId,
        );
        pending.push(...set.activities);
        if (echo) return echo.id;
        if (attempt === 1) throw err;
      }
    }
    return undefined;
  }

  private async ensureFreshToken(
    client: DirectLineClient,
    conversation: ConversationState,
    signal: AbortSignal,
  ): Promise<void> {
    if (conversation.tokenExpiresAt - this.now() > TOKEN_REFRESH_MARGIN_MS) return;
    const refreshed = await client.refreshToken(conversation.token, signal);
    conversation.token = refreshed.token;
    conversation.tokenExpiresAt = this.now() + refreshed.expiresInSec * 1000;
  }

  /** Keep idle conversations' tokens fresh, independently of message polling. */
  private async maintainConversations(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const now = this.now();
    for (const [id, conversation] of this.conversations) {
      if (conversation.busy) continue;
      if (conversation.quarantined || now - conversation.lastUsedAt > CONVERSATION_IDLE_EVICT_MS) {
        this.conversations.delete(id);
        continue;
      }
      try {
        await this.ensureFreshToken(client, conversation, new AbortController().signal);
      } catch (err) {
        log.warn('copilot', 'token-refresh-failed', {
          code: err instanceof DirectLineError ? err.code : 'internal',
        });
        if (err instanceof DirectLineError && err.conversationGone) this.conversations.delete(id);
      }
    }
  }

  private evictExcessConversations(): void {
    if (this.conversations.size <= MAX_CONVERSATIONS) return;
    const idle = [...this.conversations.values()]
      .filter((c) => !c.busy)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const conversation of idle.slice(0, this.conversations.size - MAX_CONVERSATIONS)) {
      this.conversations.delete(conversation.id);
    }
  }

  private async validateConfig(): Promise<void> {
    if (this.clientError) throw new AgentPreflightError(this.diagnostic('agent-remote-config-invalid', this.clientError.message));
    try {
      assertTrustedDirectLineOrigin(this.opts.config.directLineBaseUrl, this.opts.trustedOriginsForTesting);
    } catch (err) {
      throw new AgentPreflightError(
        this.diagnostic('agent-remote-config-invalid', err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private async resolveSecret(input: CopilotSecretInput | undefined, label: string): Promise<string> {
    try {
      if (this.opts.resolveSecret) return await this.opts.resolveSecret(input, label);
      return await resolveCopilotSecret(input, label, this.opts.secrets, this.opts.keystorePaths);
    } catch (err) {
      throw new AgentPreflightError(
        this.diagnostic('agent-remote-secret-unavailable', err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private async resolveCli(): Promise<ResolvedLarkCli> {
    try {
      if (this.opts.resolveCli) return await this.opts.resolveCli();
      return await resolveLarkCliExecutable(this.opts.config.cli.binaryPath);
    } catch (err) {
      throw new AgentPreflightError(
        this.diagnostic('agent-tool-cli-not-found', err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private diagnostic(code: AgentPreflightDiagnostic['code'], detail: string): AgentPreflightDiagnostic {
    return {
      code,
      agentId: 'copilot-studio',
      agentName: 'Copilot Studio',
      command: 'copilot-studio',
      detail,
    };
  }
}

const CONSENT_NOTICE =
  '⚠️ Copilot Studio 在调用 lark-bridge 工具前请求“使用连接”的授权（Allow/Cancel 卡片），' +
  '这张卡片无法在飞书中点击，所以工具没有被调用。\n' +
  '请在 Copilot Studio 中打开该工具 → Credentials to use → 选择 Maker-provided credentials（使用你创建的连接），保存并重新发布后再试。';

/**
 * Consent prompts Studio sends before using a tool connection with end-user
 * credentials: an Adaptive Card whose actions are the Allow/Cancel pair. Only
 * cards that come with a `turn.awaitConsent` event are consent prompts; this
 * check just avoids echoing their raw button text into Lark.
 */
function isConsentCard(activity: DirectLineActivity): boolean {
  if (activity.text && activity.text.trim()) return false;
  const cards = (activity.attachments ?? []).filter(
    (a) => a.contentType === 'application/vnd.microsoft.card.adaptive',
  );
  if (cards.length === 0) return false;
  const json = JSON.stringify(cards.map((c) => c.content)).toLowerCase();
  return json.includes('consent') || (json.includes('"allow"') && json.includes('"cancel"'));
}

function unavailable(err: unknown): AgentAvailability {
  if (err instanceof AgentPreflightError) return { ok: false, error: err, diagnostic: err.diagnostic };
  const diagnostic: AgentPreflightDiagnostic = {
    code: 'agent-remote-config-invalid',
    agentId: 'copilot-studio',
    agentName: 'Copilot Studio',
    command: 'copilot-studio',
    detail: err instanceof Error ? err.message : String(err),
  };
  return { ok: false, error: new AgentPreflightError(diagnostic), diagnostic };
}

function accessModeFor(sandbox: AgentRunOptions['sandbox']): AccessMode {
  if (sandbox === 'danger-full-access') return 'full';
  if (sandbox === 'workspace-write') return 'workspace';
  return 'read-only';
}

function rememberSeen(conversation: ConversationState, id: string): void {
  conversation.seen.add(id);
  if (conversation.seen.size > MAX_SEEN_IDS) {
    const oldest = conversation.seen.values().next().value;
    if (oldest !== undefined) conversation.seen.delete(oldest);
  }
}

function describeTurnError(err: unknown): string {
  if (err instanceof DirectLineError) {
    switch (err.code) {
      case 'unauthorized':
      case 'forbidden':
        return 'Copilot Studio 拒绝了 Direct Line 凭证（HTTP 401/403）。请确认 web channel security 的 secret 仍然有效、未被轮换。';
      case 'not-found':
        return 'Copilot Studio 会话不存在或已过期，请重新发送消息（将开始新会话）。';
      case 'rate-limited':
        return 'Copilot Studio 请求过于频繁（HTTP 429），请稍后再试。';
      case 'timeout':
      case 'network':
        return `连接 Copilot Studio 失败（${err.code}），请检查网络或代理设置。`;
      case 'server':
        return `Copilot Studio 服务端错误（HTTP ${err.status ?? '5xx'}），请稍后再试。`;
      case 'untrusted-origin':
        return 'copilotStudio.directLineBaseUrl 不是受信任的 Direct Line 地址，已拒绝发送凭证。';
      default:
        return `Copilot Studio 返回了无法识别的响应（${err.code}）。`;
    }
  }
  return 'Copilot Studio 运行失败（bridge 内部错误），详见 bridge 日志。';
}

/** Wait for `previous` to settle, or return early once `signal` aborts. */
function untilSettledOrAborted(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Single-consumer async queue bridging the turn loop and `events`. */
class EventQueue<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    this.items.push(item);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  async *iterate(): AsyncGenerator<T> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }
}
