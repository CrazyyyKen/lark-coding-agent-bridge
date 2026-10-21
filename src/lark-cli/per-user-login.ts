import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { AgentLarkIdentity } from '../agent/types';
import type { TeamConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import {
  bindLoginFolder,
  completeDeviceLogin,
  getUserAuthStatus,
  logoutUser,
  startDeviceLoginFor,
  type DeviceLogin,
  type LarkCliExec,
  type UserAuthStatus,
  type UserImContext,
} from './user-im';

/**
 * Per-person Lark sign-in for team bots (profile `team.perUserLogin`).
 *
 * Everyone who DMs the bot gets, keyed by their open_id:
 *   - a lark-cli login folder  <profileDir>/users/<openId>/lark-cli
 *   - a working folder         <workspaceRoot>/.lark-users/<openId>
 *     (session history follows the working folder, and DM attachments are
 *     cached inside it rather than in the shared media cache)
 *
 * The bridge picks these for each run from the message's sender; the agent
 * never chooses. Sign-in is the bridge's device flow: the person opens a
 * link, approves, and the bridge keeps the token only if the Lark account
 * that approved is the person who asked.
 */

const STATUS_TTL_MS = 60_000;
const DEFAULT_LOGIN_LIFETIME_S = 600;
const LOGIN_WAIT_SLACK_MS = 30_000;
const WORKSPACE_USERS_DIR = '.lark-users';

export interface PerUserLoginOptions {
  profile: string;
  /** LARK_CHANNEL_HOME. */
  rootDir: string;
  profileDir: string;
  /** The profile's default working folder; per-person folders live inside it. */
  workspaceRoot: string;
  team: TeamConfig;
  exec?: LarkCliExec;
  now?: () => number;
  /** Where Claude Code keeps session histories. Default: CLAUDE_CONFIG_DIR or ~/.claude. */
  claudeProjectsDir?: string;
  /** lark-cli's credential store. Default: {@link defaultLarkCliDataDir}. */
  larkCliDataDir?: string;
}

export interface PersonFolders {
  dataDir: string;
  larkCliConfigDir: string;
  workspaceDir: string;
  attachmentsDir: string;
}

export interface PersonRun {
  identity: AgentLarkIdentity;
  cwd: string;
  attachmentsDir: string;
}

/** Sends a markdown message to the person's DM. */
export type Notify = (markdown: string) => Promise<void>;

interface PersonState {
  welcomedAt?: string;
}

interface PendingLogin {
  login: DeviceLogin;
  expiresAt: number;
}

export function isValidOpenId(openId: string): boolean {
  return /^ou_[A-Za-z0-9_-]{4,}$/.test(openId);
}

export function defaultClaudeProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(configDir || join(homedir(), '.claude'), 'projects');
}

/**
 * lark-cli's credential store on Linux: a file-backed "keychain" shared by
 * every login folder on the machine (app secret, user tokens). Login folders
 * only hold references into it.
 */
export function defaultLarkCliDataDir(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  return join(dataHome || join(homedir(), '.local', 'share'), 'lark-cli');
}

/**
 * The identity for team-mode runs that act for nobody in particular (groups,
 * doc comments, meetings, DMs with per-person sign-in off): bot only, and
 * blocked from everyone's personal folders, every session history and the
 * bridge logs (which record message previews).
 */
export function sharedBotIdentity(opts: {
  rootDir: string;
  profileDir: string;
  workspaceRoot?: string;
  claudeProjectsDir?: string;
  larkCliDataDir?: string;
}): AgentLarkIdentity {
  const blockedDirs = [
    join(opts.profileDir, 'users'),
    join(opts.profileDir, 'logs'),
    join(opts.rootDir, 'logs'),
    opts.claudeProjectsDir ?? defaultClaudeProjectsDir(),
    opts.larkCliDataDir ?? defaultLarkCliDataDir(),
  ];
  if (opts.workspaceRoot) blockedDirs.push(join(opts.workspaceRoot, WORKSPACE_USERS_DIR));
  return { kind: 'shared-bot', blockedDirs };
}

