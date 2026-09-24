import type {
  AppCredentials,
  AppPreferences,
  MessageReplyMode,
  SecretInput,
  SecretsConfig,
} from './schema';
import {
  normalizePermissions,
  permissionsToLegacySandbox,
  type AccessMode,
  type CodexSandboxMode,
  type PermissionConfig,
  type PermissionSource,
} from './permissions';

export type AgentKind = 'claude' | 'codex' | 'copilot-studio';
export type SandboxMode = CodexSandboxMode;
export type { AccessMode, PermissionConfig, PermissionSource };

export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'copilot-studio'];

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);
}

/** Human-facing agent name for a profile's agent kind. */
export function agentKindDisplayName(kind: AgentKind): string {
  switch (kind) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex CLI';
    case 'copilot-studio':
      return 'Copilot Studio';
  }
}

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
  /**
   * Per-chat override of {@link requireMentionInGroup}, keyed by chat_id.
   * `true` = require an @-mention in that chat, `false` = respond to every
   * message. A chat absent from the map follows the global setting. Takes
   * priority over `requireMentionInGroup` for the chats it lists.
   */
  chatRequireMention?: Record<string, boolean>;
}

export interface SandboxConfig {
  default?: SandboxMode;
  max?: SandboxMode;
  defaultMode: SandboxMode;
  maxMode: SandboxMode;
}

export interface CodexConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

/**
 * Secret reference stored in the profile's encrypted keystore
 * (`profiles/<name>/secrets.enc`). Bridge-only: lark-cli never reads the
 * `copilotStudio` section, so this does not need to match lark-cli's
 * SecretRef union.
 */
export interface KeystoreSecretRef {
  source: 'keystore';
  id: string;
}

/**
 * Copilot Studio secrets. Plaintext strings are rejected at resolve time —
 * only `${ENV}` templates, env/file/exec SecretRefs and keystore refs.
 */
export type CopilotSecretInput = SecretInput | KeystoreSecretRef;

export interface CopilotStudioMcpConfig {
  /** Local listener address. Loopback by default; expose only via a tunnel. */
  bindHost: string;
  port: number;
  /** Route that serves MCP; everything else (except /healthz) is 404. */
  path: string;
  /** User-provided public HTTPS URL configured in Copilot Studio (display only). */
  publicUrl?: string;
  /** Independent secret the Studio MCP connection sends as an API key. */
  authSecret?: CopilotSecretInput;
  /** Header Studio sends the API key in. `Authorization: Bearer` is also accepted. */
  authHeader: string;
  /** Browser origins allowed to call MCP. Empty = reject any request with an Origin header. */
  allowedOrigins: string[];
  /** Max tool calls one execution token may make. */
  maxCallsPerRun: number;
}

/**
 * - `read-only`: only the curated built-in read operations (default).
 * - `full`: any lark-cli command except auth/config/profile/update/api and
 *   identity overrides; commands lark-cli marks high-risk (and anything that
 *   deletes/removes/recalls/reverts/transfers) need the owner's approval in Lark.
 */
export type CopilotCliMode = 'read-only' | 'full';

