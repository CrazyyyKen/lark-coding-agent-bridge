import { log } from '../core/logger';
import type { BaseStore, ClaudeAccount, RequestRecord } from './base-store';
import { CREDENTIAL, STATUS } from './base-store';
import {
  CMD,
  connectedCard,
  doneCard,
  knowledgeCard,
  md,
  person,
  progressCard,
  rejectedCard,
  requestCard,
  waitingCard,
  type Checks,
  type Failure,
  type SeatUse,
} from './cards';
import { checkKnowledge, starterInstructions, type KnowledgeItem } from './knowledge';
import type { AddResult, LarkBots, RunResult } from './lark-bots';
import { EXIT } from './lark-bots';
import { APP_ID_RE, baseBotName, freeBotName } from './naming';

export interface CardPort {
  send(chatId: string, card: object): Promise<string>;
  update(messageId: string, card: object): Promise<void>;
}

export interface MembersPort {
  isMember(chatId: string, openId: string): Promise<boolean>;
}

/** Calls made with the requested app's own credentials. */
export interface AppPort {
  validate(appId: string, secret: string): Promise<{ ok: boolean; reason?: string; network?: boolean }>;
  ownerUnionId(appId: string, secret: string): Promise<string | undefined>;
}

export type Store = Pick<
  BaseStore,
  | 'newRequests'
  | 'requestsWithStatus'
  | 'request'
  | 'requesterUnionId'
  | 'updateRequest'
  | 'accounts'
  | 'createAccount'
  | 'updateAccount'
  | 'settings'
  | 'event'
>;

export type Bots = Pick<
  LarkBots,
  'add' | 'setApiKey' | 'botNames' | 'botForApp' | 'setInstructions' | 'botGet' | 'sendMessage'
>;

export interface ProvisionerDeps {
  store: Store;
  cards: CardPort;
  members: MembersPort;
  apps: AppPort;
  bots: Bots;
  approvalChatId: string;
  tenant: string;
  now?: () => number;
}

export interface ActionInput {
  cmd: string;
  recordId: string;
  /** The clicked card's message. */
  messageId?: string;
  chatId: string;
  operatorOpenId: string;
  operatorName?: string;
  form: Record<string, string>;
}

export type ActionReply = { toast: { type: 'info' | 'success' | 'error' | 'warning'; content: string } };

/** The Claude credential the approver chose on the card. */
export interface ClaudeChoice {
  account?: string;
  newSeat?: string;
  apiKey?: { key: string; label?: string };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9._@+-]{0,63}$/;
const isSeat = (a: ClaudeAccount) => /seat/i.test(a.kind);

const toast = (type: ActionReply['toast']['type'], content: string): ActionReply => ({ toast: { type, content } });

/** Reads the Claude choice from the card form. Returns an error message when it doesn't add up. */
export function claudeChoice(form: Record<string, string>, defaultAccount: string): ClaudeChoice | string {
  const newSeat = form.new_seat?.trim().toLowerCase();
  const key = form.api_key?.trim();
  const label = form.api_key_label?.trim().toLowerCase();
  if (newSeat && key) return 'Choose a new seat or a new API key, not both';
  if (newSeat) {
    if (!EMAIL_RE.test(newSeat) || !ACCOUNT_RE.test(newSeat)) return `"${newSeat}" isn't a seat email`;
    return { newSeat };
  }
  if (key) {
    if (label && !ACCOUNT_RE.test(label)) return 'The API key name may use only lowercase letters, digits and . _ @ + -';
    return { apiKey: { key, label: label || undefined } };
  }
  const account = form.claude_account?.trim() || defaultAccount;
  if (!account) return 'Choose a Claude account';
  return { account };
}

/**
 * Turns form submissions into running bots: posts an approval card for each new
 * request, and on Approve runs lark-bots.sh add (docs/bot-provisioning-plan.md §3.2).
 */
export class Provisioner {
  private readonly busy = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: ProvisionerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** A request left half-way by a restart can be retried from its card. */
  async recover(): Promise<void> {
    for (const status of [STATUS.approved, STATUS.provisioning]) {
      for (const req of await this.deps.store.requestsWithStatus(status)) {
        await this.fail(req, { kind: 'other', message: 'The provisioner restarted while setting this up. Retry to continue.' });
      }
    }
  }

