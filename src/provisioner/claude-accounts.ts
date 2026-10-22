import { log } from '../core/logger';
import { CREDENTIAL, type ClaudeAccount } from './base-store';
import { CMD, noticeCard, signInCard, signInDoneCard, signInExpiredCard } from './cards';
import type { RunResult } from './lark-bots';
import type { ActionInput, ActionReply, CardPort, MembersPort, Store } from './service';
import type { SetupTokenSession, SetupTokenStarter } from './setup-token';

const DAY_MS = 24 * 60 * 60_000;
/** setup-token's link is good for a while; the card says so and a session is dropped after it. */
export const SESSION_MINUTES = 15;
const RENEW_BEFORE_MS = 30 * DAY_MS;
const TOKEN_LIFETIME_MS = 365 * DAY_MS;

export interface AccountsDeps {
  store: Pick<Store, 'accounts' | 'settings'> & {
    updateAccount(recordId: string, fields: Record<string, unknown>): Promise<void>;
  };
  cards: CardPort;
  members: MembersPort;
  bots: {
    setToken(account: string, token: string): Promise<RunResult>;
    checkAccount(account: string): Promise<RunResult>;
  };
  setupToken: SetupTokenStarter;
  approvalChatId: string;
  now?: () => number;
}

interface Live {
  session: SetupTokenSession;
  messageId: string;
  startedAt: number;
  /** dm: the holder's own chat; group: the AI Team group fallback (or unknown, after a restart). */
  where?: 'dm' | 'group';
}

const isSeat = (a: ClaudeAccount) => /seat/i.test(a.kind);
const toast = (type: ActionReply['toast']['type'], content: string): ActionReply => ({ toast: { type, content } });

/**
 * Seat sign-ins and the daily account check (docs/bot-provisioning-plan.md §5.3–5.4).
 * A seat whose "Credential on server" is "Waiting for sign-in" gets a Claude
 * sign-in card: in a DM to its holder, or in the AI Team group for seats the
 * team holds. The code pasted back finishes `claude setup-token` and the token
 * is saved for every bot on the seat.
 */
export class ClaudeAccounts {
  private readonly live = new Map<string, Live>();
  private readonly busy = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: AccountsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Sends a sign-in card for every seat waiting for one. */
  async poll(): Promise<void> {
    const accounts = await this.deps.store.accounts();
    for (const a of accounts) {
      if (!isSeat(a) || a.credential !== CREDENTIAL.waiting || !a.account || this.busy.has(a.account)) continue;
      const current = this.live.get(a.account);
      if (current && this.now() - current.startedAt < SESSION_MINUTES * 60_000) continue;
      // A card from before a restart: don't send another every poll.
      if (!current && a.signInSentAt && this.now() - a.signInSentAt < SESSION_MINUTES * 60_000) continue;
      await this.start(a).catch((err) => log.fail('provisioner', err, { step: 'claude-signin', account: a.account }));
    }
  }

  /** Daily: does every saved credential still answer, and which seats are due for renewal. */
  async daily(): Promise<void> {
    for (const a of await this.deps.store.accounts()) {
      if (!a.account || a.credential !== CREDENTIAL.saved) continue;
      const r = await this.deps.bots.checkAccount(a.account);
      const ok = r.code === 0;
      await this.deps.store.updateAccount(a.recordId, {
        'Last check': ok ? 'ok' : lastLine(r.output).slice(0, 500),
        'Last check at': this.now(),
      });
      if (!ok) {
        await this.deps.cards.send(
          this.deps.approvalChatId,
          noticeCard(
            `Claude account not answering: ${a.account}`,
            `${a.account} (${a.botRecordIds.length} bot(s)) failed its daily check: ${lastLine(r.output)}. ` +
              'For a seat, set its "Credential on server" to "Waiting for sign-in" in the Base to get a new sign-in card.',
          ),
        );
      }
      if (isSeat(a) && a.tokenExpires && a.tokenExpires - this.now() < RENEW_BEFORE_MS) {
        // The old token keeps working until it expires; this only asks for a new sign-in card.
        await this.deps.store.updateAccount(a.recordId, { 'Credential on server': CREDENTIAL.waiting });
        log.info('provisioner', 'claude-renewal-due', { account: a.account, expires: a.tokenExpires });
      }
    }
  }

  async handleAction(a: ActionInput): Promise<ActionReply | undefined> {
    if (a.cmd !== CMD.claudeCode && a.cmd !== CMD.claudeRelink) return undefined;
    const account = a.recordId;
    // Group cards: members only. A DM card reaches only the seat's holder.
    if (a.chatId === this.deps.approvalChatId && !(await this.deps.members.isMember(a.chatId, a.operatorOpenId))) {
      return toast('error', 'Only members of the AI Team group can do this');
    }
    if (this.busy.has(account)) return toast('info', 'Already working on it');
    const code = a.form.code?.trim() ?? '';
    if (a.cmd === CMD.claudeCode && !code) return toast('error', 'Paste the code from the Claude page first');
    // Both take longer than Lark's ~3 s for a card reply (Docker, Claude), so they
    // run after the reply and show their result on the card.
    this.busy.add(account);
    const where = a.chatId === this.deps.approvalChatId ? 'group' : 'dm';
    const job =
      a.cmd === CMD.claudeRelink ? () => this.relink(account, a.messageId, where) : () => this.saveCode(account, code, a.messageId);
    void job()
      .catch(async (err) => {
        log.fail('provisioner', err, { step: a.cmd, account });
        if (a.messageId) {
          await this.deps.cards
            .update(a.messageId, signInExpiredCard(account, err instanceof Error ? err.message : String(err)))
            .catch(() => undefined);
        }
      })
      .finally(() => this.busy.delete(account));
    return toast('info', a.cmd === CMD.claudeRelink ? 'Getting a new link…' : 'Checking the code with Claude…');
  }

