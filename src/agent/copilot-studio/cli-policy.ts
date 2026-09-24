import type { AccessMode } from '../../config/permissions';

/**
 * lark-cli command policy for the Copilot Studio MCP tool.
 *
 * Studio (a remote model) proposes an argument array; this module decides
 * whether that exact array may run. Everything is allowlisted: the command
 * path, every flag, flag value shapes, and repetition. Operation names and
 * flags were taken from the installed CLI's own `--help` (lark-cli 1.0.96);
 * re-check them with `lark-cli <domain> <cmd> --help` when upgrading.
 *
 * Deliberately never allowed, on any operation:
 *   --as        identity override (identity comes from the profile projection)
 *   --profile   profile / credential selection
 *   --jq / -q   gojq can read `$ENV`/`env`, i.e. the CLI process environment
 *   --download-resources, --output, file paths: no local filesystem writes
 *   auth / config / profile / update / api / event subcommands
 */

export type FlagSpec =
  | { kind: 'bool' }
  | { kind: 'string'; repeatable?: boolean }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'enum'; values: readonly string[] };

export type OperationRisk = 'read' | 'write';

export interface CliOperation {
  id: string;
  command: readonly string[];
  risk: OperationRisk;
  summary: string;
  flags: Readonly<Record<string, FlagSpec>>;
}

const FORMAT_FLAGS: Record<string, FlagSpec> = {
  '--format': { kind: 'enum', values: ['json', 'pretty', 'table', 'ndjson', 'csv'] },
  '--json': { kind: 'bool' },
  '--dry-run': { kind: 'bool' },
};

const TIME_RANGE: Record<string, FlagSpec> = {
  '--start': { kind: 'string' },
  '--end': { kind: 'string' },
};

