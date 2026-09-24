import type { AccessMode } from '../config/permissions';
import type { ProfileConfig } from '../config/profile-schema';
import { BRIDGE_SYSTEM_PROMPT } from './bridge-system-prompt';

export type AgentCapabilityId = 'claude' | 'codex' | 'copilot-studio';
export type AgentSessionKind = 'claude-session' | 'codex-thread' | 'copilot-conversation';
export type PromptInjectionMode = 'append-system-prompt' | 'stdin-prefix' | 'remote-message';
export type RunSource = 'im' | 'card' | 'comment' | 'meeting';

export interface AgentCapability {
  agentId: AgentCapabilityId;
  sessionKind: AgentSessionKind;
  promptInjection: PromptInjectionMode;
  systemPrompt: string;
  supportsNativeHistory: boolean;
  /**
   * The agent runs off this machine (Copilot Studio). Local-agent bridge
   * instructions (env vars, terminal, keychain) do not apply and must not be
   * forwarded as if they were trusted instructions.
   */
  remote: boolean;
  /** Run sources this agent accepts. Anything else is rejected before execution. */
  sources: readonly RunSource[];
  /**
   * Only the bot owner, in a private (p2p) chat, may start runs. Used by the
   * Copilot Studio MVP, whose execution capability is exposed to the model.
   */
  ownerDmOnly: boolean;
  callback: {
    marker: '__bridge_cb';
    legacyMarkers: string[];
  };
  permissions: {
    maxAccess: AccessMode;
  };
}

const ALL_SOURCES: readonly RunSource[] = ['im', 'card', 'comment', 'meeting'];

export function claudeCapability(profile?: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile?.permissions.maxAccess ?? 'full';
  return {
    agentId: 'claude',
    sessionKind: 'claude-session',
    promptInjection: 'append-system-prompt',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: true,
    remote: false,
    sources: ALL_SOURCES,
    ownerDmOnly: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: ['__claude_cb'],
    },
    permissions: {
      maxAccess,
    },
  };
}

export function codexCapability(profile: Pick<ProfileConfig, 'permissions'>): AgentCapability {
  const maxAccess = profile.permissions.maxAccess;
  return {
    agentId: 'codex',
    sessionKind: 'codex-thread',
    promptInjection: 'stdin-prefix',
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    supportsNativeHistory: false,
    remote: false,
    sources: ALL_SOURCES,
    ownerDmOnly: false,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess,
    },
  };
}

/**
 * Copilot Studio: remote reasoning, local lark-cli execution via MCP. The
 * ceiling follows `copilotStudio.cli.mode`: `read-only` (default) allows only
 * the curated read operations; `full` allows the wider lark-cli policy with
 * owner approval for high-risk commands. Neither ever means "arbitrary shell".
 */
export function copilotStudioCapability(
  profile?: Pick<ProfileConfig, 'copilotStudio'>,
): AgentCapability {
  return {
    agentId: 'copilot-studio',
    sessionKind: 'copilot-conversation',
    promptInjection: 'remote-message',
    systemPrompt: '',
    supportsNativeHistory: false,
    remote: true,
    sources: ['im'],
    ownerDmOnly: true,
    callback: {
      marker: '__bridge_cb',
      legacyMarkers: [],
    },
    permissions: {
      maxAccess: profile?.copilotStudio?.cli.mode === 'full' ? 'full' : 'read-only',
    },
  };
}

/** The capability for a profile's agent kind. Exhaustive over AgentKind. */
export function capabilityForProfile(
  profile: Pick<ProfileConfig, 'agentKind' | 'permissions' | 'copilotStudio'>,
): AgentCapability {
  switch (profile.agentKind) {
    case 'claude':
      return claudeCapability(profile);
    case 'codex':
      return codexCapability(profile);
    case 'copilot-studio':
      return copilotStudioCapability(profile);
  }
}