export interface CopilotStudioCliConfig {
  mode: CopilotCliMode;
  /** How long a high-risk command waits for /approve before it is rejected. */
  approvalTimeoutMs: number;
  /** Native lark-cli executable. Resolved locally; never chosen by the model. */
  binaryPath?: string;
  /**
   * Built-in operation ids enabled for this profile (see
   * agent/copilot-studio/cli-policy.ts). Absent = every built-in operation.
   * Config can only narrow the built-in set, never add operations.
   */
  allowedOperations?: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface CopilotStudioConfig {
  directLineBaseUrl: string;
  directLineSecret?: CopilotSecretInput;
  pollIntervalMs: number;
  /** Overall per-turn deadline. */
  turnTimeoutMs: number;
  /**
   * Degraded completion: with no explicit end-of-turn signal, finish once a
   * reply has arrived, no tool call is in flight and the conversation has
   * been silent this long. See docs/copilot-studio.md.
   */
  quietWindowMs: number;
  /**
   * Exact text the published Studio instructions tell the agent to put at
   * the end of its final reply. Stripped before rendering. Empty disables
   * marker-based completion (quiet window only).
   */
  completionMarker: string;
  /** Upper bound on the text sent to Studio per turn. */
  maxMessageChars: number;
  mcp: CopilotStudioMcpConfig;
  cli: CopilotStudioCliConfig;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

export type CommentConfig = Record<string, never>;

/** Where the agent's answer goes when it responds to meeting content. */
export type MeetingRespondIn = 'meeting' | 'im' | 'both';

/**
 * Where the end-of-meeting summary is delivered.
 *  - `origin`: the chat the bot was told to join from (`/meeting join` there).
 *  - `owner`: the bot owner's direct message.
 * Either way the other one is used as a fallback, so a summary is never
 * silently dropped just because the preferred target isn't available (a
 * console-initiated join has no origin chat; an unresolved owner has no DM).
 */
export type MeetingSummaryTarget = 'origin' | 'owner';

/**
 * In-meeting agent ("智能体入会", path 2 / TAT): the bot joins a Feishu meeting
 * as a real participant, receives in-meeting activity (transcript, chat,
 * participants, doc shares) and can answer in the meeting or over IM.
 *
 * Off by default — the capability is gated by a Feishu allowlist plus the
 * `vc:meeting.bot.join:write` scope, so it must be opted into per profile.
 */
export interface MeetingConfig {
  enabled: boolean;
  /** Auto-join when the bot is invited (needs `vc.bot.meeting_invited_v1` push). */
  autoJoinOnInvite: boolean;
  transcript: {
    /** Rolling transcript lines kept as agent context. */
    keep: number;
    /** Debounce window (ms) before a sentence counts as final; 0 = emit every update. */
    stabilizeMs: number;
  };
  /** Where answers go. */
  respondIn: MeetingRespondIn;
  /**
   * Extra prefix that makes an in-meeting chat message a question for the agent.
   * `@<bot 当前名字>` is always accepted on top of this, so the natural thing to
   * type works without configuring anything.
   */
  trigger: string;
  /** Base interval for the `bots/events` poller (idle rounds back off). */
  pollIntervalMs: number;
  /** Summarize the meeting to IM when it ends. */
  summaryOnEnd: boolean;
  /** Preferred destination for that summary. See {@link MeetingSummaryTarget}. */
  summaryTarget: MeetingSummaryTarget;
}

export type LarkCliIdentityPreset = 'bot-only' | 'user-default';

/**
 * Deployment mode — a single switch that binds two behaviors together
 * (see the "团队版 Bot 权限调整" spec):
 *   - `personal` (default, the status quo): only owner + allowlisted
 *     users/chats can use the bot; the CLI may carry owner's personal (user)
 *     authorization per {@link LarkCliConfig.identityPreset}.
 *   - `team`: anyone can @-use the bot (no allowlist gating), and the CLI is
 *     forced to `bot-only` so it never carries owner's personal authorization.
 *
 * The two behaviors are intentionally bound to one switch, not two configs.
 * Admin/sensitive commands stay owner/admin-gated in both modes.
 */
export type ProfileMode = 'personal' | 'team';

export type LarkCliUserImportStatus =
  | 'not-needed'
  | 'imported'
  | 'skipped-existing-private-user'
  | 'skipped-no-local-user'
  | 'failed';

export interface LarkCliConfig {
  identityPreset: LarkCliIdentityPreset;
  localUserImport?: {
    status: LarkCliUserImportStatus;
    attemptedAt?: string;
    importedAt?: string;
    reason?: string;
  };
}

export interface ProfileConfig {
  schemaVersion: 2;
  agentKind: AgentKind;
  /** Deployment mode switch. Default 'personal'. See {@link ProfileMode}. */
  mode: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  access: ProfileAccess;
  workspaces: {
    default?: string;
  };
  sandbox: SandboxConfig;
  permissions: PermissionConfig;
  permissionSource?: PermissionSource;
  codex?: CodexConfig;
  /** Present for (and only meaningful to) `agentKind: 'copilot-studio'`. */
  copilotStudio?: CopilotStudioConfig;
  attachments: AttachmentConfig;
  comments: CommentConfig;
  /** In-meeting agent settings. See {@link MeetingConfig}. */
  meeting: MeetingConfig;
  larkCli: LarkCliConfig;
}

/**
 * The lark-cli identity preset that actually takes effect, after applying the
 * deployment-mode override. Team mode forces `bot-only` regardless of the
 * user's stored {@link LarkCliConfig.identityPreset} (which is preserved so it
 * comes back into effect when switching back to personal mode). This is the
 * single source of truth for "team mode forces bot-only" — every place that
 * applies the lark-cli identity policy should read through here.
 */
export function effectiveLarkCliIdentity(
  profile: Pick<ProfileConfig, 'mode' | 'larkCli'>,
): LarkCliIdentityPreset {
  return profile.mode === 'team' ? 'bot-only' : profile.larkCli.identityPreset;
}

export interface RootConfig {
  schemaVersion: 2;
  activeProfile: string;
  preferences: Record<string, never>;
  secrets?: SecretsConfig;
  migrations?: {
    permissionDefaultsV1?: string[];
  };
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  agentKind: AgentKind;
  /** Deployment mode. Default 'personal'. */
  mode?: ProfileMode;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  sandbox?: Partial<SandboxConfig>;
  permissions?: Partial<PermissionConfig>;
  codex?: CodexConfig;
  copilotStudio?: Partial<CopilotStudioConfig>;
  secrets?: SecretsConfig;
}

export function createDefaultProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input,
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    schemaVersion?: unknown;
    agentKind?: unknown;
    mode?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    preferences?: (AppPreferences & { access?: Partial<ProfileAccess> }) | undefined;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
      // Legacy workspace authorization fields are accepted for config
      // compatibility only; normalizeWorkspaces drops them.
      trusted?: unknown;
      trustedRoots?: unknown;
      riskFlags?: unknown;
    };
    sandbox?: Partial<SandboxConfig>;
    permissions?: Partial<PermissionConfig>;
    codex?: CodexConfig & { flags?: unknown };
    copilotStudio?: unknown;
    attachments?: Partial<AttachmentConfig>;
    comments?: unknown;
    meeting?: unknown;
    larkCli?: unknown;
  };

  if (raw.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2');
  }
  if (!isAgentKind(raw.agentKind)) {
    throw new Error(
      `agentKind must be one of ${AGENT_KINDS.join(', ')} (got ${JSON.stringify(raw.agentKind)})`,
    );
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === 'codex' && !raw.codex) {
    throw new Error('codex profile requires codex configuration');
  }

  const preferences = normalizePreferences(raw.preferences);
  const access = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup,
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions: raw.permissions,
    sandbox: raw.sandbox,
    // Copilot Studio only executes an explicit read-only lark-cli policy, so a
    // fresh profile starts (and is capped) at read-only; see capability.ts.
    ...(raw.agentKind === 'copilot-studio' && raw.permissions === undefined && !raw.sandbox
      ? { permissions: { defaultAccess: 'read-only', maxAccess: 'read-only' } }
      : {}),
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const meeting = normalizeMeeting(raw.meeting);
  const larkCli = normalizeLarkCli(raw.larkCli);

  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    mode: raw.mode === 'team' ? 'team' : 'personal',
    accounts,
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    preferences,
    access,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    ...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {}),
    ...(raw.agentKind === 'copilot-studio' || raw.copilotStudio !== undefined
      ? { copilotStudio: normalizeCopilotStudio(raw.copilotStudio) }
      : {}),
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    comments,
    meeting,
    larkCli,
  };
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials> };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
  };
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    ...rest
  } = preferences ?? {};
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...rest,
      messageReply,
    };
  }
  return rest;
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function normalizeAccess(
  access: Partial<ProfileAccess> | undefined,
  legacyRequireMentionInGroup: boolean | undefined,
): ProfileAccess {
  const chatRequireMention = normalizeChatMentionMap(access?.chatRequireMention);
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true,
    // Omit when empty so configs without per-chat overrides stay clean.
    ...(Object.keys(chatRequireMention).length > 0 ? { chatRequireMention } : {}),
  };
}

