import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { CopilotStudioAdapter, type CopilotTurnEndInfo } from '../../agent/copilot-studio/adapter';
import { resolveLarkCliExecutable } from '../../agent/copilot-studio/cli-executor';
import { BUILTIN_CLI_OPERATIONS, createCliPolicy } from '../../agent/copilot-studio/cli-policy';
import { DirectLineClient, DirectLineError } from '../../agent/copilot-studio/direct-line';
import { MCP_TOOL_NAMES } from '../../agent/copilot-studio/mcp-server';
import { buildLarkChannelEnv } from '../../agent/lark-channel-env';
import { formatAgentPreflightDiagnostic } from '../../agent/preflight';
import { buildAgentPrompt } from '../../agent/prompt';
import { resolveAppPaths, type AppPaths } from '../../config/app-paths';
import { getSecret, setSecret } from '../../config/keystore';
import { paths } from '../../config/paths';
import {
  loadRootConfig,
  readActiveProfile,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../../config/profile-store';
import {
  normalizeProfileConfig,
  type CopilotSecretInput,
  type CopilotStudioConfig,
  type ProfileConfig,
  type RootConfig,
} from '../../config/profile-schema';
import { resolveCopilotSecret } from '../../config/secret-resolver';
import { configureLogger } from '../../core/logger';
import { applyLarkCliIdentityPolicy } from '../../lark-cli/identity-policy';
import { mergeProcessEnv } from '../../platform/spawn';
import { preFlightChecks } from '../preflight';
import { checkRuntimeLock } from '../../runtime/locks';
import { copilotStudioAdapterOptions, runtimeLarkChannelContext } from '../../runtime/agent-runtime';
import { promptLine, promptPassword } from '../prompt';

/**
 * `lark-channel-bridge copilot-studio …` — local setup and diagnostics for a
 * Copilot Studio profile. Secrets are entered here, on this machine, with
 * hidden input; they are never passed as command arguments and never
 * requested in chat. See docs/copilot-studio.md.
 */

export const DIRECT_LINE_SECRET_KEYSTORE_ID = 'copilot-studio.direct-line-secret';
export const MCP_API_KEY_KEYSTORE_ID = 'copilot-studio.mcp-api-key';

export interface CopilotStudioCommandOptions {
  profile?: string;
  rootDir?: string;
}

export interface CopilotStudioSetupOptions extends CopilotStudioCommandOptions {
  /** Read the Direct Line secret from this env var instead of prompting. */
  directLineSecretEnv?: string;
  rotateMcpKey?: boolean;
  port?: string;
  bindHost?: string;
  publicUrl?: string;
  baseUrl?: string;
  /** false = skip the token-generation check against Direct Line. */
  verify?: boolean;
}

export interface CopilotStudioLoginOptions extends CopilotStudioCommandOptions {
  /** lark-cli login domains (comma-separated). */
  domain?: string;
}

/**
 * Domains whose scopes the built-in read-only operations need. Least
 * privilege: `--domain all` would request far more than the policy can use.
 */
const DEFAULT_LOGIN_DOMAINS = 'calendar,contact,docs,im,task';

export interface CopilotStudioProbeOptions extends CopilotStudioCommandOptions {
  message?: string;
  capture?: string;
  timeoutSec?: string;
}

interface LoadedProfile {
  root: RootConfig;
  name: string;
  profile: ProfileConfig;
  appPaths: AppPaths;
  configFile: string;
}

async function loadCopilotProfile(opts: CopilotStudioCommandOptions): Promise<LoadedProfile> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const configFile = resolveAppPaths({ rootDir }).configFile;
  const root = await loadRootConfig(configFile);
  if (!root) throw new Error('config not initialized; create a profile first');
  const name = opts.profile ?? (await readActiveProfile(rootDir)) ?? root.activeProfile;
  const profile = root.profiles[name];
  if (!profile) throw new Error(`profile not found: ${name}`);
  if (profile.agentKind !== 'copilot-studio') {
    throw new Error(
      `profile ${name} uses agent ${profile.agentKind}, not copilot-studio. ` +
        'Create one with: lark-channel-bridge profile create <name> --agent copilot-studio --app-id <id>',
    );
  }
  return { root, name, profile, appPaths: resolveAppPaths({ rootDir, profile: name }), configFile };
}

