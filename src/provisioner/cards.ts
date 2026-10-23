import type { ClaudeAccount, RequestRecord } from './base-store';
import type { KnowledgeItem } from './knowledge';

/** Card action commands; the value also carries the Requests record id. */
export const CMD = {
  approve: 'prov.approve',
  reject: 'prov.reject',
  /** Claude sign-in card: the code pasted back. Value carries the account. */
  claudeCode: 'prov.claude_code',
  /** Claude sign-in card: start over with a new link. */
  claudeRelink: 'prov.claude_relink',
  /** Department bot checklist: check its access again. */
  knowledgeCheck: 'prov.knowledge_check',
  /** Department bot checklist: the pilot went well. */
  goLive: 'prov.go_live',
} as const;

export interface Checks {
  /** App ID and Secret got a tenant token. */
  credentials: 'ok' | 'bad' | 'unknown';
  credentialsDetail?: string;
  /** App owner vs form submitter. */
  owner: 'match' | 'mismatch' | 'unknown';
  /** A bot already running this app. */
  duplicateOf?: string;
  /** The requester's Claude account against the seat list (Claude Accounts). */
  claude?: { email: string; holder?: string; state: 'connected' | 'seat' | 'unknown' };
  /** Missing or invalid form answers. */
  problems: string[];
}

export interface SeatUse {
  bought?: number;
  inUse: number;
}

export interface Failure {
  /** secret: Lark rejected the App ID/Secret; owner: not the submitter's app; other: anything else. */
  kind: 'secret' | 'owner' | 'in-use' | 'other';
  message: string;
}

const MAX_FIELD = 300;

/** User text made safe for card markdown: no tags, no formatting, bounded. */
export function md(s: string | undefined): string {
  if (!s) return '—';
  const t = s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
  return t
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/([\\`*_~[\]()#|])/g, '\\$1');
}

/**
 * Who clicked, as card markdown: their name, or an @-mention when Lark leaves the
 * name out of the callback (it shows as their name in the card).
 */
export function person(name: string | undefined, openId: string): string {
  if (name?.trim()) return md(name.trim());
  return /^ou_[A-Za-z0-9]+$/.test(openId) ? `<at id=${openId}></at>` : 'an approver';
}

export function credentialsUrl(appId: string): string {
  return `https://open.larksuite.com/app/${encodeURIComponent(appId)}/baseinfo`;
}

function header(title: string, template: string): object {
  return { title: { tag: 'plain_text', content: title }, template };
}

function card(title: string, template: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: title } },
    header: header(title, template),
    body: { elements },
  };
}

function summary(req: RequestRecord): string {
  const who = req.requester ? `${md(req.requester.name)}${req.requester.email ? ` (${md(req.requester.email)})` : ''}` : '—';
  const lines = [
    `**Requester:** ${who}`,
    `**Type:** ${md(req.botType)}`,
    `**Agent name:** ${md(req.agentName)}`,
    `**App ID:** ${md(req.appId)}`,
  ];
  if (req.botType === 'Department') {
    lines.push(
      `**Department:** ${md(req.department)}`,
      `**Purpose:** ${md(req.purpose)}`,
      `**Documents:** ${md(req.documents)}`,
      `**Wiki pages:** ${md(req.wikiPages)}`,
      `**Group chats:** ${md(req.groupChats)}`,
    );
  }
  return lines.join('\n');
}

function checkLines(checks: Checks): string {
  const lines: string[] = [];
  lines.push(
    checks.credentials === 'ok'
      ? '✅ App ID and App Secret accepted by Lark'
      : checks.credentials === 'bad'
        ? `❌ Lark rejected the App ID or App Secret${checks.credentialsDetail ? ` (${md(checks.credentialsDetail)})` : ''}`
        : '⚠️ Couldn\'t check the App ID and App Secret',
  );
  lines.push(
    checks.owner === 'match'
      ? '✅ The app belongs to the requester'
      : checks.owner === 'mismatch'
        ? '❌ The app belongs to someone else, not the requester'
        : '⚠️ Couldn\'t confirm who owns the app',
  );
  if (checks.duplicateOf) lines.push(`❌ This app already runs as bot **${md(checks.duplicateOf)}**`);
  const c = checks.claude;
  if (c) {
    const who = c.holder ? ` (signs in: ${md(c.holder)})` : '';
    lines.push(
      c.state === 'connected'
        ? `✅ Claude account **${md(c.email)}**${who} is connected on the server`
        : c.state === 'seat'
          ? `☑️ Claude account **${md(c.email)}**${who} is a GDEX seat, not connected yet: Approve sends its holder the Connect Claude card`
          : `⚠️ Claude account **${md(c.email)}**${who} isn't in the seat list yet: add it in the Claude admin console (PR approved) before you Approve`,
    );
  }
  for (const p of checks.problems) lines.push(`⚠️ ${md(p)}`);
  return lines.join('\n');
}