/** Keep only string→boolean entries; drop anything malformed. */
function normalizeChatMentionMap(input: unknown): Record<string, boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, boolean> = {};
  for (const [chatId, value] of Object.entries(input as Record<string, unknown>)) {
    if (chatId && typeof value === 'boolean') out[chatId] = value;
  }
  return out;
}

function normalizeWorkspaces(input: {
  default?: unknown;
  trusted?: unknown;
  trustedRoots?: unknown;
  riskFlags?: unknown;
} | undefined): ProfileConfig['workspaces'] {
  const defaultWorkspace = typeof input?.default === 'string' && input.default.trim()
    ? input.default.trim()
    : undefined;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}

function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
  const codex: CodexConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: input.ignoreUserConfig === true,
    ignoreRules: input.ignoreRules !== false,
  };
  return codex;
}

export const COPILOT_STUDIO_DEFAULTS = {
  directLineBaseUrl: 'https://directline.botframework.com',
  pollIntervalMs: 1000,
  turnTimeoutMs: 180_000,
  quietWindowMs: 8000,
  completionMarker: '[[turn-complete]]',
  maxMessageChars: 24_000,
  mcp: {
    bindHost: '127.0.0.1',
    port: 47_821,
    path: '/mcp',
    authHeader: 'x-api-key',
    maxCallsPerRun: 25,
  },
  cli: {
    mode: 'read-only',
    approvalTimeoutMs: 120_000,
    timeoutMs: 60_000,
    maxOutputBytes: 256 * 1024,
  },
} as const;