  private async relink(account: string, messageId: string | undefined, where: 'dm' | 'group'): Promise<void> {
    const row = (await this.deps.store.accounts()).find((x) => x.account === account);
    if (!row) throw new Error(`${account} is no longer in the Claude Accounts table`);
    const live = this.live.get(account);
    live?.session.cancel();
    // Replace the card that was clicked, also when the session is gone (a restart).
    if (!live && messageId) {
      this.live.set(account, { session: { url: '', submit: async () => '', cancel: () => undefined }, messageId, startedAt: 0, where });
    }
    await this.start(row);
  }

  private async saveCode(account: string, code: string, messageId?: string): Promise<void> {
    const live = this.live.get(account);
    if (!live || !live.session.url || this.now() - live.startedAt > SESSION_MINUTES * 60_000) {
      live?.session.cancel();
      this.live.delete(account);
      const target = live?.messageId ?? messageId;
      if (target) await this.deps.cards.update(target, signInExpiredCard(account, 'This link has expired.'));
      return;
    }
    let token: string;
    try {
      token = await live.session.submit(code);
    } catch (err) {
      this.live.delete(account);
      const why = err instanceof Error ? err.message : String(err);
      const extra = err as { screen?: string[]; raw?: string };
      log.warn('provisioner', 'claude-code-rejected', { account, why, screen: extra.screen, raw: extra.raw });
      const hint = /rejected/.test(why)
        ? ` Usually the code came from an earlier link, or the link was approved while signed in as someone other than ${account}.`
        : '';
      await this.deps.cards.update(live.messageId, signInExpiredCard(account, `${why}${hint}`));
      return;
    }
    this.live.delete(account);

    const saved = await this.deps.bots.setToken(account, token);
    if (saved.code !== 0) {
      await this.deps.cards.update(live.messageId, signInExpiredCard(account, `Couldn't save the token on the server: ${lastLine(saved.output)}`));
      return;
    }
    const row = (await this.deps.store.accounts()).find((x) => x.account === account);
    if (row) {
      await this.deps.store.updateAccount(row.recordId, {
        'Credential on server': CREDENTIAL.saved,
        'Token expires': this.now() + TOKEN_LIFETIME_MS,
        'Last check': 'token saved',
        'Last check at': this.now(),
      });
    }
    const restarted = /restarted (\S+)/g;
    const bots = [...saved.output.matchAll(restarted)].map((m) => m[1]).join(', ');
    await this.deps.cards.update(live.messageId, signInDoneCard(account, bots));
    if (live.where === 'dm') {
      // Signed in from the holder's DM: the AI Team group hasn't seen it happen.
      await this.deps.cards
        .send(this.deps.approvalChatId, signInDoneCard(account, bots))
        .catch((err) => log.warn('provisioner', 'claude-connected-notice-failed', { account, err: String(err) }));
    }
    log.info('provisioner', 'claude-token-saved', { account, bots });
  }

  private async start(a: ClaudeAccount): Promise<void> {
    this.busy.add(a.account);
    try {
      const session = await this.deps.setupToken();
      // Only the seat's holder can approve the link, so the card goes to them: the Holder
      // set in Claude Accounts, else the seat's email (its Lark account). The group is the
      // fallback when Lark won't deliver the DM (the app isn't available to them).
      const target = a.holder?.id ?? (a.account.includes('@') ? a.account : undefined);
      const card = signInCard({ account: a.account, url: session.url, validMinutes: SESSION_MINUTES });

      const note = target
        ? `Couldn't message ${a.account} directly: add them to the AI Agent Admin app's availability, ` +
          'or whoever is signed in to claude.ai as this seat can finish it here.'
        : `No Lark account is known for ${a.account}: set its Holder in the Claude Accounts table to send this to them directly.`;
      const groupCard = signInCard({ account: a.account, url: session.url, validMinutes: SESSION_MINUTES, note });

      let messageId: string | undefined;
      let where: Live['where'] = 'dm';
      const existing = this.live.get(a.account);
      // The new link replaces the old one: end the old setup-token instead of leaving it running.
      existing?.session.cancel();
      // A DM card is refreshed in place. A group fallback tries the DM again each time,
      // so it moves to the holder once the app's availability includes them.
      if (existing?.where === 'dm') {
        await this.deps.cards.update(existing.messageId, card).then(() => (messageId = existing.messageId)).catch(() => undefined);
      }
      if (!messageId && target) {
        messageId = await this.deps.cards.send(target, card).catch((err) => {
          log.warn('provisioner', 'claude-signin-dm-failed', { account: a.account, err: String(err) });
          return undefined;
        });
        if (messageId && existing && existing.where !== 'dm') {
          await this.deps.cards
            .update(existing.messageId, signInExpiredCard(a.account, `Sent to ${a.account} directly.`))
            .catch(() => undefined);
        }
      }
      if (!messageId) {
        where = 'group';
        if (existing && existing.where !== 'dm') {
          await this.deps.cards.update(existing.messageId, groupCard).then(() => (messageId = existing.messageId)).catch(() => undefined);
        }
        messageId ??= await this.deps.cards.send(this.deps.approvalChatId, groupCard);
      }
      this.live.set(a.account, { session, messageId, startedAt: this.now(), where });
      await this.deps.store.updateAccount(a.recordId, { 'Sign-in sent at': this.now() });
      log.info('provisioner', 'claude-signin-sent', { account: a.account, to: where === 'dm' ? target : 'group' });
    } finally {
      this.busy.delete(a.account);
    }
  }
}

function lastLine(output: string): string {
  const lines = output.trim().split(/\r?\n/);
  return lines[lines.length - 1] ?? '';
}