function seatLine(seats: SeatUse): string {
  if (seats.bought === undefined) return `Seats in use: ${seats.inUse} (set "Team seats bought" in the Base Settings table to get a warning when none are free)`;
  const free = seats.bought - seats.inUse;
  return free > 0
    ? `Seats: ${seats.inUse} of ${seats.bought} in use, ${free} free`
    : `⚠️ Seats: ${seats.inUse} of ${seats.bought} in use, **none free**: a new seat needs one bought first`;
}

function accountOptions(accounts: ClaudeAccount[]): object[] {
  return accounts
    .filter((a) => a.account)
    .map((a) => ({
      text: { tag: 'plain_text', content: `${a.account} · ${a.kind || '?'} · ${a.botRecordIds.length} bot(s)` },
      value: a.account,
    }));
}

function input(name: string, label: string, placeholder: string, extra: object = {}): object {
  return {
    tag: 'input',
    name,
    label: { tag: 'plain_text', content: label },
    label_position: 'top',
    placeholder: { tag: 'plain_text', content: placeholder },
    ...extra,
  };
}

function submitButton(text: string, type: string, cmd: string, recordId: string, name: string): object {
  return {
    tag: 'column',
    width: 'auto',
    elements: [
      {
        tag: 'button',
        name,
        text: { tag: 'plain_text', content: text },
        type,
        form_action_type: 'submit',
        behaviors: [{ type: 'callback', value: { cmd, record: recordId } }],
      },
    ],
  };
}

/**
 * The approval card, and the same card again after a failed attempt (with the
 * error on top). Approve and Reject submit one form: the Claude choice, an
 * optional corrected App Secret, and the reject reason.
 */
export function requestCard(opts: {
  req: RequestRecord;
  checks: Checks;
  accounts: ClaudeAccount[];
  defaultAccount: string;
  seats: SeatUse;
  failure?: Failure;
}): object {
  const { req, checks, accounts, failure } = opts;
  const elements: object[] = [];
  if (failure) {
    elements.push({ tag: 'markdown', content: `❌ **Not provisioned:** ${md(failure.message)}` });
  }
  elements.push({ tag: 'markdown', content: summary(req) }, { tag: 'markdown', content: checkLines(checks) });

  const secretWrong = failure?.kind === 'secret' || checks.credentials === 'bad';
  if (secretWrong) {
    elements.push(
      {
        tag: 'markdown',
        content:
          'Open the app\'s credentials page as **ai@gdexpress.com** (a collaborator on the app), copy the App Secret and paste it below, then Approve.',
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: 'Open app credentials' },
        type: 'default',
        behaviors: [{ type: 'open_url', default_url: credentialsUrl(req.appId) }],
      },
    );
  }

  const options = accountOptions(accounts);
  // The requester's Claude account is offered even before it's in the seat list.
  if (req.claudeEmail && !accounts.some((a) => a.account === req.claudeEmail)) {
    options.unshift({ text: { tag: 'plain_text', content: `${req.claudeEmail} · requester's account (new seat)` }, value: req.claudeEmail });
  }
  const initial = options.some((o) => (o as { value: string }).value === opts.defaultAccount)
    ? opts.defaultAccount
    : undefined;
  const formElements: object[] = [];
  if (secretWrong) {
    formElements.push(
      input('app_secret', 'Corrected App Secret', 'Paste the App Secret from the credentials page', {
        input_type: 'password',
      }),
    );
  }
  formElements.push(
    { tag: 'markdown', content: `**Claude account**\n${seatLine(opts.seats)}` },
    {
      tag: 'select_static',
      name: 'claude_account',
      placeholder: { tag: 'plain_text', content: 'Seat or API key' },
      ...(initial ? { initial_option: initial } : {}),
      options,
    },
    input('new_seat', 'Or a new seat', 'Seat email, e.g. abc@gdexpress.com (assign it in the Claude admin console first)'),
    input('api_key', 'Or a new API key', 'sk-ant-api… from the Claude Console', { input_type: 'password' }),
    input('api_key_label', 'Name for the new API key', 'e.g. key-dept-hr (default: key-<bot name>)'),
    input('reject_reason', 'Reason, if rejecting', 'Sent to the requester'),
    {
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: [
        submitButton(failure ? 'Retry' : 'Approve', 'primary', CMD.approve, req.recordId, 'approve_btn'),
        submitButton('Reject', 'danger', CMD.reject, req.recordId, 'reject_btn'),
      ],
    },
  );
  elements.push({ tag: 'form', name: 'request_form', elements: formElements });

  const title = `${failure ? 'Needs attention' : 'New AI agent request'} ${req.requestId}`.trim();
  return card(title, failure ? 'red' : 'blue', elements);
}