  /** One pass over the Base: a card for every request nobody has seen yet. */
  async poll(): Promise<void> {
    const { store } = this.deps;
    for (const req of await store.newRequests()) {
      if (this.busy.has(req.recordId)) continue;
      this.busy.add(req.recordId);
      try {
        if (req.cardMessageId) {
          // Card went out but the status write didn't.
          await store.updateRequest(req.recordId, { Status: STATUS.carded });
          continue;
        }
        const checks = await this.check(req, req.appSecret);
        const messageId = await this.deps.cards.send(this.deps.approvalChatId, await this.requestCard(req, checks));
        await store.updateRequest(req.recordId, { Status: STATUS.carded, 'Card message ID': messageId });
        await store.event(req.recordId, 'carded', JSON.stringify(checks));
        log.info('provisioner', 'carded', { record: req.recordId, request: req.requestId });
      } catch (err) {
        log.fail('provisioner', err, { step: 'card', record: req.recordId });
      } finally {
        this.busy.delete(req.recordId);
      }
    }
    await this.announceWaiting();
  }

  async handleAction(a: ActionInput): Promise<ActionReply | undefined> {
    const commands: string[] = [CMD.approve, CMD.reject, CMD.knowledgeCheck, CMD.goLive];
    if (!commands.includes(a.cmd)) return undefined;
    if (a.chatId !== this.deps.approvalChatId) return toast('error', 'Use the card in the AI Team group');
    if (!(await this.deps.members.isMember(a.chatId, a.operatorOpenId))) {
      return toast('error', 'Only members of the AI Team group can do this');
    }
    if (this.busy.has(a.recordId)) return toast('info', 'Already being handled');
    this.busy.add(a.recordId);
    let release = true;
    // Lark gives a card callback about 3 seconds. Anything slower runs here, after the reply,
    // and shows its result on the card; it releases the record when done.
    const later = (step: string, job: () => Promise<void>) => {
      release = false;
      void job()
        .catch((err) => log.fail('provisioner', err, { step, record: a.recordId }))
        .finally(() => this.busy.delete(a.recordId));
    };
    try {
      const req = await this.deps.store.request(a.recordId);
      if (a.cmd === CMD.knowledgeCheck || a.cmd === CMD.goLive) {
        if (req.status !== STATUS.knowledgeSetup) return toast('info', `This request is ${req.status || 'not set up yet'}`);
        if (a.cmd === CMD.goLive) {
          later('go-live', () => this.goLive(req, a));
          return toast('info', 'Going live…');
        }
        later('knowledge-check', () => this.refreshKnowledge(req));
        return toast('info', 'Checking its access again…');
      }
      const open = [STATUS.carded, STATUS.failed, STATUS.submitted, ''] as string[];
      if (!open.includes(req.status)) return toast('info', `This request is already ${req.status}`);
      if (a.cmd === CMD.reject) {
        const reason = a.form.reject_reason?.trim();
        if (!reason) return toast('error', 'Write the reason in "Reason, if rejecting" first');
        later('reject', () => this.reject(req, a, reason));
        return toast('info', 'Rejecting…');
      }
      const reply = await this.approve(req, a);
      // approve() hands the record to the background job, which releases it.
      release = reply.toast.type === 'error';
      return reply;
    } catch (err) {
      log.fail('provisioner', err, { step: a.cmd, record: a.recordId });
      return toast('error', `Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (release) this.busy.delete(a.recordId);
    }
  }

  /** Daily: department bots still in knowledge setup get their access checked again. */
  async daily(): Promise<void> {
    for (const req of await this.deps.store.requestsWithStatus(STATUS.knowledgeSetup)) {
      if (this.busy.has(req.recordId)) continue;
      await this.refreshKnowledge(req).catch((err) =>
        log.fail('provisioner', err, { step: 'knowledge-daily', record: req.recordId }),
      );
    }
  }

  private async knowledge(req: RequestRecord, bot: string): Promise<KnowledgeItem[]> {
    return checkKnowledge(req, (path, params) => this.deps.bots.botGet(bot, path, params));
  }

  private async refreshKnowledge(req: RequestRecord): Promise<void> {
    if (!req.serverBotName) return;
    const items = await this.knowledge(req, req.serverBotName);
    await this.updateCard(req, knowledgeCard({ req, bot: req.serverBotName, items, checkedAt: this.stamp() }));
  }

  private async goLive(req: RequestRecord, a: ActionInput): Promise<void> {
    await this.deps.store.updateRequest(req.recordId, { Status: STATUS.live });
    await this.deps.store.event(req.recordId, 'live', '', a.operatorOpenId);
    const items = req.serverBotName ? await this.knowledge(req, req.serverBotName) : [];
    await this.updateCard(
      req,
      knowledgeCard({ req, bot: req.serverBotName, items, checkedAt: this.stamp(), live: { by: person(a.operatorName, a.operatorOpenId) } }),
    );
  }

  private stamp(): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: process.env.TZ || 'Asia/Kuala_Lumpur',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(this.now());
  }

  private async reject(req: RequestRecord, a: ActionInput, reason: string): Promise<void> {
    const { store } = this.deps;
    await store.updateRequest(req.recordId, {
      Status: STATUS.rejected,
      'Reject reason': reason,
      Approver: [{ id: a.operatorOpenId }],
      'Decided at': this.now(),
      'App Secret': null,
    });
    await store.event(req.recordId, 'rejected', reason, a.operatorOpenId);
    await this.updateCard(req, rejectedCard(req, person(a.operatorName, a.operatorOpenId), reason));
    log.info('provisioner', 'rejected', { record: req.recordId });
  }

  /**
   * Answers the click at once: Lark drops a card callback that takes longer than
   * about 3 seconds, and the checks below make several API calls. Everything
   * after the form check runs in the background and shows up on the card.
   */
  private async approve(req: RequestRecord, a: ActionInput): Promise<ActionReply> {
    // The default account only matters when the select is empty; checked properly below.
    const early = claudeChoice(a.form, 'default');
    if (typeof early === 'string') return toast('error', early);

    const by = person(a.operatorName, a.operatorOpenId);
    void this.approveInBackground(req, a, by)
      .catch((err) => this.fail(req, { kind: 'other', message: err instanceof Error ? err.message : String(err) }))
      .finally(() => this.busy.delete(req.recordId));
    return toast('info', 'Checking the app and setting up the bot…');
  }

  private async approveInBackground(req: RequestRecord, a: ActionInput, by: string): Promise<void> {
    const settings = await this.deps.store.settings();
    const choice = claudeChoice(a.form, settings['Default Claude account'] ?? '');
    if (typeof choice === 'string') return this.fail(req, { kind: 'other', message: choice });
    const account = choice.newSeat ?? choice.apiKey?.label ?? choice.account ?? 'API key';
    await this.updateCard(req, progressCard(req, by, account));

    const secret = a.form.app_secret?.trim() || req.appSecret;
    const checks = await this.check(req, secret);
    const blocker = this.blocker(checks);
    if (blocker) return this.fail(req, blocker, checks);

    await this.deps.store.updateRequest(req.recordId, {
      Status: STATUS.provisioning,
      Approver: [{ id: a.operatorOpenId }],
      'Decided at': this.now(),
    });
    await this.deps.store.event(req.recordId, 'approved', `Claude: ${account}`, a.operatorOpenId);
    log.info('provisioner', 'approved', { record: req.recordId });
    await this.provision(req, secret, choice, by);
  }

  private blocker(checks: Checks): Failure | undefined {
    if (checks.duplicateOf) return { kind: 'in-use', message: `This app already runs as bot ${checks.duplicateOf}` };
    if (checks.owner === 'mismatch') return { kind: 'owner', message: 'The app belongs to someone else, not the requester' };
    if (checks.credentials === 'bad') {
      return { kind: 'secret', message: `Lark rejected the App ID or App Secret${checks.credentialsDetail ? ` (${checks.credentialsDetail})` : ''}` };
    }
    const formIssue = checks.problems.find((p) => p.startsWith('App ID'));
    return formIssue ? { kind: 'other', message: formIssue } : undefined;
  }

  /** Creates the bot. Runs after the card click has been answered. */
  private async provision(req: RequestRecord, secret: string, choice: ClaudeChoice, by: string): Promise<void> {
    const { store, bots } = this.deps;
    const name = freeBotName(
      baseBotName({
        botType: req.botType,
        email: req.requester?.email,
        personName: req.requester?.name,
        department: req.department,
        agentName: req.agentName,
      }),
      await bots.botNames(),
    );

    const resolved = await this.resolveAccount(req, choice, name);
    if ('failure' in resolved) return this.fail(req, resolved.failure);

    const result = await bots.add({
      name,
      appId: req.appId,
      appSecret: secret,
      mode: req.botType === 'Department' ? 'team' : 'personal',
      tenant: this.deps.tenant,
      claudeAccount: resolved.account,
    });
    if (!result.ok) return this.fail(req, addFailure(result), undefined, result.output);

    const claude = result.result?.claude ?? 'failed';
    req.serverBotName = name;
    await store.updateRequest(req.recordId, {
      'Server bot name': name,
      'Claude account': [resolved.recordId],
      'Provision log': JSON.stringify(result.result ?? { ok: true }),
      // Stored in the bot's keystore now; the Base copy goes.
      'App Secret': null,
    });
    await store.event(req.recordId, 'provisioned', `bot ${name}, Claude ${resolved.account}: ${claude}`);
    log.info('provisioner', 'provisioned', { record: req.recordId, bot: name, claude });
    if (req.botType === 'Department') {
      const wrote = await bots.setInstructions(name, starterInstructions(req, name));
      if (wrote.code !== 0) log.warn('provisioner', 'instructions-failed', { record: req.recordId, out: wrote.output });
    }

    if (claude === 'ok') return this.announce(req, by, resolved.account);

    // The bot can't answer yet: no "ready" for the requester, only a note that it's coming.
    // poll() announces it once the seat is signed in.
    await store.updateRequest(req.recordId, { Status: STATUS.waitingClaude });
    if (req.requester?.email) {
      const sent = await bots.sendMessage(name, req.requester.email, pendingText(req));
      if (sent.code !== 0) log.warn('provisioner', 'pending-note-failed', { record: req.recordId, out: sent.output });
    }
    if (choice.apiKey) {
      await store.updateAccount(resolved.recordId, { 'Credential on server': CREDENTIAL.notSaved, 'Last check': 'did not answer' });
    } else {
      // ClaudeAccounts sends the seat's holder the sign-in card.
      await store.updateAccount(resolved.recordId, { 'Credential on server': CREDENTIAL.waiting });
    }
    await this.updateCard(req, waitingCard({ req, by, bot: name, account: resolved.account, apiKey: Boolean(choice.apiKey) }));
  }

  /** The bot answers: tell the requester (Base automation on Ready, and the bot's own welcome). */
  private async announce(req: RequestRecord, by: string, account: string): Promise<void> {
    const { store, bots } = this.deps;
    const bot = req.serverBotName;
    const department = req.botType === 'Department';
    const items = department ? await this.knowledge(req, bot) : [];
    await store.updateRequest(req.recordId, { Status: STATUS.ready });
    if (department) {
      await store.updateRequest(req.recordId, { Status: STATUS.knowledgeSetup });
      await store.event(req.recordId, 'knowledge-setup', `${items.filter((i) => i.ok).length} of ${items.length} reachable`);
    }
    let welcomed = false;
    if (req.requester?.email) {
      const guide = (await store.settings())['User guide'] || DEFAULT_USER_GUIDE;
      const sent = await bots.sendMessage(bot, req.requester.email, welcomeText(req, items, guide));
      welcomed = sent.code === 0;
      if (!welcomed) log.warn('provisioner', 'welcome-failed', { record: req.recordId, out: sent.output });
    }
    await store.event(req.recordId, 'announced', `bot ${bot}`);
    await this.updateCard(
      req,
      department
        ? knowledgeCard({ req, bot, items, checkedAt: this.stamp(), claudeLine: `Claude ${md(account)}: ok` })
        : doneCard({ req, by, bot, account, claude: 'ok' }),
    );
    // A new message, not just the card above: the card may be far up the chat by now.
    await this.deps.cards
      .send(this.deps.approvalChatId, connectedCard({ req, bot, account, welcomed }))
      .catch((err) => log.warn('provisioner', 'connected-notice-failed', { record: req.recordId, err: String(err) }));
  }

  /** Requests waiting for their Claude seat: announced once its credential is saved. */
  private async announceWaiting(): Promise<void> {
    const waiting = await this.deps.store.requestsWithStatus(STATUS.waitingClaude);
    if (!waiting.length) return;
    const accounts = await this.deps.store.accounts();
    for (const req of waiting) {
      const row = accounts.find((a) => req.claudeAccountRecordIds.includes(a.recordId));
      if (!row || row.credential !== CREDENTIAL.saved || !req.serverBotName || this.busy.has(req.recordId)) continue;
      this.busy.add(req.recordId);
      try {
        const by = req.approver ? person(req.approver.name, req.approver.id) : 'an approver';
        await this.announce(req, by, row.account);
        log.info('provisioner', 'announced', { record: req.recordId, bot: req.serverBotName });
      } catch (err) {
        log.fail('provisioner', err, { step: 'announce', record: req.recordId });
      } finally {
        this.busy.delete(req.recordId);
      }
    }
  }

  /** Makes sure the chosen Claude account exists on the server (API key) and in the Base. */
  private async resolveAccount(
    req: RequestRecord,
    choice: ClaudeChoice,
    botName: string,
  ): Promise<{ account: string; recordId: string } | { failure: Failure }> {
    const { store, bots } = this.deps;
    let account: string;
    let fields: Record<string, unknown>;
    if (choice.apiKey) {
      account = choice.apiKey.label ?? `key-${botName}`;
      const saved: RunResult = await bots.setApiKey(account, choice.apiKey.key);
      if (saved.code !== 0) {
        return { failure: { kind: 'other', message: `Couldn't save the API key as ${account}: ${lastLine(saved.output)}` } };
      }
      await store.event(req.recordId, 'api-key-saved', account);
      fields = { Account: account, Kind: 'API key', 'Credential on server': 'Saved' };
    } else {
      account = choice.newSeat ?? (choice.account as string);
      fields = { Account: account, Kind: 'Standard seat', 'Credential on server': 'Not saved' };
    }
    const existing = (await store.accounts()).find((a) => a.account === account);
    if (existing) return { account, recordId: existing.recordId };
    return { account, recordId: await store.createAccount(fields) };
  }