export const BUILTIN_CLI_OPERATIONS: readonly CliOperation[] = [
  {
    id: 'whoami',
    command: ['whoami'],
    risk: 'read',
    summary: 'Show the effective lark-cli identity, app and token status (JSON).',
    flags: {},
  },
  {
    id: 'calendar.agenda',
    command: ['calendar', '+agenda'],
    risk: 'read',
    summary: 'Calendar agenda (defaults to today). Times are ISO 8601.',
    flags: { ...FORMAT_FLAGS, ...TIME_RANGE, '--calendar-id': { kind: 'string' } },
  },
  {
    id: 'calendar.freebusy',
    command: ['calendar', '+freebusy'],
    risk: 'read',
    summary: 'Free/busy for one or more users (default: current user).',
    flags: {
      ...FORMAT_FLAGS,
      ...TIME_RANGE,
      '--type': { kind: 'enum', values: ['busy', 'raw_busy', 'free', 'common_free'] },
      '--min-duration': { kind: 'string' },
      '--user-id': { kind: 'string', repeatable: true },
    },
  },
  {
    id: 'contact.get-user',
    command: ['contact', '+get-user'],
    risk: 'read',
    summary: 'User info (omit --user-id for the current identity).',
    flags: {
      ...FORMAT_FLAGS,
      '--user-id': { kind: 'string' },
      '--user-id-type': { kind: 'enum', values: ['open_id', 'union_id', 'user_id'] },
    },
  },
  {
    id: 'im.chat-messages-list',
    command: ['im', '+chat-messages-list'],
    risk: 'read',
    summary: 'List messages in a chat (--chat-id oc_...) or p2p (--user-id ou_...).',
    flags: {
      ...FORMAT_FLAGS,
      ...TIME_RANGE,
      '--chat-id': { kind: 'string' },
      '--user-id': { kind: 'string' },
      '--order': { kind: 'enum', values: ['asc', 'desc'] },
      '--page-size': { kind: 'int', min: 1, max: 50 },
      '--page-token': { kind: 'string' },
      '--concise': { kind: 'bool' },
      '--no-reactions': { kind: 'bool' },
    },
  },
  {
    id: 'im.messages-search',
    command: ['im', '+messages-search'],
    risk: 'read',
    summary: 'Search messages across chats by keyword, sender, chat and time range.',
    flags: {
      ...FORMAT_FLAGS,
      ...TIME_RANGE,
      '--query': { kind: 'string' },
      '--chat-id': { kind: 'string' },
      '--chat-type': { kind: 'enum', values: ['group', 'p2p'] },
      '--sender': { kind: 'string' },
      '--sender-type': { kind: 'enum', values: ['user', 'bot'] },
      '--exclude-sender-type': { kind: 'enum', values: ['user', 'bot'] },
      '--is-at-me': { kind: 'bool' },
      '--include-attachment-type': { kind: 'enum', values: ['file', 'image', 'video', 'link'] },
      '--at-chatter-ids': { kind: 'string' },
      '--page-size': { kind: 'int', min: 1, max: 50 },
      '--page-token': { kind: 'string' },
      '--no-reactions': { kind: 'bool' },
    },
  },
  {
    id: 'docs.fetch',
    command: ['docs', '+fetch'],
    risk: 'read',
    summary: 'Fetch a Lark document by URL or token (--doc).',
    flags: {
      '--dry-run': { kind: 'bool' },
      '--doc': { kind: 'string' },
      '--scope': { kind: 'enum', values: ['full', 'outline', 'range', 'keyword', 'section'] },
      '--detail': { kind: 'enum', values: ['simple', 'with-ids', 'full'] },
      '--doc-format': { kind: 'enum', values: ['xml', 'markdown', 'im-markdown'] },
      '--keyword': { kind: 'string' },
      '--max-depth': { kind: 'int', min: -1, max: 100 },
      '--start-block-id': { kind: 'string' },
      '--end-block-id': { kind: 'string' },
      '--context-before': { kind: 'int', min: 0, max: 100 },
      '--context-after': { kind: 'int', min: 0, max: 100 },
      '--revision-id': { kind: 'int', min: -1, max: Number.MAX_SAFE_INTEGER },
      '--lang': { kind: 'string' },
    },
  },
  {
    id: 'docs.search',
    command: ['docs', '+search'],
    risk: 'read',
    summary: 'Search Lark docs, Wiki and spreadsheets (user identity only).',
    flags: {
      ...FORMAT_FLAGS,
      '--query': { kind: 'string' },
      '--filter': { kind: 'string' },
      '--page-size': { kind: 'int', min: 1, max: 20 },
      '--page-token': { kind: 'string' },
    },
  },
  {
    id: 'task.get-my-tasks',
    command: ['task', '+get-my-tasks'],
    risk: 'read',
    summary: 'List tasks assigned to the current user (user identity only).',
    flags: {
      ...FORMAT_FLAGS,
      '--complete': { kind: 'bool' },
      '--query': { kind: 'string' },
      '--created_at': { kind: 'string' },
      '--due-start': { kind: 'string' },
      '--due-end': { kind: 'string' },
      '--page-limit': { kind: 'int', min: 1, max: 20 },
      '--page-token': { kind: 'string' },
    },
  },
];

/** Flags rejected with a specific reason, whatever the operation declares. */
const ALWAYS_BLOCKED_FLAGS: Readonly<Record<string, string>> = {
  '--as': 'identity overrides are not allowed; the profile decides the identity',
  '--profile': 'profile selection is not allowed',
  '--jq': '--jq is not allowed (jq can read the process environment); filter the JSON yourself',
  '-q': '--jq is not allowed (jq can read the process environment); filter the JSON yourself',
  '--download-resources': 'downloads to the local filesystem are not allowed',
  '--output': 'writing local files is not allowed',
  '--page-all': 'automatic pagination is not allowed; page with --page-token',
};

const MAX_ARGS = 64;
const MAX_ARG_CHARS = 4000;
// Control characters (incl. newline) never belong in a lark-cli argument
// this policy allows; they are also how argument smuggling usually starts.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface CliPolicy {
  operations: readonly CliOperation[];
}

export type CliPolicyDecision =
  /** `args` is the canonical form actually executed: flags as `--flag=value`. */
  | { ok: true; operation: CliOperation; args: string[] }
  | { ok: false; code: CliPolicyRejectCode; message: string };

export type CliPolicyRejectCode =
  | 'invalid-args'
  | 'unknown-operation'
  | 'operation-not-enabled'
  | 'access-denied'
  | 'flag-not-allowed'
  | 'invalid-flag-value'
  | 'unexpected-positional';

/**
 * Build the effective policy. `allowedOperations` can only narrow the
 * built-in set: unknown ids are reported and ignored, never added.
 */