export class PerUserLogins {
  private readonly opts: PerUserLoginOptions;
  private readonly exec: LarkCliExec | undefined;
  private readonly now: () => number;
  private readonly claudeProjectsDir: string;
  private readonly larkCliDataDir: string;
  private readonly preparing = new Map<string, Promise<PersonFolders>>();
  private readonly statusCache = new Map<string, { status: UserAuthStatus; at: number }>();
  private readonly pending = new Map<string, PendingLogin>();
  private readonly welcomed = new Set<string>();

  constructor(opts: PerUserLoginOptions) {
    this.opts = opts;
    this.exec = opts.exec;
    this.now = opts.now ?? Date.now;
    this.claudeProjectsDir = opts.claudeProjectsDir ?? defaultClaudeProjectsDir();
    this.larkCliDataDir = opts.larkCliDataDir ?? defaultLarkCliDataDir();
  }

  folders(openId: string): PersonFolders {
    if (!isValidOpenId(openId)) throw new Error(`invalid open_id: ${openId}`);
    const dataDir = join(this.opts.profileDir, 'users', openId);
    const workspaceDir = join(this.opts.workspaceRoot, WORKSPACE_USERS_DIR, openId);
    return {
      dataDir,
      larkCliConfigDir: join(dataDir, 'lark-cli'),
      workspaceDir,
      attachmentsDir: join(workspaceDir, '.attachments'),
    };
  }

  sharedIdentity(): AgentLarkIdentity {
    return sharedBotIdentity({
      rootDir: this.opts.rootDir,
      profileDir: this.opts.profileDir,
      workspaceRoot: this.opts.workspaceRoot,
      claudeProjectsDir: this.claudeProjectsDir,
      larkCliDataDir: this.larkCliDataDir,
    });
  }

  /** Create the person's folders and bind their login folder to the app. Idempotent. */
  prepare(openId: string): Promise<PersonFolders> {
    const inFlight = this.preparing.get(openId);
    if (inFlight) return inFlight;
    const p = this.doPrepare(openId).finally(() => this.preparing.delete(openId));
    this.preparing.set(openId, p);
    return p;
  }

  private async doPrepare(openId: string): Promise<PersonFolders> {
    const folders = this.folders(openId);
    await mkdir(folders.larkCliConfigDir, { recursive: true, mode: 0o700 });
    await mkdir(folders.attachmentsDir, { recursive: true, mode: 0o700 });
    if (!(await exists(join(folders.larkCliConfigDir, 'lark-channel', 'config.json')))) {
      const bound = await bindLoginFolder(this.ctx(folders), this.exec);
      if (!bound.ok) throw new Error(bound.message ?? 'lark-cli bind failed');
      log.info('per-user-login', 'bound', { user: openId.slice(-6) });
    }
    return folders;
  }

