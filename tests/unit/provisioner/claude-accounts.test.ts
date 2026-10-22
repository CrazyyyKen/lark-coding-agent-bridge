import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount } from '../../../src/provisioner/base-store';
import { ClaudeAccounts, type AccountsDeps } from '../../../src/provisioner/claude-accounts';
import { dockerSetupToken, findAuthorizeUrl, findToken, screenLines } from '../../../src/provisioner/setup-token';

const CHAT = 'oc_approvals';
const URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz_U';
const TOKEN = 'sk-ant-oat01-AbCdEf0123456789_-AbCdEf0123456789';

describe('setup-token output', () => {
  it('finds the link in the OSC 8 hyperlink even when the visible text is wrapped', () => {
    const raw = `Browser didn't open?\r\n\u001b]8;id=e1;${URL}\u0007https://claude.com/cai/oauth/auth\r\norize?code=tr\u001b]8;;\u0007\r\nPaste code here if prompted >`;
    expect(findAuthorizeUrl(raw)).toBe(URL);
    expect(findAuthorizeUrl(`plain ${URL} next`)).toBe(URL);
    expect(findAuthorizeUrl('Welcome to Claude Code')).toBeUndefined();
  });

  it('summarises the screen for the card: readable lines, cursor moves as spaces, tokens masked', () => {
    const raw =
      '\u001b[2GPaste\u001b[8Gcode\u001b[13Ghere\u001b[30G>\r\n\u001b[?2004h\u001b[31C\u001b[1A*****gstate\r\n' +
      '\u001b[38;5;153mSelect\u001b[8Gan\u001b[11Gorganization\u001b[39m\r\nSelect an organization\r\n' +
      `\u001b]8;id=1;${URL}\u0007link\u001b]8;;\u0007\r\n${TOKEN}\r\n`;
    expect(screenLines(raw)).toEqual([
      'Paste code here >',
      '*****gstate',
      'Select an organization',
      'link',
      'sk-ant-…(masked)',
    ]);
  });

  it('finds the token through colour codes', () => {
    expect(findToken(`\u001b[32m✓ Long-lived token created:\u001b[0m\r\n${TOKEN}\r\nStore it safely`)).toBe(TOKEN);
    expect(findToken('nothing yet')).toBeUndefined();
  });

  it('rejects a wrong code as soon as Claude prints its OAuth error (it then waits for Enter)', async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    stdin.on('data', () =>
      // Captured from claude setup-token on the server with a wrong code.
      stdout.write('\u001b[1C\u001b[4A\u001b[38;5;211mOAuth error: Request failed with status code 400\u001b[39m\u001b[K\r\n\u001b[38;5;153mPress \u001b[1mEnter\u001b[22m to retry.'),
    );
    const child = Object.assign(new EventEmitter(), {
      stdout, stderr: new PassThrough(), stdin, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn(),
    });
    const spawn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const pending = dockerSetupToken('lark-bot:latest', spawn)();
    stdout.write(`\u001b]8;id=1;${URL}\u0007\r\nPaste code here if prompted >`);
    const session = await pending;
    await expect(session.submit('wrong')).rejects.toThrow('Claude rejected the code (OAuth error: Request failed with status code 400).');
    expect(child.kill).toHaveBeenCalled();
    // Killing the docker client leaves the container running; it is removed by name.
    const calls = (spawn as unknown as { mock: { calls: Array<[string, string[]]> } }).mock.calls;
    const name = calls[0]?.[1][calls[0][1].indexOf('--name') + 1];
    expect(name).toMatch(/^lark-claude-signin-[0-9a-f]{8}$/);
    expect(calls.some(([, args]) => args.join(' ') === `rm -f ${name}`)).toBe(true);
  });

  it('drives the process: link first, then the pasted code gives the token', async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    let written = '';
    stdin.on('data', (d) => {
      written += String(d);
      // Like Claude: it acts on Enter as its own keypress, after the paste.
      if (String(d) === '\r') stdout.write(`\r\n${TOKEN}\r\n`);
    });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: new PassThrough(),
      stdin,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(),
    });
    const spawn = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const start = dockerSetupToken('lark-bot:latest', spawn);
    const pending = start();
    stdout.write(`\u001b]8;id=1;${URL}\u0007\r\nPaste code here if prompted >`);
    const session = await pending;
    expect(session.url).toBe(URL);
    await expect(session.submit(' the-code ')).resolves.toBe(TOKEN);
    // A bracketed paste, then Enter separately: in one burst Claude loses the Enter of a long code.
    expect(written).toBe('\u001b[200~the-code\u001b[201~\r');
    const args = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as string[];
    expect(args.join(' ')).toContain('stty cols 2000 rows 50; claude setup-token');
  });
});