export function createCliPolicy(allowedOperations: readonly string[] | undefined): {
  policy: CliPolicy;
  unknownOperationIds: string[];
} {
  if (!allowedOperations) return { policy: { operations: BUILTIN_CLI_OPERATIONS }, unknownOperationIds: [] };
  const wanted = new Set(allowedOperations);
  const known = new Set(BUILTIN_CLI_OPERATIONS.map((op) => op.id));
  return {
    policy: { operations: BUILTIN_CLI_OPERATIONS.filter((op) => wanted.has(op.id)) },
    unknownOperationIds: [...wanted].filter((id) => !known.has(id)),
  };
}

export function evaluateCliArgs(
  policy: CliPolicy,
  rawArgs: unknown,
  accessMode: AccessMode,
): CliPolicyDecision {
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
    return deny('invalid-args', 'args must be a non-empty array of strings');
  }
  if (rawArgs.length > MAX_ARGS) return deny('invalid-args', `at most ${MAX_ARGS} args are allowed`);
  const args: string[] = [];
  for (const arg of rawArgs) {
    if (typeof arg !== 'string') return deny('invalid-args', 'every arg must be a string');
    if (arg.length > MAX_ARG_CHARS) return deny('invalid-args', `args are limited to ${MAX_ARG_CHARS} characters`);
    if (CONTROL_CHARS.test(arg)) return deny('invalid-args', 'args must not contain control characters');
    args.push(arg);
  }

  const operation = matchOperation(BUILTIN_CLI_OPERATIONS, args);
  if (!operation) {
    return deny(
      'unknown-operation',
      `not an allowed lark-cli operation: ${args.slice(0, 2).join(' ')}. ` +
        'Call list_lark_cli_operations for the supported commands.',
    );
  }
  if (!policy.operations.includes(operation)) {
    return deny('operation-not-enabled', `operation ${operation.id} is not enabled for this profile`);
  }
  if (operation.risk !== 'read' && accessMode === 'read-only') {
    return deny('access-denied', `operation ${operation.id} writes data and this run is read-only`);
  }

  const seen = new Set<string>();
  const canonical: string[] = [...operation.command];
  const rest = args.slice(operation.command.length);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('-')) {
      return deny('unexpected-positional', `unexpected positional argument: ${truncate(token)}`);
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
    const blocked = ALWAYS_BLOCKED_FLAGS[name];
    if (blocked) return deny('flag-not-allowed', `${name}: ${blocked}`);
    const spec = operation.flags[name];
    if (!spec) {
      return deny('flag-not-allowed', `flag ${truncate(name)} is not allowed for ${operation.id}`);
    }
    const repeatable = spec.kind === 'string' && spec.repeatable === true;
    if (seen.has(name) && !repeatable) {
      return deny('invalid-flag-value', `flag ${name} may only be given once`);
    }
    seen.add(name);

    if (spec.kind === 'bool') {
      if (inlineValue !== undefined && inlineValue !== 'true' && inlineValue !== 'false') {
        return deny('invalid-flag-value', `${name} is a boolean flag (true or false)`);
      }
      canonical.push(inlineValue === 'false' ? `${name}=false` : name);
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = rest[i + 1];
      if (next === undefined) return deny('invalid-flag-value', `${name} requires a value`);
      value = next;
      i++;
    }
    const valueError = checkValue(name, spec, value);
    if (valueError) return deny('invalid-flag-value', valueError);
    // Always pass values inline so the CLI's flag parser can never read a
    // value as a separate flag (or vice versa).
    canonical.push(`${name}=${value}`);
  }

  return { ok: true, operation, args: canonical };
}

function matchOperation(operations: readonly CliOperation[], args: string[]): CliOperation | undefined {
  let best: CliOperation | undefined;
  for (const op of operations) {
    if (op.command.length > args.length) continue;
    if (!op.command.every((part, idx) => args[idx] === part)) continue;
    if (!best || op.command.length > best.command.length) best = op;
  }
  return best;
}

function checkValue(name: string, spec: FlagSpec, value: string): string | undefined {
  switch (spec.kind) {
    case 'string':
      if (value.startsWith('-')) return `${name} value must not start with "-"`;
      if (value.length === 0) return `${name} value must not be empty`;
      return undefined;
    case 'int': {
      if (!/^-?\d{1,16}$/.test(value)) return `${name} must be an integer`;
      const n = Number(value);
      if (n < spec.min || n > spec.max) return `${name} must be between ${spec.min} and ${spec.max}`;
      return undefined;
    }
    case 'enum':
      return spec.values.includes(value) ? undefined : `${name} must be one of ${spec.values.join(', ')}`;
    case 'bool':
      return undefined;
  }
}

