import type { AgentLarkIdentity } from '../types';

/**
 * lark-cli commands a team-mode run must never run: signing someone in or out,
 * re-binding, or switching the identity policy (strict-mode / default-as) of
 * the login folder it was given. Sign-in belongs to the bridge (/login), and
 * an agent that could flip the policy is how one person's token ended up
 * serving everyone on a team bot.
 */
const BLOCKED_COMMAND_PREFIXES = [
  'lark-cli auth login',
  'lark-cli auth logout',
  'lark-cli config',
  'lark-cli --profile',
  // Pointing lark-cli at another login folder through the environment.
  'env',
  'export',
];

export interface ClaudeRunSettings {
  permissions: { allow?: string[]; deny: string[] };
}

/**
 * Claude Code settings (passed with `--settings`) that fence a team-mode run:
 * file tools can't reach the identity's blocked directories, and the agent
 * can't sign anyone in or switch lark-cli's identity policy. Deny rules from
 * every settings source are merged and always win over allow rules.
 */
export function buildIdentitySettings(identity: AgentLarkIdentity): ClaudeRunSettings {
  const inherited = identity.inheritedRules;
  const deny: string[] = [...(inherited?.deny ?? [])];
  for (const dir of identity.blockedDirs) {
    const pattern = `${claudeAbsolutePath(dir)}/**`;
    deny.push(`Read(${pattern})`, `Edit(${pattern})`);
  }
  for (const prefix of BLOCKED_COMMAND_PREFIXES) {
    deny.push(`Bash(${prefix}:*)`);
  }
  const allow = inherited?.allow ?? [];
  return { permissions: { ...(allow.length > 0 ? { allow } : {}), deny } };
}

/**
 * An absolute path in Claude Code's permission-rule form: `//` marks a path
 * from the filesystem root (a single `/` would be relative to the settings
 * file), and Windows paths are written POSIX-style (`C:\a` → `//c/a`).
 */
export function claudeAbsolutePath(path: string): string {
  let posix = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const drive = /^([A-Za-z]):(\/|$)/.exec(posix);
  if (drive) posix = `/${drive[1]!.toLowerCase()}${posix.slice(2)}`;
  return `/${posix.startsWith('/') ? posix : `/${posix}`}`;
}