  private async check(req: RequestRecord, secret: string): Promise<Checks> {
    const problems: string[] = [];
    if (!APP_ID_RE.test(req.appId)) problems.push(`App ID "${req.appId}" doesn't look like cli_…`);
    if (req.confirmations.length < 2) problems.push('The requester didn\'t tick both confirmations');
    if (!['Personal', 'Department'].includes(req.botType)) problems.push('Bot type is missing');
    if (req.botType === 'Department') {
      if (!req.department) problems.push('Department is missing');
      if (!req.sensitivity) problems.push('The requester didn\'t confirm the listed content is fine for every member');
    }

    let credentials: Checks['credentials'] = 'unknown';
    let credentialsDetail: string | undefined;
    if (!APP_ID_RE.test(req.appId) || !secret) {
      credentials = 'bad';
      credentialsDetail = secret ? undefined : 'no App Secret';
    } else {
      const v = await this.deps.apps.validate(req.appId, secret).catch((err) => ({
        ok: false,
        reason: String(err),
        network: true,
      }));
      credentials = v.ok ? 'ok' : v.network ? 'unknown' : 'bad';
      credentialsDetail = v.ok ? undefined : v.reason;
    }

    let owner: Checks['owner'] = 'unknown';
    if (credentials === 'ok') {
      const [ownerId, requesterId] = await Promise.all([
        this.deps.apps.ownerUnionId(req.appId, secret).catch(() => undefined),
        this.deps.store.requesterUnionId(req.recordId).catch(() => undefined),
      ]);
      if (ownerId && requesterId) owner = ownerId === requesterId ? 'match' : 'mismatch';
    }

    const duplicateOf = APP_ID_RE.test(req.appId) ? await this.deps.bots.botForApp(req.appId) : undefined;
    return { credentials, credentialsDetail, owner, duplicateOf, problems };
  }

