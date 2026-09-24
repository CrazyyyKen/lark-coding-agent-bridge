import pkg from '../../package.json';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { CodexAdapter } from '../agent/codex/adapter';
import {
  CopilotStudioAdapter,
  type CopilotStudioAdapterOptions,
} from '../agent/copilot-studio/adapter';
import {
  AgentPreflightError,
  type AgentAvailability,
  type AgentDiagnosticId,
} from '../agent/preflight';
import type { LarkChannelEnvContext } from '../agent/lark-channel-env';
import type { AgentAdapter } from '../agent/types';
import type { AppPaths } from '../config/app-paths';
import type { AgentKind, ProfileConfig } from '../config/profile-schema';
import type { SecretsConfig } from '../config/schema';
import type { AcquiredRuntimeLock } from './locks';

/**
 * Build the agent adapter for a profile, wiring its per-profile lark-channel env
 * (so spawned agent processes see this profile's LARKSUITE_CLI_CONFIG_DIR etc.).
 * Shared by the foreground run path and the supervisor so both produce an
 * identically-configured adapter. Each profile MUST get its own adapter — the
 * adapter stores bot identity on itself (see `setBotIdentity`).
 */
export function createRuntimeAgent(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<
      Pick<
        AppPaths,
        | 'rootDir'
        | 'profile'
        | 'configFile'
        | 'larkCliConfigDir'
        | 'larkCliSourceConfigFile'
        | 'secretsFile'
        | 'keystoreSaltFile'
      >
    > & {
      configPath?: string;
    },
  /** Root-level secret providers (Copilot Studio env/file/exec refs). */
  rootSecrets?: SecretsConfig,
): AgentAdapter {
  const larkChannel = runtimeLarkChannelContext(appPaths);
  switch (profileConfig.agentKind) {
    case 'codex': {
      const codex = profileConfig.codex;
      if (!codex?.binaryPath) {
        throw new Error('codex profile requires codex.binaryPath');
      }
      return new CodexAdapter({
        binary: codex.binaryPath,
        profileStateDir: appPaths.profileDir,
        ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
        inheritCodexHome: codex.inheritCodexHome === true,
        ignoreUserConfig: codex.ignoreUserConfig === true,
        ignoreRules: codex.ignoreRules !== false,
        sandbox: profileConfig.sandbox.defaultMode,
        larkChannel,
      });
    }
    case 'copilot-studio':
      return new CopilotStudioAdapter(
        copilotStudioAdapterOptions(profileConfig, appPaths, larkChannel, rootSecrets),
      );
    case 'claude':
      return new ClaudeAdapter({ larkChannel });
  }
}

/** The per-profile lark-channel env context agent processes / lark-cli inherit. */
export function runtimeLarkChannelContext(
  appPaths: Partial<
    Pick<AppPaths, 'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'>
  > & { configPath?: string },
): LarkChannelEnvContext | undefined {
  const larkChannelConfigPath = appPaths.configPath ?? appPaths.configFile;
  return appPaths.rootDir && appPaths.profile
    ? {
        profile: appPaths.profile,
        rootDir: appPaths.rootDir,
        ...(larkChannelConfigPath ? { configPath: larkChannelConfigPath } : {}),
        ...(appPaths.larkCliConfigDir ? { larkCliConfigDir: appPaths.larkCliConfigDir } : {}),
        ...(appPaths.larkCliSourceConfigFile
          ? { larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile }
          : {}),
      }
    : undefined;
}

/**
 * Options for a profile's Copilot Studio adapter. Exported so the
 * `copilot-studio probe` command builds an adapter wired exactly like the
 * runtime one (same keystore, secret providers and lark-cli projection).
 */
export function copilotStudioAdapterOptions(
  profileConfig: ProfileConfig,
  appPaths: Pick<AppPaths, 'profileDir'> &
    Partial<Pick<AppPaths, 'profile' | 'secretsFile' | 'keystoreSaltFile'>>,
  larkChannel: CopilotStudioAdapterOptions['larkChannel'],
  rootSecrets?: SecretsConfig,
): CopilotStudioAdapterOptions {
  const config = profileConfig.copilotStudio;
  if (!config) {
    throw new Error('copilot-studio profile requires copilotStudio configuration');
  }
  if (!appPaths.secretsFile || !appPaths.keystoreSaltFile) {
    throw new Error('copilot-studio profile requires profile keystore paths');
  }
  const secrets = mergeSecretsConfig(rootSecrets, profileConfig.secrets);
  return {
    profile: appPaths.profile ?? 'copilot-studio',
    profileDir: appPaths.profileDir,
    config,
    ...(secrets ? { secrets } : {}),
    keystorePaths: {
      secretsFile: appPaths.secretsFile,
      keystoreSaltFile: appPaths.keystoreSaltFile,
    },
    ...(larkChannel ? { larkChannel } : {}),
    userSeed: profileConfig.accounts.app.id,
    version: pkg.version,
  };
}

function mergeSecretsConfig(
  root: SecretsConfig | undefined,
  profile: SecretsConfig | undefined,
): SecretsConfig | undefined {
  if (!root && !profile) return undefined;
  return {
    providers: { ...(root?.providers ?? {}), ...(profile?.providers ?? {}) },
    ...(root?.defaults || profile?.defaults
      ? { defaults: { ...(root?.defaults ?? {}), ...(profile?.defaults ?? {}) } }
      : {}),
  };
}

export async function checkRuntimeAgentAvailability(agent: AgentAdapter): Promise<AgentAvailability> {
  if (agent.checkAvailability) return agent.checkAvailability();
  const ok = await agent.isAvailable();
  if (ok) return { ok: true };
  const agentId: AgentDiagnosticId =
    agent.id === 'codex' || agent.id === 'copilot-studio' ? agent.id : 'claude';
  const diagnostic = {
    code: 'agent-binary-not-found' as const,
    agentId,
    agentName: agent.displayName,
    command: agentId,
  };
  return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic) };
}

/** Guard: reconnect/restart must not switch a profile's agent kind mid-flight. */
export function assertReconnectAgentKindUnchanged(
  current: AgentKind | undefined,
  next: AgentKind | undefined,
): void {
  const currentKind = current ?? 'claude';
  const nextKind = next ?? 'claude';
  if (nextKind !== currentKind) {
    throw new Error(
      `agent kind cannot change during reconnect (${currentKind} -> ${nextKind}); stop/start is required`,
    );
  }
}

/** Release a set of runtime locks, swallowing individual failures. */
export async function releaseRuntimeLocks(locks: AcquiredRuntimeLock[]): Promise<void> {
  for (const lock of locks) {
    await lock.release().catch(() => undefined);
  }
}