function seat(over: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    recordId: 'recAcc',
    account: 'ai@gdexpress.com',
    kind: 'Standard seat',
    credential: 'Waiting for sign-in',
    botRecordIds: ['rec1'],
    ...over,
  };
}

function setup(opts: { accounts?: ClaudeAccount[]; submit?: (code: string) => Promise<string>; checkCode?: number } = {}) {
  let accounts = opts.accounts ?? [seat()];
  const updates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  const sent: Array<{ to: string; card: object }> = [];
  const refused = new Set<string>();
  const updated: object[] = [];
  const cancel = vi.fn();
  const setupToken = vi.fn(async () => ({
    url: URL,
    submit: opts.submit ?? (async () => TOKEN),
    cancel,
  }));
  const setToken = vi.fn(async (_a: string, _t: string) => ({ code: 0, output: 'saved\nrestarted ali-tan\n' }));
  const checkAccount = vi.fn(async (_a: string) => ({ code: opts.checkCode ?? 0, output: opts.checkCode ? 'error: ai did not answer: 401' : 'ok' }));
  let clock = 1_000_000;
  const deps: AccountsDeps = {
    approvalChatId: CHAT,
    now: () => clock,
    store: {
      accounts: async () => accounts,
      settings: async () => ({ 'Default Claude account': 'ai@gdexpress.com' }),
      updateAccount: async (id, fields) => {
        updates.push({ id, fields });
        accounts = accounts.map((a) =>
          a.recordId === id && typeof fields['Credential on server'] === 'string'
            ? { ...a, credential: fields['Credential on server'] as string }
            : a,
        );
      },
    },
    cards: {
      send: async (to, card) => {
        if (refused.has(to)) throw new Error('230013: bot has no availability to this user');
        sent.push({ to, card });
        return `om_${sent.length}`;
      },
      update: async (_id, card) => {
        updated.push(card);
      },
    },
    members: { isMember: async (_c, id) => id === 'ou_member' },
    bots: { setToken, checkAccount },
    setupToken,
  };
  const acc = new ClaudeAccounts(deps);
  const click = (cmd: string, account: string, form: Record<string, string> = {}, chatId = CHAT) =>
    acc.handleAction({ cmd, recordId: account, chatId, operatorOpenId: 'ou_member', form });
  // Buttons are answered at once; the work after the reply is done when the account is released.
  const settled = () => vi.waitFor(() => expect((acc as unknown as { busy: Set<string> }).busy.size).toBe(0));
  return {
    acc, updates, sent, updated, setupToken, setToken, checkAccount, cancel, click, settled,
    tick: (ms: number) => (clock += ms),
    failSendTo: (to: string) => refused.add(to),
    allowSendTo: (to: string) => refused.delete(to),
  };
}

const text = (card: object | undefined) => JSON.stringify(card);