  private async requestCard(req: RequestRecord, checks: Checks, failure?: Failure): Promise<object> {
    const [accounts, settings] = await Promise.all([this.deps.store.accounts(), this.deps.store.settings()]);
    const bought = Number.parseInt(settings['Team seats bought'] ?? '', 10);
    const seats: SeatUse = {
      bought: Number.isFinite(bought) ? bought : undefined,
      inUse: accounts.filter(isSeat).length,
    };
    return requestCard({
      req,
      checks,
      accounts,
      defaultAccount: settings['Default Claude account'] ?? '',
      seats,
      failure,
    });
  }

  private async fail(req: RequestRecord, failure: Failure, checks?: Checks, output?: string): Promise<void> {
    log.warn('provisioner', 'failed', { record: req.recordId, kind: failure.kind, message: failure.message });
    try {
      await this.deps.store.updateRequest(req.recordId, {
        Status: STATUS.failed,
        'Provision log': output ? `${failure.message}\n\n${output}` : failure.message,
      });
      await this.deps.store.event(req.recordId, 'failed', failure.message);
      const fresh = checks ?? (await this.check(req, req.appSecret));
      // The time makes a Retry that fails the same way visibly change the card.
      const shown = { ...failure, message: `${failure.message} (${this.stamp()})` };
      await this.updateCard(req, await this.requestCard(req, fresh, shown));
    } catch (err) {
      log.fail('provisioner', err, { step: 'fail', record: req.recordId });
    }
  }

