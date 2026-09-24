import { log } from '../../core/logger';
import { ApprovalBroker } from './approvals';
import { ExecutionRegistry } from './execution-registry';
import { McpHttpService, type McpServiceOptions } from './mcp-server';

/**
 * Per-profile Copilot Studio services: the execution registry, the owner
 * approval broker and the MCP listener. Shared (ref-counted) by every adapter
 * instance of one profile so the supervisor's connect-before-disconnect
 * restart can hand over from the old adapter to the new one without a port
 * conflict, and so tool calls in flight keep resolving against the same state.
 *
 * Listener settings are fixed for the lifetime of the host: changing
 * copilotStudio.mcp.* or cli.mode needs a profile stop/start (a restart logs a
 * warning).
 */

export type McpListenerSettings = Omit<McpServiceOptions, 'registry' | 'approvals'>;

export class CopilotStudioServices {
  readonly registry = new ExecutionRegistry();
  readonly approvals = new ApprovalBroker();
  private mcp: McpHttpService | undefined;
  private refs = 0;
  private readonly settingsKey: string;

  constructor(
    readonly key: string,
    private readonly settings: McpListenerSettings,
  ) {
    this.settingsKey = listenerKey(settings);
  }

  get mcpUrl(): string | undefined {
    return this.mcp?.localUrl();
  }

  matches(settings: McpListenerSettings): boolean {
    return this.settingsKey === listenerKey(settings);
  }

  async retain(): Promise<void> {
    this.refs += 1;
    if (this.refs > 1) return;
    try {
      const mcp = new McpHttpService({ ...this.settings, registry: this.registry, approvals: this.approvals });
      await mcp.start();
      this.mcp = mcp;
    } catch (err) {
      this.refs -= 1;
      throw err;
    }
  }

  async release(): Promise<boolean> {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return false;
    this.approvals.cancelAll();
    this.registry.revokeAll('profile-shutdown');
    await this.mcp?.close();
    this.mcp = undefined;
    return true;
  }
}

const hosts = new Map<string, CopilotStudioServices>();

export async function acquireCopilotStudioServices(
  key: string,
  settings: McpListenerSettings,
): Promise<{ services: CopilotStudioServices; release(): Promise<void> }> {
  let services = hosts.get(key);
  if (services && !services.matches(settings)) {
    log.warn('copilot-mcp', 'settings-changed-needs-restart', { profile: key });
  }
  if (!services) {
    services = new CopilotStudioServices(key, settings);
    hosts.set(key, services);
  }
  const current = services;
  try {
    await current.retain();
  } catch (err) {
    if (hosts.get(key) === current) hosts.delete(key);
    throw err;
  }
  let released = false;
  return {
    services: current,
    async release() {
      if (released) return;
      released = true;
      if (await current.release()) {
        if (hosts.get(key) === current) hosts.delete(key);
      }
    },
  };
}

function listenerKey(settings: McpListenerSettings): string {
  return JSON.stringify([
    settings.bindHost,
    settings.port,
    settings.path,
    settings.authHeader,
    [...settings.allowedOrigins].sort(),
    settings.policy.operations.map((op) => op.id),
    settings.mode ?? 'read-only',
    // Never the key itself: its length only marks "the key changed".
    settings.apiKey.length,
  ]);
}