function normalizeCopilotStudio(input: unknown): CopilotStudioConfig {
  const raw = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as {
    directLineBaseUrl?: unknown;
    directLineSecret?: unknown;
    pollIntervalMs?: unknown;
    turnTimeoutMs?: unknown;
    quietWindowMs?: unknown;
    completionMarker?: unknown;
    maxMessageChars?: unknown;
    mcp?: unknown;
    cli?: unknown;
  };
  const mcp = (raw.mcp && typeof raw.mcp === 'object' && !Array.isArray(raw.mcp) ? raw.mcp : {}) as {
    bindHost?: unknown;
    port?: unknown;
    path?: unknown;
    publicUrl?: unknown;
    authSecret?: unknown;
    authHeader?: unknown;
    allowedOrigins?: unknown;
    maxCallsPerRun?: unknown;
  };
  const cli = (raw.cli && typeof raw.cli === 'object' && !Array.isArray(raw.cli) ? raw.cli : {}) as {
    mode?: unknown;
    approvalTimeoutMs?: unknown;
    binaryPath?: unknown;
    allowedOperations?: unknown;
    timeoutMs?: unknown;
    maxOutputBytes?: unknown;
  };
  const d = COPILOT_STUDIO_DEFAULTS;
  const directLineSecret = copilotSecretOrUndefined(raw.directLineSecret);
  const authSecret = copilotSecretOrUndefined(mcp.authSecret);
  const mcpPath = typeof mcp.path === 'string' && /^\/[A-Za-z0-9._~/-]*$/.test(mcp.path) ? mcp.path : d.mcp.path;
  const authHeader =
    typeof mcp.authHeader === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(mcp.authHeader)
      ? mcp.authHeader.toLowerCase()
      : d.mcp.authHeader;
  return {
    directLineBaseUrl: nonEmptyString(raw.directLineBaseUrl) ?? d.directLineBaseUrl,
    ...(directLineSecret ? { directLineSecret } : {}),
    pollIntervalMs: clampNumber(raw.pollIntervalMs, 250, 10_000, d.pollIntervalMs),
    turnTimeoutMs: clampNumber(raw.turnTimeoutMs, 10_000, 30 * 60_000, d.turnTimeoutMs),
    quietWindowMs: clampNumber(raw.quietWindowMs, 1000, 120_000, d.quietWindowMs),
    completionMarker:
      typeof raw.completionMarker === 'string' ? raw.completionMarker.trim() : d.completionMarker,
    maxMessageChars: clampNumber(raw.maxMessageChars, 1000, 200_000, d.maxMessageChars),
    mcp: {
      bindHost: nonEmptyString(mcp.bindHost) ?? d.mcp.bindHost,
      port: clampNumber(mcp.port, 1, 65_535, d.mcp.port),
      path: mcpPath,
      ...(nonEmptyString(mcp.publicUrl) ? { publicUrl: nonEmptyString(mcp.publicUrl) } : {}),
      ...(authSecret ? { authSecret } : {}),
      authHeader,
      allowedOrigins: stringArray(mcp.allowedOrigins),
      maxCallsPerRun: clampNumber(mcp.maxCallsPerRun, 1, 500, d.mcp.maxCallsPerRun),
    },
    cli: {
      mode: cli.mode === 'full' ? 'full' : 'read-only',
      approvalTimeoutMs: clampNumber(cli.approvalTimeoutMs, 15_000, 10 * 60_000, d.cli.approvalTimeoutMs),
      ...(nonEmptyString(cli.binaryPath) ? { binaryPath: nonEmptyString(cli.binaryPath) } : {}),
      ...(Array.isArray(cli.allowedOperations)
        ? { allowedOperations: stringArray(cli.allowedOperations) }
        : {}),
      timeoutMs: clampNumber(cli.timeoutMs, 1000, 10 * 60_000, d.cli.timeoutMs),
      maxOutputBytes: clampNumber(cli.maxOutputBytes, 1024, 8 * 1024 * 1024, d.cli.maxOutputBytes),
    },
  };
}