/** Compact, model-facing description of what the policy allows. */
export function describeCliPolicy(policy: CliPolicy): Array<{
  id: string;
  command: string;
  risk: OperationRisk;
  summary: string;
  flags: string[];
}> {
  return policy.operations.map((op) => ({
    id: op.id,
    command: op.command.join(' '),
    risk: op.risk,
    summary: op.summary,
    flags: Object.entries(op.flags).map(([flag, spec]) => describeFlag(flag, spec)),
  }));
}

function describeFlag(flag: string, spec: FlagSpec): string {
  switch (spec.kind) {
    case 'bool':
      return flag;
    case 'string':
      return spec.repeatable ? `${flag} <value> (repeatable)` : `${flag} <value>`;
    case 'int':
      return `${flag} <${spec.min}..${spec.max}>`;
    case 'enum':
      return `${flag} <${spec.values.join('|')}>`;
  }
}

function deny(code: CliPolicyRejectCode, message: string): CliPolicyDecision {
  return { ok: false, code, message };
}

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

// ---------------------------------------------------------------------------
// Full mode (copilotStudio.cli.mode = "full")
//
// Any lark-cli command, minus the ones that manage the CLI itself or escape
// the command model. The argument array is passed through unchanged (flag
// kinds are unknown without a per-command schema), so safety comes from
// checking every token that *looks like* a flag, plus a path guard.
// ---------------------------------------------------------------------------

/** Top-level commands never runnable from Studio, with the reason shown to the model. */
const FULL_MODE_BLOCKED_COMMANDS: Readonly<Record<string, string>> = {
  auth: 'authorization is managed locally by the owner (copilot-studio login)',
  config: 'lark-cli configuration is managed by the bridge',
  profile: 'lark-cli profiles are managed by the bridge',
  update: 'lark-cli self-update is not allowed',
  install: 'lark-cli installation is not allowed',
  api: 'the raw API escape hatch is not enabled; use a typed command or +shortcut',
};

/** Flags never accepted in full mode. `--yes` is added by the bridge after owner approval. */
const FULL_MODE_BLOCKED_FLAGS: Readonly<Record<string, string>> = {
  ...ALWAYS_BLOCKED_FLAGS,
  '--download-resources': 'downloads are only allowed into the bridge working folder via explicit relative paths',
  '--output': 'use a relative path inside the bridge working folder instead',
  '--page-all': 'automatic pagination is not allowed; page with --page-token',
  '--yes': 'do not pass --yes; high-risk commands are confirmed by the owner through the bridge',
};

// Newlines/tabs are legitimate in message text; other control characters are not.
const FULL_MODE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^[\\/]{2}/;
const PATHY_FLAG = /(file|path|dir|folder|output|image|media|attachment|upload|download|local|dest|src)/i;
const PARENT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;

export type FullModeDecision =
  | { ok: true; args: string[]; commandPath: string[]; help: boolean }
  | { ok: false; code: CliPolicyRejectCode; message: string };