export async function runCopilotStudioSetup(opts: CopilotStudioSetupOptions): Promise<void> {
  const loaded = await loadCopilotProfile(opts);
  const { appPaths, name } = loaded;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && !opts.directLineSecretEnv) {
    throw new Error(
      'copilot-studio setup needs an interactive terminal (hidden secret input), ' +
        'or --direct-line-secret-env <VAR> to read the secret from an environment variable',
    );
  }

  const current = loaded.profile.copilotStudio!;
  const baseUrl = opts.baseUrl?.trim() || current.directLineBaseUrl;

  // Direct Line secret: env var (non-interactive) or hidden prompt. One line;
  // anything with whitespace is almost certainly a corrupted/multi-line paste.
  const existingSecret = await getSecret(DIRECT_LINE_SECRET_KEYSTORE_ID, appPaths);
  let secret: string | undefined;
  if (opts.directLineSecretEnv) {
    secret = process.env[opts.directLineSecretEnv]?.trim();
    if (!secret) throw new Error(`environment variable ${opts.directLineSecretEnv} is not set`);
  } else {
    console.log('在 Copilot Studio → 设置 → 安全 → Web 渠道安全（Web channel security）中复制一个 secret。');
    const entered = await promptPassword(
      existingSecret
        ? '粘贴 Direct Line secret（输入不回显；直接回车保留已保存的值）: '
        : '粘贴 Direct Line secret（输入不回显）: ',
    );
    secret = entered || existingSecret;
    if (!secret) throw new Error('Direct Line secret is required');
  }
  if (/\s/.test(secret) || secret.length < 20) {
    throw new Error(
      'the Direct Line secret looks malformed (too short or contains whitespace). ' +
        'Paste it as a single line; nothing was saved.',
    );
  }

  if (opts.verify !== false) {
    process.stdout.write('正在向 Direct Line 校验 secret（只申请 token，不发送消息）… ');
    try {
      await new DirectLineClient({ baseUrl }).generateToken(secret, `dl_setup_${randomUUID().slice(0, 8)}`);
      console.log('✓');
    } catch (err) {
      console.log('✗');
      const reason =
        err instanceof DirectLineError
          ? err.code === 'unauthorized' || err.code === 'forbidden'
            ? 'Direct Line rejected the secret (HTTP 401/403)'
            : err.message
          : String(err);
      throw new Error(`Direct Line secret check failed: ${reason}. Nothing was saved (use --no-verify to skip).`);
    }
  }

  let mcpKey = await getSecret(MCP_API_KEY_KEYSTORE_ID, appPaths);
  let mcpKeyIsNew = false;
  if (!mcpKey || opts.rotateMcpKey) {
    mcpKey = randomBytes(32).toString('base64url');
    mcpKeyIsNew = true;
  }

  const port = opts.port !== undefined ? parsePort(opts.port) : current.mcp.port;
  let publicUrl = opts.publicUrl?.trim() ?? current.mcp.publicUrl;
  if (interactive && opts.publicUrl === undefined) {
    const answer = await promptLine(
      `MCP 公网 HTTPS 地址（隧道/入口的地址，不含 ${current.mcp.path}；回车${publicUrl ? `保留 ${publicUrl}` : '稍后再填'}）: `,
    );
    if (answer) publicUrl = answer;
  }
  if (publicUrl) publicUrl = normalizePublicUrl(publicUrl, current.mcp.path);

  await setSecret(DIRECT_LINE_SECRET_KEYSTORE_ID, secret, appPaths);
  await setSecret(MCP_API_KEY_KEYSTORE_ID, mcpKey, appPaths);

  await withConfigFileLock(loaded.configFile, async () => {
    const root = await loadRootConfig(loaded.configFile);
    const profile = root?.profiles[name];
    if (!root || !profile) throw new Error(`profile not found: ${name}`);
    const existing = profile.copilotStudio ?? current;
    const next: CopilotStudioConfig = {
      ...existing,
      directLineBaseUrl: baseUrl,
      directLineSecret: { source: 'keystore', id: DIRECT_LINE_SECRET_KEYSTORE_ID },
      mcp: {
        ...existing.mcp,
        port,
        ...(opts.bindHost ? { bindHost: opts.bindHost } : {}),
        ...(publicUrl ? { publicUrl } : {}),
        authSecret: { source: 'keystore', id: MCP_API_KEY_KEYSTORE_ID },
      },
    };
    // Round-trip through the normalizer so the saved shape is canonical.
    root.profiles[name] = normalizeProfileConfig({ ...profile, copilotStudio: next });
    await saveRootConfig(root, loaded.configFile);
  });

  const saved = (await loadRootConfig(loaded.configFile))!.profiles[name]!.copilotStudio!;
  console.log('');
  console.log(`✓ 已保存 profile「${name}」的 Copilot Studio 配置（密钥加密存放在 ${appPaths.secretsFile}）`);
  console.log('');
  console.log('在 Copilot Studio 中添加 MCP 工具（Tools → Add a tool → Model Context Protocol）时填写：');
  console.log(`  Server URL:      ${saved.mcp.publicUrl ? `${saved.mcp.publicUrl}${saved.mcp.path}` : `<你的 HTTPS 隧道地址>${saved.mcp.path}`}`);
  console.log('  Authentication:  API key');
  console.log(`  Type / Header:   Header / ${saved.mcp.authHeader}`);
  if (mcpKeyIsNew) {
    console.log('');
    console.log('  API key（只显示这一次；需要时可用 `copilot-studio show-mcp-key` 再查看）:');
    console.log(`  ${mcpKey}`);
  } else {
    console.log('  API key:         未变（`copilot-studio show-mcp-key` 查看，`--rotate-mcp-key` 轮换）');
  }
  console.log('');
  console.log(`本地 MCP 监听：http://${saved.mcp.bindHost}:${saved.mcp.port}${saved.mcp.path}（隧道需指向这里）`);
  console.log('然后把 docs/copilot-studio.md 里的 Studio 指令粘贴到智能体 Instructions，保存并发布。');
  console.log(`最后运行：lark-channel-bridge copilot-studio probe --profile ${name}`);
}