describe('ClaudeAccounts', () => {
  it('sends the sign-in card to the seat\'s own Lark account, also for the team seat, once', async () => {
    const t = setup();
    await t.acc.poll();
    await t.acc.poll();
    expect(t.setupToken).toHaveBeenCalledTimes(1);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.to).toBe('ai@gdexpress.com');
    expect(text(t.sent[0]?.card)).toContain(URL);
    expect(t.updates[0]?.fields).toHaveProperty('Sign-in sent at');
  });

  it('prefers the Holder set in Claude Accounts', async () => {
    const t = setup({ accounts: [seat({ holder: { id: 'ou_holder', name: 'AI subscription' } })] });
    await t.acc.poll();
    expect(t.sent[0]?.to).toBe('ou_holder');
  });

  it('falls back to the group, saying why, when Lark refuses the DM', async () => {
    const t = setup();
    t.failSendTo('ai@gdexpress.com');
    await t.acc.poll();
    expect(t.sent.map((s) => s.to)).toEqual([CHAT]);
    expect(text(t.sent[0]?.card)).toContain("Couldn't message ai@gdexpress.com directly");
    expect(text(t.sent[0]?.card)).toContain('availability');
  });

  it('moves a group fallback to a DM once Lark accepts it, and refreshes a DM in place', async () => {
    const t = setup();
    t.failSendTo('ai@gdexpress.com');
    await t.acc.poll();
    t.allowSendTo('ai@gdexpress.com');
    t.tick(16 * 60_000);
    await t.acc.poll();
    expect(t.sent.map((s) => s.to)).toEqual([CHAT, 'ai@gdexpress.com']);
    expect(text(t.updated[0])).toContain('Sent to ai@gdexpress.com directly');
    t.tick(16 * 60_000);
    await t.acc.poll();
    expect(t.sent).toHaveLength(2);
    expect(text(t.updated[1])).toContain('Open the Claude sign-in');
  });

  it('sends a person\'s seat to them directly', async () => {
    const t = setup({ accounts: [seat({ account: 'ali.tan@gdexpress.com' })] });
    await t.acc.poll();
    expect(t.sent[0]?.to).toBe('ali.tan@gdexpress.com');
  });

  it('saves the token from the pasted code and marks the seat Saved for a year', async () => {
    const t = setup();
    await t.acc.poll();
    const reply = await t.click('prov.claude_code', 'ai@gdexpress.com', { code: 'abc#def' }, 'oc_dm_with_holder');
    expect(reply?.toast.type).toBe('info');
    await t.settled();
    expect(t.setToken).toHaveBeenCalledWith('ai@gdexpress.com', TOKEN);
    const saved = t.updates.find((u) => u.fields['Credential on server'] === 'Saved');
    expect(saved?.fields['Token expires']).toBe(1_000_000 + 365 * 24 * 60 * 60_000);
    expect(text(t.updated[0])).toContain('Restarted: ali-tan');
  });

  it('tells the AI Team group when a seat is signed in from the holder\'s DM', async () => {
    const t = setup();
    await t.acc.poll();
    expect(t.sent.map((s) => s.to)).toEqual(['ai@gdexpress.com']);
    await t.click('prov.claude_code', 'ai@gdexpress.com', { code: 'abc#def' }, 'oc_dm_with_holder');
    await t.settled();
    expect(t.sent.map((s) => s.to)).toEqual(['ai@gdexpress.com', CHAT]);
    expect(text(t.sent[1]?.card)).toContain('Claude connected: ai@gdexpress.com');
  });

  it('refuses group clicks from non-members and expired links', async () => {
    const t = setup();
    await t.acc.poll();
    expect((await t.acc.handleAction({ cmd: 'prov.claude_code', recordId: 'ai@gdexpress.com', chatId: CHAT, operatorOpenId: 'ou_x', form: { code: 'c' } }))?.toast.type).toBe('error');
    expect((await t.click('prov.claude_code', 'ai@gdexpress.com', {}))?.toast.content).toMatch(/Paste the code/);
    t.tick(16 * 60_000);
    await t.click('prov.claude_code', 'ai@gdexpress.com', { code: 'c' });
    await t.settled();
    expect(t.setToken).not.toHaveBeenCalled();
    expect(text(t.updated[0])).toContain('This link has expired');
    expect(text(t.updated[0])).toContain('Send a new link');
  });

  it('shows a wrong code as expired with a new-link button', async () => {
    const t = setup({ submit: async () => Promise.reject(new Error('Claude didn\'t accept the code')) });
    await t.acc.poll();
    expect((await t.click('prov.claude_code', 'ai@gdexpress.com', { code: 'bad' }))?.toast.type).toBe('info');
    await t.settled();
    expect(t.setToken).not.toHaveBeenCalled();
    expect(text(t.updated[0])).toContain("Claude didn't accept the code");
  });

  it('replaces the clicked card when the session is gone (provisioner restarted)', async () => {
    const t = setup();
    await t.acc.handleAction({ cmd: 'prov.claude_code', recordId: 'ai@gdexpress.com', messageId: 'om_old', chatId: 'oc_dm', operatorOpenId: 'ou_x', form: { code: 'c' } });
    await t.settled();
    expect(text(t.updated[0])).toContain('This link has expired');
  });

  it('sends a new link on request, replacing the card', async () => {
    const t = setup();
    await t.acc.poll();
    expect((await t.click('prov.claude_relink', 'ai@gdexpress.com'))?.toast.type).toBe('info');
    await t.settled();
    expect(t.cancel).toHaveBeenCalled();
    expect(t.setupToken).toHaveBeenCalledTimes(2);
    expect(t.updated).toHaveLength(1);
  });

  it('daily: records the check, warns the group on failure, asks for renewal 30 days ahead', async () => {
    const t = setup({
      accounts: [seat({ credential: 'Saved', tokenExpires: 1_000_000 + 10 * 24 * 60 * 60_000 })],
      checkCode: 1,
    });
    await t.acc.daily();
    expect(t.updates[0]?.fields['Last check']).toContain('401');
    expect(t.sent[0]?.to).toBe(CHAT);
    expect(t.updates.some((u) => u.fields['Credential on server'] === 'Waiting for sign-in')).toBe(true);
  });
});