/** Keep structurally valid secret inputs; the resolver decides what is allowed. */
function copilotSecretOrUndefined(value: unknown): CopilotSecretInput | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const ref = value as { source?: unknown; id?: unknown; provider?: unknown };
  if (typeof ref.id !== 'string' || !ref.id) return undefined;
  if (ref.source === 'keystore') return { source: 'keystore', id: ref.id };
  if (ref.source === 'env' || ref.source === 'file' || ref.source === 'exec') {
    return {
      source: ref.source,
      id: ref.id,
      ...(typeof ref.provider === 'string' ? { provider: ref.provider } : {}),
    };
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeComments(_input: unknown): CommentConfig {
  return {};
}

/** Defaults keep the in-meeting agent off until a profile opts in. */
export const MEETING_DEFAULTS: MeetingConfig = {
  enabled: false,
  autoJoinOnInvite: false,
  transcript: { keep: 200, stabilizeMs: 0 },
  respondIn: 'meeting',
  trigger: '@bot',
  pollIntervalMs: 3000,
  summaryOnEnd: false,
  summaryTarget: 'origin',
};

function normalizeMeeting(input: unknown): MeetingConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as {
    enabled?: unknown;
    autoJoinOnInvite?: unknown;
    transcript?: { keep?: unknown; stabilizeMs?: unknown };
    respondIn?: unknown;
    trigger?: unknown;
    pollIntervalMs?: unknown;
    summaryOnEnd?: unknown;
    summaryTarget?: unknown;
  };
  const trigger = typeof raw.trigger === 'string' && raw.trigger.trim() ? raw.trigger.trim() : MEETING_DEFAULTS.trigger;
  return {
    enabled: raw.enabled === true,
    autoJoinOnInvite: raw.autoJoinOnInvite === true,
    transcript: {
      keep: clampNumber(raw.transcript?.keep, 10, 2000, MEETING_DEFAULTS.transcript.keep),
      // 0 is meaningful here ("no debounce"), so it can't go through numberOr.
      stabilizeMs: clampNumber(raw.transcript?.stabilizeMs, 0, 30_000, MEETING_DEFAULTS.transcript.stabilizeMs),
    },
    respondIn:
      raw.respondIn === 'im' || raw.respondIn === 'both' || raw.respondIn === 'meeting'
        ? raw.respondIn
        : MEETING_DEFAULTS.respondIn,
    trigger,
    pollIntervalMs: clampNumber(raw.pollIntervalMs, 1000, 60_000, MEETING_DEFAULTS.pollIntervalMs),
    summaryOnEnd: raw.summaryOnEnd === true,
    summaryTarget:
      raw.summaryTarget === 'owner' || raw.summaryTarget === 'origin'
        ? raw.summaryTarget
        : MEETING_DEFAULTS.summaryTarget,
  };
}

/** Like {@link numberOr} but keeps 0 and bounds the result. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeLarkCli(input: unknown): LarkCliConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { identityPreset: 'bot-only' };
  }
  const raw = input as {
    identityPreset?: unknown;
    localUserImport?: unknown;
  };
  const identityPreset: LarkCliIdentityPreset =
    raw.identityPreset === 'user-default' ? 'user-default' : 'bot-only';
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...(localUserImport ? { localUserImport } : {}),
  };
}

function normalizeLarkCliUserImport(input: unknown): LarkCliConfig['localUserImport'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as {
    status?: unknown;
    attemptedAt?: unknown;
    importedAt?: unknown;
    reason?: unknown;
  };
  if (!isLarkCliUserImportStatus(raw.status)) return undefined;
  return {
    status: raw.status,
    ...(typeof raw.attemptedAt === 'string' ? { attemptedAt: raw.attemptedAt } : {}),
    ...(typeof raw.importedAt === 'string' ? { importedAt: raw.importedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isLarkCliUserImportStatus(value: unknown): value is LarkCliUserImportStatus {
  return (
    value === 'not-needed' ||
    value === 'imported' ||
    value === 'skipped-existing-private-user' ||
    value === 'skipped-no-local-user' ||
    value === 'failed'
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