/**
 * Switch what Copilot Studio may run through lark-cli:
 *  - read-only: the curated built-in read operations (default)
 *  - full: any lark-cli command except auth/config/profile/update/api, with
 *    owner approval in Lark for high-risk / destructive commands
 * Also aligns the profile's permission ceiling, which the run policy reads.
 */
export async function runCopilotStudioMode(
  mode: string | undefined,
  opts: CopilotStudioCommandOptions,
): Promise<void> {
  if (mode !== 'read-only' && mode !== 'full') {
    throw new Error('usage: lark-channel-bridge copilot-studio mode <read-only|full> [--profile <name>]');
  }
  const loaded = await loadCopilotProfile(opts);
  const access = mode === 'full' ? 'full' : 'read-only';
  await withConfigFileLock(loaded.configFile, async () => {
    const root = await loadRootConfig(loaded.configFile);
    const profile = root?.profiles[loaded.name];
    if (!root || !profile?.copilotStudio) throw new Error(`profile not found: ${loaded.name}`);
    root.profiles[loaded.name] = normalizeProfileConfig({
      ...profile,
      permissions: { ...profile.permissions, defaultAccess: access, maxAccess: access },
      copilotStudio: { ...profile.copilotStudio, cli: { ...profile.copilotStudio.cli, mode } },
    });
    await saveRootConfig(root, loaded.configFile);
  });
  if (mode === 'full') {
    console.log(`✓ profile「${loaded.name}」已切换为 full：Copilot Studio 可以执行几乎所有 lark-cli 命令（包括发送、创建、修改）。`);
    console.log('  高风险 / 删除类命令会先在飞书私聊里请你用 /approve <码> 确认。');
    console.log('  仍然禁止：auth、config、profile、update、api，以及 --as / --profile / --jq / --yes 和本机绝对路径。');
    console.log('  注意：消息或文档里的恶意内容可能诱导模型执行写操作，请留意 bot 的操作记录。');
  } else {
    console.log(`✓ profile「${loaded.name}」已切换为 read-only：只允许内置的只读操作。`);
  }
  console.log(`重启 bot 生效：lark-channel-bridge run --profile ${loaded.name}`);
}

export async function runCopilotStudioShowMcpKey(opts: CopilotStudioCommandOptions): Promise<void> {
  const { appPaths, name } = await loadCopilotProfile(opts);
  const key = await getSecret(MCP_API_KEY_KEYSTORE_ID, appPaths);
  if (!key) throw new Error(`profile ${name} has no MCP API key yet; run copilot-studio setup`);
  console.log(key);
}