export function progressCard(req: RequestRecord, by: string, account: string): object {
  return card(`Setting up ${req.requestId}`.trim(), 'wathet', [
    { tag: 'markdown', content: summary(req) },
    {
      tag: 'markdown',
      content: `⏳ Approved by ${by} · Claude account **${md(account)}**\nCreating the bot on the server; this takes a minute or two.`,
    },
  ]);
}

export function doneCard(opts: {
  req: RequestRecord;
  by: string;
  bot: string;
  account: string;
  claude: 'ok' | 'failed' | 'missing';
}): object {
  const { req } = opts;
  const claudeLine =
    opts.claude === 'ok'
      ? `✅ Claude answers on **${md(opts.account)}**`
      : opts.claude === 'missing'
        ? `⏳ **${md(opts.account)}** has no Claude token on the server yet: the bot can't answer until its holder signs in (Claude sign-in card).`
        : `⚠️ Claude didn't answer on **${md(opts.account)}**: check with \`./lark-bots.sh claude-account check ${md(opts.account)}\``;
  const next =
    req.botType === 'Department'
      ? '\nNext: the department shares the listed documents and wiki pages with the bot (knowledge setup).'
      : '';
  return card(`Ready: ${req.requestId}`.trim(), 'green', [
    { tag: 'markdown', content: summary(req) },
    {
      tag: 'markdown',
      content: `✅ Approved by ${opts.by} · running as **${md(opts.bot)}**\n${claudeLine}\nThe requester has been told.${next}`,
    },
  ]);
}

/**
 * A department bot between Ready and Live: what it can read so far, and the
 * steps only people can do (plan §4).
 */
export function knowledgeCard(opts: {
  req: RequestRecord;
  bot: string;
  items: KnowledgeItem[];
  checkedAt: string;
  claudeLine?: string;
  live?: { by: string };
}): object {
  const { req, items } = opts;
  const mark = (i: KnowledgeItem) => (i.ok === true ? '✅' : i.ok === false ? '❌' : '❔');
  const readable = items.filter((i) => i.ok === true).length;
  const list = items.length
    ? items.map((i) => `${mark(i)} ${i.kind === 'group' ? 'Group' : i.kind === 'wiki' ? 'Wiki' : 'Doc'}: ${md(i.label)}`).join('\n')
    : 'No documents, wiki pages or groups were listed on the form.';
  const elements: object[] = [
    { tag: 'markdown', content: summary(req) },
    {
      tag: 'markdown',
      content: [
        `Running as **${md(opts.bot)}**${opts.claudeLine ? ` · ${opts.claudeLine}` : ''}`,
        '',
        `**What it can reach** (${readable} of ${items.length}, checked ${md(opts.checkedAt)}):`,
        list,
        '',
        '❌ means the bot can\'t open it yet: the owner adds the bot as a collaborator (documents), a member (wiki space) or adds it to the group. ❔: not a link the check understands.',
        '',
        '**Still for people:** confirm the content is fine for every member · edit its instructions if needed (`./lark-bots.sh set-instructions ' +
          md(opts.bot) + ' --force`) · a pilot with a member who isn\'t the app owner.',
      ].join('\n'),
    },
  ];
  if (opts.live) {
    elements.push({ tag: 'markdown', content: `✅ **Live**, confirmed by ${opts.live.by}.` });
    return card(`Live: ${req.requestId}`.trim(), 'green', elements);
  }
  elements.push({
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: [
      buttonColumn('Check again', 'default', CMD.knowledgeCheck, req.recordId),
      buttonColumn('Go live', 'primary', CMD.goLive, req.recordId),
    ],
  });
  return card(`Knowledge setup: ${req.requestId}`.trim(), 'purple', elements);
}

function buttonColumn(text: string, type: string, cmd: string, recordId: string): object {
  return {
    tag: 'column',
    width: 'auto',
    elements: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: text },
        type,
        behaviors: [{ type: 'callback', value: { cmd, record: recordId } }],
      },
    ],
  };
}

/**
 * Claude sign-in for one seat. Only that seat's holder can approve the link;
 * the code they paste back goes to the running `claude setup-token`.
 */