  private async updateCard(req: RequestRecord, card: object): Promise<void> {
    if (req.cardMessageId) {
      await this.deps.cards.update(req.cardMessageId, card);
      return;
    }
    const messageId = await this.deps.cards.send(this.deps.approvalChatId, card);
    req.cardMessageId = messageId;
    await this.deps.store.updateRequest(req.recordId, { 'Card message ID': messageId });
  }
}

/** The bot's note to its requester while its Claude account is being connected. */
function pendingText(req: RequestRecord): string {
  return (
    `Hi! I'm ${req.agentName || 'your AI agent'}. I'm set up, but I can't answer yet: ` +
    "the AI Team is connecting my Claude account. I'll message you again as soon as I'm ready."
  );
}

/** How to use the bot; the Base Settings row "User guide" overrides it. */
export const DEFAULT_USER_GUIDE = 'https://gdexgroup.sg.larksuite.com/wiki/Jh7owFCemi3GO7kBBeblkcydg7c';

/** The new bot's first DM to its requester, once it can answer. */
function welcomeText(req: RequestRecord, items: KnowledgeItem[], guide: string): string {
  const name = req.agentName || 'your AI agent';
  const howTo = `How to get the most out of me: ${guide}`;
  if (req.botType !== 'Department') {
    return [
      `Hi! I'm ${name}, and I'm ready: you can start chatting with me now. Ask me anything, e.g. "what's on my calendar today?".`,
      'The first time I need your mail, calendar or documents I\'ll send you a sign-in link.',
      howTo,
    ].join('\n\n');
  }
  const missing = items.filter((i) => i.ok !== true).map((i) => `- ${i.label}`);
  return [
    `Hi! I'm ${name}, set up for ${req.department || 'your department'}, and I'm ready to answer.`,
    missing.length
      ? `I can't open these yet. Please add me ("${name}") as a collaborator on the documents, a member of the wiki spaces, and to the groups:\n${missing.join('\n')}`
      : 'I can open everything listed on your request.',
    'The AI Team will try a few questions with someone from your department before we tell everyone.',
    howTo,
  ].join('\n\n');
}

function lastLine(output: string): string {
  const lines = output.trim().split(/\r?\n/);
  return lines[lines.length - 1] ?? '';
}

/** The line of lark-bots.sh output that says what went wrong, for the card. */
export function errorLine(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('{') && !/removing the half-made bot/.test(l));
  return [...lines].reverse().find((l) => /error|denied|failed|not found|cannot|can't|refused|timed out/i.test(l));
}

function addFailure(r: AddResult): Failure {
  const reported = r.result?.error;
  const detail = errorLine(r.output);
  // A command failing under set -e only says "a command failed"; the output says which.
  const message =
    reported && !reported.startsWith('a command failed')
      ? reported
      : `${r.result?.step ? `${r.result.step}: ` : ''}${detail ?? reported ?? `lark-bots.sh add failed (exit ${r.code})`}`;
  if (r.code === EXIT.larkApp) return { kind: 'secret', message };
  if (r.code === EXIT.inUse) return { kind: 'in-use', message };
  return { kind: 'other', message };
}