export async function runCopilotStudioStatus(opts: CopilotStudioCommandOptions): Promise<void> {
  const loaded = await loadCopilotProfile(opts);
  const cfg = loaded.profile.copilotStudio!;
  const runtimeCfg = runtimeProfileConfig(loaded.root, loaded.name);
  const lines: string[] = [];
  lines.push(`profile:              ${loaded.name} (copilot-studio)`);
  lines.push(`Direct Line:          ${cfg.directLineBaseUrl}`);
  lines.push(`Direct Line secret:   ${await secretStatus(cfg.directLineSecret, 'copilotStudio.directLineSecret', runtimeCfg.secrets, loaded.appPaths)}`);
  lines.push(`MCP listener:         http://${cfg.mcp.bindHost}:${cfg.mcp.port}${cfg.mcp.path} — ${await healthStatus(cfg)}`);
  lines.push(`MCP public URL:       ${cfg.mcp.publicUrl ? `${cfg.mcp.publicUrl}${cfg.mcp.path}` : '(未配置)'}`);
  lines.push(`MCP auth:             header ${cfg.mcp.authHeader} (或 Authorization: Bearer)`);
  lines.push(`MCP API key:          ${await secretStatus(cfg.mcp.authSecret, 'copilotStudio.mcp.authSecret', runtimeCfg.secrets, loaded.appPaths)}`);
  try {
    const cli = await resolveLarkCliExecutable(cfg.cli.binaryPath);
    lines.push(`lark-cli:             ${cli.path} (${cli.via})`);
  } catch (err) {
    lines.push(`lark-cli:             ✗ ${err instanceof Error ? err.message : String(err)}`);
  }
  const { policy, unknownOperationIds } = createCliPolicy(cfg.cli.allowedOperations);
  lines.push(
    `lark-cli mode:        ${
      cfg.cli.mode === 'full'
        ? `full (all commands except auth/config/profile/update/api; high-risk needs /approve within ${Math.round(cfg.cli.approvalTimeoutMs / 1000)}s)`
        : 'read-only (built-in read operations only)'
    }`,
  );
  lines.push(`allowed operations:   ${policy.operations.map((op) => op.id).join(', ') || '(none)'}`);
  if (unknownOperationIds.length > 0) {
    lines.push(`ignored (unknown):    ${unknownOperationIds.join(', ')}`);
  }
  lines.push(`completion marker:    ${cfg.completionMarker || '(disabled — quiet window only)'}; quiet window ${cfg.quietWindowMs}ms; turn timeout ${cfg.turnTimeoutMs}ms`);
  console.log(lines.join('\n'));
}