export function evaluateFullModeArgs(rawArgs: unknown): FullModeDecision {
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
    return denyFull('invalid-args', 'args must be a non-empty array of strings');
  }
  if (rawArgs.length > MAX_ARGS) return denyFull('invalid-args', `at most ${MAX_ARGS} args are allowed`);
  const args: string[] = [];
  for (const arg of rawArgs) {
    if (typeof arg !== 'string') return denyFull('invalid-args', 'every arg must be a string');
    if (arg.length > MAX_ARG_CHARS) return denyFull('invalid-args', `args are limited to ${MAX_ARG_CHARS} characters`);
    if (FULL_MODE_CONTROL_CHARS.test(arg)) return denyFull('invalid-args', 'args must not contain control characters');
    args.push(arg);
  }

  const first = args[0]!;
  if (first.startsWith('-')) {
    return denyFull('unknown-operation', 'args must start with a lark-cli command (e.g. "calendar"), not a flag');
  }
  const blockedCommand = FULL_MODE_BLOCKED_COMMANDS[first];
  if (blockedCommand) return denyFull('unknown-operation', `lark-cli ${first}: ${blockedCommand}`);

  // The command path is the leading run of non-flag tokens (domain, +shortcut
  // or resource, method). Anything after the first flag is flag/value data.
  const commandPath: string[] = [];
  for (const token of args) {
    if (token.startsWith('-')) break;
    commandPath.push(token);
  }

  let help = false;
  let previousFlag: string | undefined;
  for (const token of args) {
    if (token === '--') return denyFull('flag-not-allowed', '"--" is not allowed');
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token : token.slice(0, eq);
      const blocked = FULL_MODE_BLOCKED_FLAGS[name];
      if (blocked) return denyFull('flag-not-allowed', `${name}: ${blocked}`);
      if (name === '--help') help = true;
      if (eq !== -1) {
        const pathError = checkPathValue(name, token.slice(eq + 1));
        if (pathError) return denyFull('invalid-flag-value', pathError);
      }
      previousFlag = name;
      continue;
    }
    if (token.startsWith('-')) {
      // Negative numbers are values; short flags (-q = --jq, …) are not accepted.
      if (/^-\d+(\.\d+)?$/.test(token)) {
        previousFlag = undefined;
        continue;
      }
      return denyFull('flag-not-allowed', `short flag ${truncate(token)} is not allowed; use the long --flag form`);
    }
    const pathError = checkPathValue(previousFlag, token);
    if (pathError) return denyFull('invalid-flag-value', pathError);
    previousFlag = undefined;
  }
  return { ok: true, args, commandPath, help };
}

/**
 * Local filesystem reach is limited to the bridge's working folder: a value
 * may never be an absolute or UNC path or climb with "..", and values of
 * path-like flags (--file, --output-dir, --image, …) must be relative.
 */
function checkPathValue(flag: string | undefined, value: string): string | undefined {
  if (WINDOWS_ABSOLUTE.test(value) || UNC_PATH.test(value)) {
    return 'absolute local paths are not allowed; use a relative path inside the bridge working folder';
  }
  const pathy = flag !== undefined && PATHY_FLAG.test(flag);
  if (pathy && (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~'))) {
    return `${flag} must be a relative path inside the bridge working folder`;
  }
  if (pathy && PARENT_SEGMENT.test(value)) return `${flag} must not contain ".."`;
  return undefined;
}

export type CliRisk = 'read' | 'write' | 'high-risk-write' | 'unknown';

/** Parse the `Risk: …` line lark-cli prints in each command's --help. */
export function parseRiskFromHelp(helpText: string): CliRisk {
  const m = /^Risk:\s*(read|write|high-risk-write)\s*$/im.exec(helpText);
  return m ? (m[1] as CliRisk) : 'unknown';
}

/**
 * Destructive verbs the bridge treats as high-risk even where lark-cli labels
 * the raw resource command plain `write` (e.g. `calendar events delete`).
 */
const DESTRUCTIVE_VERB = /(^|[-_.+])(delete|remove|recall|revert|transfer|batch_delete)([-_.]|$)/i;

/**
 * Risk lookup backed by `lark-cli <command path> --help`, cached per path.
 * Help is local and fast; a failed lookup is `unknown` (which needs approval)
 * and is not cached, so a transient failure does not stick.
 */
export function createRiskResolver(
  runHelp: (commandPath: string[]) => Promise<string>,
): (commandPath: string[]) => Promise<CliRisk> {
  const cache = new Map<string, CliRisk>();
  return async (commandPath) => {
    const key = commandPath.join(' ');
    const cached = cache.get(key);
    if (cached) return cached;
    let risk: CliRisk;
    try {
      risk = parseRiskFromHelp(await runHelp(commandPath));
    } catch {
      return 'unknown';
    }
    if (risk !== 'unknown') cache.set(key, risk);
    return risk;
  };
}

export function needsOwnerApproval(commandPath: readonly string[], risk: CliRisk): boolean {
  if (risk === 'high-risk-write' || risk === 'unknown') return true;
  return commandPath.some((part) => DESTRUCTIVE_VERB.test(part));
}

function denyFull(code: CliPolicyRejectCode, message: string): FullModeDecision {
  return { ok: false, code, message };
}