  /**
   * The shared workspace's permission rules (the deployment's allowed
   * commands such as `Bash(lark-cli:*)`, and its deny list). Claude Code
   * ignores project settings in a folder it hasn't trusted, which every new
   * person's folder is, so the run carries them in its own settings instead
   * (verified against Claude Code 2.1.303).
   */
  private async workspaceRules(): Promise<{ allow: string[]; deny: string[] } | undefined> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.opts.workspaceRoot, '.claude', 'settings.json'), 'utf8'),
      ) as { permissions?: { allow?: unknown; deny?: unknown } };
      const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
      return { allow: strings(raw.permissions?.allow), deny: strings(raw.permissions?.deny) };
    } catch {
      return undefined;
    }
  }

  /** Everything a DM run for `openId` needs: identity, working folder, attachment cache. */
  async runFor(openId: string): Promise<PersonRun> {
    const folders = await this.prepare(openId);
    const status = await this.status(openId);
    const inheritedRules = await this.workspaceRules();
    return {
      identity: {
        kind: 'user',
        openId,
        signedIn: status.loggedIn,
        larkCliConfigDir: folders.larkCliConfigDir,
        ...(inheritedRules ? { inheritedRules } : {}),
        blockedDirs: await this.blockedDirsFor(openId, folders.workspaceDir),
      },
      cwd: folders.workspaceDir,
      attachmentsDir: folders.attachmentsDir,
    };
  }

  /**
   * A person's run may not touch: the bridge's home (every login folder,
   * logs, the shared media cache, config), lark-cli's credential store,
   * every session history, and every other person's working folder. Anything
   * containing their own working folder is left out so the run can still use it.
   */
  private async blockedDirsFor(openId: string, workspaceDir: string): Promise<string[]> {
    const others: string[] = [];
    const usersRoot = join(this.opts.workspaceRoot, WORKSPACE_USERS_DIR);
    try {
      for (const entry of await readdir(usersRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== openId) others.push(join(usersRoot, entry.name));
      }
    } catch {
      // No one else yet.
    }
    const candidates = [this.opts.rootDir, this.larkCliDataDir, this.claudeProjectsDir, ...others];
    const own = resolve(workspaceDir);
    return candidates.filter((dir) => {
      const keep = !isSameOrInside(own, resolve(dir));
      if (!keep) log.warn('per-user-login', 'block-skipped-contains-workspace', { dir });
      return keep;
    });
  }

  /** The person's sign-in state; cached briefly unless `fresh`. */
  async status(openId: string, fresh = false): Promise<UserAuthStatus> {
    const cached = this.statusCache.get(openId);
    if (!fresh && cached && this.now() - cached.at < STATUS_TTL_MS) return cached.status;
    const folders = this.folders(openId);
    if (!(await exists(join(folders.larkCliConfigDir, 'lark-channel', 'config.json')))) {
      return { loggedIn: false, scopes: [] };
    }
    const raw = await getUserAuthStatus(this.ctx(folders), this.exec).catch(
      (): UserAuthStatus => ({ loggedIn: false, scopes: [] }),
    );
    // A token for any other account is never this person's sign-in.
    const status = raw.loggedIn && raw.openId && raw.openId !== openId
      ? { ...raw, loggedIn: false }
      : raw;
    this.statusCache.set(openId, { status, at: this.now() });
    return status;
  }

  /**
   * On someone's first DM: if they aren't signed in, send the welcome with a
   * sign-in link, once. Later reminders come from /login.
   */
  /**
   * `sendWelcome` posts the welcome with the new sign-in link (a card in the
   * bridge); `notify` carries the later outcome notices.
   */
  async welcomeIfNew(
    openId: string,
    notify: Notify,
    sendWelcome: (login: DeviceLogin) => Promise<void> = (login) => notify(welcomeMessage(login)),
  ): Promise<void> {
    if (this.welcomed.has(openId)) return;
    this.welcomed.add(openId);
    const folders = this.folders(openId);
    const statePath = join(folders.dataDir, 'state.json');
    const state = await readState(statePath);
    if (state.welcomedAt) return;
    await mkdir(folders.dataDir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      statePath,
      `${JSON.stringify({ ...state, welcomedAt: new Date(this.now()).toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if ((await this.status(openId)).loggedIn) return;
    try {
      const login = await this.startLogin(openId, notify);
      await sendWelcome(login);
    } catch (err) {
      log.warn('per-user-login', 'welcome-failed', { user: openId.slice(-6), err: String(err) });
      await notify(
        "👋 Hi! I'm the team assistant. I couldn't prepare your sign-in just now — send `/login` to try again. " +
          'Until then I can still help with general questions.',
      );
    }
  }

  /**
   * Start (or reuse) a sign-in for this person and finish it in the
   * background. `notify` reports the outcome in their DM.
   */
  async startLogin(openId: string, notify: Notify): Promise<DeviceLogin> {
    const existing = this.pending.get(openId);
    if (existing && existing.expiresAt > this.now() + 60_000) return existing.login;
    const folders = await this.prepare(openId);
    const login = await startDeviceLoginFor(
      this.ctx(folders),
      { domains: this.opts.team.loginDomains, exclude: this.opts.team.loginExclude },
      this.exec,
    );
    const lifetimeMs = (login.expiresIn ?? DEFAULT_LOGIN_LIFETIME_S) * 1000;
    this.pending.set(openId, { login, expiresAt: this.now() + lifetimeMs });
    void this.finishLogin(openId, folders, login, lifetimeMs + LOGIN_WAIT_SLACK_MS, notify).catch((err) =>
      log.warn('per-user-login', 'finish-failed', { user: openId.slice(-6), err: String(err) }),
    );
    return login;
  }

  private async finishLogin(
    openId: string,
    folders: PersonFolders,
    login: DeviceLogin,
    waitMs: number,
    notify: Notify,
  ): Promise<void> {
    const result = await completeDeviceLogin(this.ctx(folders), login.deviceCode, this.exec, waitMs);
    if (this.pending.get(openId)?.login.deviceCode === login.deviceCode) this.pending.delete(openId);
    this.statusCache.delete(openId);
    if (!result.ok) {
      // Usually the link expired unused; /login gives a new one.
      log.info('per-user-login', 'not-completed', { user: openId.slice(-6), reason: result.message });
      return;
    }
    const status = await getUserAuthStatus(this.ctx(folders), this.exec);
    const approvedBy = status.openId ?? (await storedUserOpenId(folders));
    if (approvedBy !== openId) {
      // Someone else opened the link (it was forwarded, or opened while
      // signed in to another account). Never keep a token that isn't theirs.
      await logoutUser(this.ctx(folders), this.exec);
      log.warn('per-user-login', 'account-mismatch', {
        user: openId.slice(-6),
        approvedBy: approvedBy?.slice(-6) ?? 'unknown',
      });
      await notify(
        '⚠️ That sign-in was approved by a different Lark account, so I discarded it. ' +
          'Please open the link yourself while signed in to your own Lark account — send `/login` for a new one.',
      );
      return;
    }
    log.info('per-user-login', 'signed-in', { user: openId.slice(-6) });
    const name = status.userName?.trim();
    await notify(
      `✅ Signed in${name ? ` as **${name}**` : ''}. From now on I act as you for what you ask me here, ` +
        'and only you can use this sign-in. Send `/logout` any time to remove it.',
    );
  }

  async logout(openId: string): Promise<{ ok: boolean; message?: string }> {
    const folders = this.folders(openId);
    this.pending.delete(openId);
    this.statusCache.delete(openId);
    if (!(await exists(join(folders.larkCliConfigDir, 'lark-channel', 'config.json')))) return { ok: true };
    return logoutUser(this.ctx(folders), this.exec);
  }

  private ctx(folders: PersonFolders): UserImContext {
    return {
      profile: this.opts.profile,
      rootDir: this.opts.rootDir,
      larkCliConfigDir: folders.larkCliConfigDir,
    };
  }
}

/** How many minutes a sign-in link stays valid. */
export function loginLinkMinutes(login: DeviceLogin): number {
  return Math.round((login.expiresIn ?? DEFAULT_LOGIN_LIFETIME_S) / 60);
}

export function welcomeMessage(login: DeviceLogin): string {
  const minutes = Math.round((login.expiresIn ?? DEFAULT_LOGIN_LIFETIME_S) / 60);
  return [
    "👋 Hi! I'm the team assistant.",
    '',
    'To work with **your own** docs, calendar, mail and approvals, sign in once with your Lark account:',
    '',
    login.verificationUrl,
    '',
    `The link works for ${minutes} minutes; send \`/login\` any time for a new one. ` +
      "Until you sign in I can still help with general questions.",
    '',
    'Your sign-in is only used for your own requests in this chat: other people using me can\'t reach ' +
      'your data, and you can\'t reach theirs. Send `/logout` to remove it, `/whoami` to check it.',
  ].join('\n');
}

export function loginLinkMessage(login: DeviceLogin): string {
  const minutes = Math.round((login.expiresIn ?? DEFAULT_LOGIN_LIFETIME_S) / 60);
  return [
    'Open this link while signed in to **your own** Lark account and approve:',
    '',
    login.verificationUrl,
    '',
    `It works for ${minutes} minutes. I'll confirm here once you're signed in.`,
  ].join('\n');
}

/**
 * The open_id lark-cli recorded for the folder's signed-in user, read from its
 * config (`apps[].users[].userOpenId`) when `auth status` doesn't report one.
 */
async function storedUserOpenId(folders: PersonFolders): Promise<string | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(join(folders.larkCliConfigDir, 'lark-channel', 'config.json'), 'utf8'),
    ) as { apps?: Array<{ users?: Array<{ userOpenId?: unknown }> | null }> };
    for (const app of raw.apps ?? []) {
      for (const user of app.users ?? []) {
        if (typeof user.userOpenId === 'string' && user.userOpenId) return user.userOpenId;
      }
    }
  } catch {
    // Unreadable → unknown, which never matches.
  }
  return undefined;
}

async function readState(path: string): Promise<PersonState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PersonState) : {};
  } catch {
    return {};
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}