async function secretStatus(
  input: CopilotSecretInput | undefined,
  label: string,
  secrets: ProfileConfig['secrets'],
  appPaths: AppPaths,
): Promise<string> {
  if (!input) return '✗ 未配置（运行 copilot-studio setup）';
  const where = typeof input === 'string' ? 'env template' : input.source;
  try {
    await resolveCopilotSecret(input, label, secrets, appPaths);
    return `✓ 已配置 (${where})`;
  } catch (err) {
    return `✗ ${where}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function healthStatus(cfg: CopilotStudioConfig): Promise<string> {
  const host = cfg.mcp.bindHost === '0.0.0.0' ? '127.0.0.1' : cfg.mcp.bindHost;
  try {
    const res = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${cfg.mcp.port}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? '✓ 正在运行' : `✗ HTTP ${res.status}`;
  } catch {
    return '未运行（profile 未上线）';
  }
}

/**
 * Authorize the owner's personal Lark identity for this profile's lark-cli.
 *
 * Claude/Codex profiles get this by the agent running `lark-cli auth login`
 * in chat; the Copilot Studio policy deliberately never lets Studio run
 * `auth` commands, so authorization happens here, locally, in the owner's
 * own terminal (Device Flow: a link to approve in the browser).
 */
export async function runCopilotStudioLogin(opts: CopilotStudioLoginOptions): Promise<void> {
  const loaded = await loadCopilotProfile(opts);
  const { appPaths, name, profile } = loaded;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('copilot-studio login needs an interactive terminal (you approve the login in a browser)');
  }
  if (profile.mode === 'team') {
    throw new Error(`profile ${name} is in team mode, which always runs lark-cli as the bot; personal login is disabled`);
  }
  const lock = await checkRuntimeLock(appPaths.profileLockFile);
  if (lock.locked) {
    throw new Error(
      `profile ${name} is running${lock.meta ? ` (pid ${lock.meta.pid})` : ''}; stop it first (Ctrl+C), ` +
        'log in, then start it again so it picks up the new identity',
    );
  }
  const larkChannel = runtimeLarkChannelContext({ ...appPaths, configPath: loaded.configFile });
  if (!larkChannel) throw new Error('could not resolve the profile lark-cli context');
  const runtimeCfg = runtimeProfileConfig(loaded.root, name);

  // 1. Make sure the profile-local lark-cli is bound to this app (normally done by `run`).
  await preFlightChecks({ bridgeConfig: runtimeCfg, profileConfig: profile, appPaths, larkChannel });

  // 2. Allow a user identity for this profile, and remember the choice.
  if (!(await applyLarkCliIdentityPolicy(larkChannel, 'user-default'))) {
    throw new Error('failed to switch the profile lark-cli to user-default; see `lark-cli doctor`');
  }
  await withConfigFileLock(loaded.configFile, async () => {
    const root = await loadRootConfig(loaded.configFile);
    const current = root?.profiles[name];
    if (!root || !current) throw new Error(`profile not found: ${name}`);
    root.profiles[name] = { ...current, larkCli: { ...current.larkCli, identityPreset: 'user-default' } };
    await saveRootConfig(root, loaded.configFile);
  });

  // 3. Device Flow login in this terminal.
  const cli = await resolveLarkCliExecutable(profile.copilotStudio?.cli.binaryPath);
  const domains = opts.domain?.trim() || DEFAULT_LOGIN_DOMAINS;
  const env = mergeProcessEnv(process.env, buildLarkChannelEnv(larkChannel));
  console.log(`\n正在为 profile「${name}」登录你的飞书个人身份（授权范围：${domains}）。`);
  console.log('按提示在浏览器中打开链接并确认授权；完成前这里会一直等待。\n');
  const code = await runInteractive(cli.path, ['auth', 'login', '--domain', domains], env);
  if (code !== 0) {
    console.error(`\n✗ lark-cli auth login 未完成（exit ${code ?? 'signal'}）。profile 仍以 bot 身份可用；可重新运行本命令。`);
    process.exitCode = 1;
    return;
  }
  console.log('');
  await runInteractive(cli.path, ['auth', 'status'], env);
  console.log(`\n✓ 已授权。重新启动 bot 生效：lark-channel-bridge run --profile ${name}`);
}

function runInteractive(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', env, shell: false, windowsHide: false });
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

/**
 * Phase-A feasibility probe: one Direct Line turn against the published
 * agent, outside Lark, with the MCP listener up. Reports whether the reply
 * arrived, whether Studio called a bridge tool with a valid execution token,
 * and which completion signal ended the turn. `--capture` writes the
 * sanitized (shape-only) protocol fixture for the record.
 */
export async function runCopilotStudioProbe(opts: CopilotStudioProbeOptions): Promise<void> {
  const loaded = await loadCopilotProfile(opts);
  const { appPaths, name } = loaded;
  const lock = await checkRuntimeLock(appPaths.profileLockFile);
  if (lock.locked) {
    throw new Error(
      `profile ${name} is running${lock.meta ? ` (pid ${lock.meta.pid})` : ''}; ` +
        'stop it first so the probe can own the MCP port',
    );
  }
  configureLogger({ logsDir: appPaths.logsDir });

  const runtimeCfg = runtimeProfileConfig(loaded.root, name);
  const baseOptions = copilotStudioAdapterOptions(
    loaded.profile,
    appPaths,
    runtimeLarkChannelContext({ ...appPaths, configPath: loaded.configFile }),
    runtimeCfg.secrets,
  );
  const timeoutSec = opts.timeoutSec ? Number(opts.timeoutSec) : undefined;
  const config: CopilotStudioConfig = {
    ...baseOptions.config,
    ...(timeoutSec && Number.isFinite(timeoutSec) && timeoutSec > 0
      ? { turnTimeoutMs: Math.round(timeoutSec * 1000) }
      : {}),
  };
  const activities: Array<{ phase: string; activity: Record<string, unknown> }> = [];
  let turnEnd: CopilotTurnEndInfo | undefined;
  const adapter = new CopilotStudioAdapter({
    ...baseOptions,
    config,
    maintenanceIntervalMs: 0,
    onActivity: (event) => activities.push(event),
    onTurnEnd: (info) => {
      turnEnd = info;
    },
  });

  const availability = await adapter.checkAvailability();
  if (!availability.ok) {
    console.error(formatAgentPreflightDiagnostic(availability.diagnostic));
    process.exitCode = 1;
    return;
  }
  await adapter.start();
  console.log(`MCP listener: ${adapter.mcpLocalUrl ?? '(unknown)'}`);
  console.log(`MCP public:   ${config.mcp.publicUrl ? `${config.mcp.publicUrl}${config.mcp.path}` : '(未配置 — Studio 无法调用工具)'}`);
  console.log('');

  const message =
    opts.message?.trim() ||
    `这是 lark-channel-bridge 的连通性测试。请调用 ${MCP_TOOL_NAMES.ping} 工具（executionToken 用 bridge_execution 里的值），然后用一句话告诉我工具返回的 fixture 字段。`;
  const prompt = buildAgentPrompt({
    context: { chatId: 'probe', chatType: 'p2p', senderId: 'probe', source: 'im' },
    userInput: message,
  });

  const toolCalls: Array<{ name: string; ok: boolean }> = [];
  const toolNames = new Map<string, string>();
  let replyChars = 0;
  let terminal = 'none';
  try {
    const run = adapter.run({ runId: `probe-${randomUUID()}`, prompt, sandbox: 'read-only' });
    for await (const event of run.events) {
      if (event.type === 'text') {
        process.stdout.write(event.delta);
        replyChars += event.delta.length;
      } else if (event.type === 'tool_use') {
        toolNames.set(event.id, event.name);
        console.log(`\n[tool] ${event.name} ${JSON.stringify(event.input)}`);
      } else if (event.type === 'tool_result') {
        toolCalls.push({ name: toolNames.get(event.id) ?? 'unknown', ok: !event.isError });
        console.log(`[tool] ${event.isError ? '✗' : '✓'} ${event.output.slice(0, 200)}`);
      } else if (event.type === 'done') {
        terminal = `done:${event.terminationReason}`;
      } else if (event.type === 'error') {
        terminal = 'error';
        console.error(`\n✗ ${event.message}`);
      }
    }
  } finally {
    await adapter.dispose();
  }

  const replied = replyChars > 0;
  const pinged = toolCalls.some((call) => call.name === MCP_TOOL_NAMES.ping && call.ok);
  const anyTool = toolCalls.some((call) => call.ok);
  console.log('\n');
  console.log('── probe summary ─────────────────────────────');
  console.log(`Direct Line reply received:        ${replied ? '✓' : '✗'}`);
  console.log(`MCP tool call from published agent: ${pinged ? `✓ (${MCP_TOOL_NAMES.ping})` : anyTool ? '✓ (other tool)' : '✗ none observed'}`);
  console.log(`Execution token propagated:         ${anyTool ? '✓' : '✗ (no tool call carried a valid token)'}`);
  console.log(
    `Turn completion:                    ${
      turnEnd?.completion
        ? `${turnEnd.completion}${turnEnd.completion === 'quiet-window' ? ' (degraded — no turn.complete event or marker seen)' : ''}`
        : turnEnd?.outcome ?? terminal
    }`,
  );
  console.log(`Duration:                           ${turnEnd ? `${turnEnd.durationMs}ms` : '-'}`);
  if (!pinged && !anyTool) {
    console.log('');
    console.log('没有观察到工具调用：请确认 MCP 工具已添加到“已发布”的智能体、连接已完成授权、隧道可达，');
    console.log('并且 Studio 的 Instructions 要求调用工具时传入 executionToken。只在 Test/Preview 中成功不算通过。');
  }

  if (opts.capture) {
    const fixture = {
      capturedAt: new Date().toISOString(),
      profile: name,
      directLineOrigin: new URL(config.directLineBaseUrl).origin,
      result: {
        replied,
        toolCalls,
        completion: turnEnd?.completion ?? null,
        outcome: turnEnd?.outcome ?? terminal,
        durationMs: turnEnd?.durationMs ?? null,
      },
      activities,
    };
    await writeFile(opts.capture, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
    console.log(`\n已写入脱敏协议样本：${opts.capture}`);
  }
  if (!replied || !anyTool || turnEnd?.outcome !== 'complete') process.exitCode = 1;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid --port: ${value}`);
  return port;
}

/** Origin (+ optional base path) of the tunnel; a pasted trailing MCP path is dropped. */
export function normalizePublicUrl(value: string, mcpPath: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid MCP public URL: ${value}`);
  }
  if (url.protocol !== 'https:') throw new Error('the MCP public URL must use https');
  let path = url.pathname.replace(/[/]+$/, '');
  if (path === mcpPath || path.endsWith(mcpPath)) path = path.slice(0, path.length - mcpPath.length);
  return `${url.origin}${path}`;
}

/** Built-in operation ids, for `--help` text. */
export const COPILOT_OPERATION_IDS = BUILTIN_CLI_OPERATIONS.map((op) => op.id);