export function signInCard(opts: { account: string; url: string; validMinutes: number; note?: string; error?: string }): object {
  const elements: object[] = [];
  if (opts.error) elements.push({ tag: 'markdown', content: `❌ ${md(opts.error)}` });
  if (opts.note) elements.push({ tag: 'markdown', content: md(opts.note) });
  elements.push(
    {
      tag: 'markdown',
      content: [
        `The AI agents on **${md(opts.account)}** need its Claude sign-in (valid one year).`,
        `1. Open the link below in a browser **signed in to claude.ai as ${md(opts.account)}** and approve.`,
        '2. Copy the code the page shows and paste it here.',
        `Only this card's current link works, for about ${opts.validMinutes} minutes: a code from an earlier link is rejected.`,
      ].join('\n'),
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: 'Open the Claude sign-in' },
      type: 'primary',
      behaviors: [{ type: 'open_url', default_url: opts.url }],
    },
    {
      tag: 'form',
      name: 'claude_form',
      elements: [
        input('code', 'Code from the page', 'Paste the code here', { input_type: 'password' }),
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: 'small',
          columns: [
            submitButton('Save', 'primary', CMD.claudeCode, opts.account, 'code_btn'),
            submitButton('Send a new link', 'default', CMD.claudeRelink, opts.account, 'relink_btn'),
          ],
        },
      ],
    },
  );
  return card(`Connect Claude: ${opts.account}`, 'orange', elements);
}

export function signInExpiredCard(account: string, reason: string): object {
  return card(`Connect Claude: ${account}`, 'grey', [
    { tag: 'markdown', content: `${md(reason)}\nTap below for a new link.` },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: 'Send a new link' },
      type: 'primary',
      behaviors: [{ type: 'callback', value: { cmd: CMD.claudeRelink, record: account } }],
    },
  ]);
}

export function signInDoneCard(account: string, bots: string): object {
  return card(`Claude connected: ${account}`, 'green', [
    {
      tag: 'markdown',
      content: `✅ Saved the Claude sign-in for **${md(account)}** (valid one year).${bots ? `\nRestarted: ${md(bots)}` : ''}\nA new card comes 30 days before it expires.`,
    },
  ]);
}

export function noticeCard(title: string, text: string): object {
  return card(title, 'red', [{ tag: 'markdown', content: md(text) }]);
}

/** Posted in the AI Team group when a bot is connected to Claude and its requester welcomed. */
export function connectedCard(opts: { req: RequestRecord; bot: string; account: string; welcomed: boolean }): object {
  const { req } = opts;
  const who = req.requester?.name ? md(req.requester.name) : 'The requester';
  return card(`Connected: ${req.agentName || req.requestId}`, 'green', [
    {
      tag: 'markdown',
      content: [
        `✅ **${md(req.agentName || opts.bot)}** (${md(req.requestId)}) is connected to Claude on **${md(opts.account)}** and answering, as bot **${md(opts.bot)}**.`,
        opts.welcomed
          ? `${who} has been sent the welcome message with the user guide.`
          : `⚠️ The welcome message to ${who} didn't go out; the Base still sent its "ready" message.`,
      ].join('\n'),
    },
  ]);
}

/** Bot created, but its Claude account can't answer yet; the requester hasn't been told. */
export function waitingCard(opts: { req: RequestRecord; by: string; bot: string; account: string; apiKey: boolean }): object {
  const { req } = opts;
  const next = opts.apiKey
    ? `The API key **${md(opts.account)}** didn't answer. Check it with \`./lark-bots.sh claude-account check ${md(opts.account)}\`, set it again if needed, then set its "Credential on server" to Saved in the Base.`
    : `**${md(opts.account)}** has no Claude token on the server yet. Its holder gets a "Connect Claude" card; once they finish it, the requester is told.`;
  return card(`Waiting for Claude: ${req.requestId}`.trim(), 'yellow', [
    { tag: 'markdown', content: summary(req) },
    {
      tag: 'markdown',
      content: `✅ Approved by ${opts.by} · created as **${md(opts.bot)}**\n⏳ ${next}\nThe requester has been told it's set up but not ready yet; the welcome follows once it can answer.`,
    },
  ]);
}

export function rejectedCard(req: RequestRecord, by: string, reason: string): object {
  return card(`Rejected: ${req.requestId}`.trim(), 'grey', [
    { tag: 'markdown', content: summary(req) },
    { tag: 'markdown', content: `Rejected by ${by}: ${md(reason)}\nThe requester has been told.` },
  ]);
}
