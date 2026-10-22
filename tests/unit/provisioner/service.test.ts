import { describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount, RequestRecord } from '../../../src/provisioner/base-store';
import type { AddResult } from '../../../src/provisioner/lark-bots';
import {
  Provisioner,
  claudeChoice,
  type ActionInput,
  type ProvisionerDeps,
} from '../../../src/provisioner/service';

const CHAT = 'oc_approvals';
const MEMBER = 'ou_member';

function request(over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    recordId: 'rec1',
    requestId: 'REQ-0001',
    agentName: "Ali's AI Agent",
    botType: 'Personal',
    appId: 'cli_a1b2c3',
    appSecret: 'right-secret',
    confirmations: ['a', 'b'],
    department: '',
    purpose: '',
    documents: '',
    wikiPages: '',
    groupChats: '',
    sensitivity: '',
    requester: { id: 'ou_ali', name: 'Ali Tan', email: 'ali.tan@gdexpress.com' },
    status: '',
    serverBotName: '',
    cardMessageId: '',
    claudeAccountRecordIds: [],
    ...over,
  };
}

function setup(opts: {
  req?: Partial<RequestRecord>;
  accounts?: ClaudeAccount[];
  validSecrets?: string[];
  owner?: string;
  addResult?: Partial<AddResult>;
  existingBots?: string[];
} = {}) {
  const req = request(opts.req);
  const updates: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const sent: object[] = [];
  const updatedCards: object[] = [];
  const accounts: ClaudeAccount[] = opts.accounts ?? [
    { recordId: 'recAcc', account: 'ai@gdexpress.com', kind: 'Standard seat', credential: 'Saved', botRecordIds: [] },
  ];
  const created: Array<Record<string, unknown>> = [];
  const accountUpdates: Array<Record<string, unknown>> = [];
  const add = vi.fn(async (_opts: unknown): Promise<AddResult> => ({
    ok: true,
    code: 0,
    result: { ok: true, bot: 'ali-tan', claude: 'ok' },
    output: '',
    ...opts.addResult,
  }));
  const setApiKey = vi.fn(async (_account: string, _key: string) => ({ code: 0, output: '' }));
  const setInstructions = vi.fn(async (_name: string, _text: string) => ({ code: 0, output: '' }));
  const botGet = vi.fn(async (path: string, _p?: Record<string, string | number>) =>
    path.includes('docx') ? { ok: true } : path.includes('chats') ? { ok: true, data: { items: [{ chat_id: 'oc_hr', name: 'HR Team' }] } } : { ok: false },
  );
  const validate = vi.fn(async (_appId: string, secret: string) =>
    (opts.validSecrets ?? ['right-secret']).includes(secret) ? { ok: true } : { ok: false, reason: 'code=10014 msg=app secret invalid' },
  );
  // The bot's welcome DM (lark-bots.sh bot-message).
  const welcome = vi.fn(async (_bot: string, _email: string, _text: string) => ({ code: 0, output: '' }));

  const deps: ProvisionerDeps = {
    approvalChatId: CHAT,
    tenant: 'lark',
    now: () => 1_000,
    store: {
      newRequests: async () => (req.status === '' ? [req] : []),
      requestsWithStatus: async (s) => (req.status === s ? [req] : []),
      request: async () => ({ ...req }),
      requesterUnionId: async () => 'on_ali',
      updateRequest: async (_id, fields) => {
        updates.push(fields);
        if (typeof fields.Status === 'string') req.status = fields.Status;
        if (typeof fields['Card message ID'] === 'string') req.cardMessageId = fields['Card message ID'];
        if (typeof fields['Server bot name'] === 'string') req.serverBotName = fields['Server bot name'];
        if (Array.isArray(fields['Claude account'])) req.claudeAccountRecordIds = fields['Claude account'] as string[];
      },
      accounts: async () => accounts,
      createAccount: async (fields) => {
        created.push(fields);
        return 'recNewAcc';
      },
      updateAccount: async (_id, fields) => {
        accountUpdates.push(fields);
      },
      settings: async () => ({ 'Default Claude account': 'ai@gdexpress.com', 'Team seats bought': '5' }),
      event: async (_id, event) => {
        events.push(event);
      },
    },
    cards: {
      send: async (_chat, card) => {
        sent.push(card);
        return 'om_card';
      },
      update: async (_id, card) => {
        updatedCards.push(card);
      },
    },
    members: { isMember: async (_chat, openId) => openId === MEMBER },
    apps: { validate, ownerUnionId: async () => opts.owner ?? 'on_ali' },
    bots: {
      add,
      setApiKey,
      setInstructions,
      sendMessage: welcome,
      botGet: (_name, path, params) => botGet(path, params),
      botNames: async () => new Set(opts.existingBots ?? []),
      botForApp: async () => undefined,
    },
  };
  const p = new Provisioner(deps);
  const click = (cmd: string, form: Record<string, string> = {}, over: Partial<ActionInput> = {}) =>
    p.handleAction({ cmd, recordId: req.recordId, chatId: CHAT, operatorOpenId: MEMBER, operatorName: 'Joe', form, ...over });
  // The click is answered at once; the work after it is done when the record is released.
  const settled = () => vi.waitFor(() => expect((p as unknown as { busy: Set<string> }).busy.size).toBe(0));
  return { p, req, accounts, updates, events, sent, updatedCards, created, accountUpdates, add, setApiKey, setInstructions, botGet, validate, welcome, click, settled };
}

const title = (card: object | undefined) => (card as { header: { title: { content: string } } }).header.title.content;
const text = (card: object | undefined) => JSON.stringify(card);

describe('Provisioner.poll', () => {
  it('posts an approval card for a new request and marks it Carded', async () => {
    const t = setup();
    await t.p.poll();
    expect(t.sent).toHaveLength(1);
    expect(title(t.sent[0])).toBe('New AI agent request REQ-0001');
    expect(text(t.sent[0])).toContain('App ID and App Secret accepted');
    expect(text(t.sent[0])).toContain('The app belongs to the requester');
    expect(text(t.sent[0])).not.toContain('right-secret');
    expect(t.req.status).toBe('Carded');
    expect(t.req.cardMessageId).toBe('om_card');
    expect(t.events).toEqual(['carded']);
  });

  it('shows a rejected secret on the card with the credentials link and a secret input', async () => {
    const t = setup({ req: { appSecret: 'typo' } });
    await t.p.poll();
    const card = text(t.sent[0]);
    expect(card).toContain('Lark rejected the App ID or App Secret');
    expect(card).toContain('https://open.larksuite.com/app/cli_a1b2c3/baseinfo');
    expect(card).toContain('"name":"app_secret"');
  });
});

describe('Provisioner.handleAction', () => {
  it('refuses clicks from outside the group or from non-members', async () => {
    const t = setup({ req: { status: 'Carded', cardMessageId: 'om_card' } });
    expect((await t.click('prov.approve', {}, { chatId: 'oc_other' }))?.toast.type).toBe('error');
    expect((await t.click('prov.approve', {}, { operatorOpenId: 'ou_stranger' }))?.toast.type).toBe('error');
    expect(t.add).not.toHaveBeenCalled();
    expect(t.updates).toEqual([]);
  });

  it('approves: creates the bot on the default account, clears the secret, welcomes the owner', async () => {
    const t = setup({ req: { status: 'Carded', cardMessageId: 'om_card' } });
    const reply = await t.click('prov.approve', { claude_account: 'ai@gdexpress.com' });
    expect(reply?.toast.type).toBe('info');
    await t.settled();
    expect(t.add).toHaveBeenCalledWith({
      name: 'ali-tan',
      appId: 'cli_a1b2c3',
      appSecret: 'right-secret',
      mode: 'personal',
      tenant: 'lark',
      claudeAccount: 'ai@gdexpress.com',
    });
    expect(t.updates).toContainEqual(
      expect.objectContaining({ 'Server bot name': 'ali-tan', 'Claude account': ['recAcc'], 'App Secret': null }),
    );
    expect(t.req.status).toBe('Ready');
    expect(t.welcome).toHaveBeenCalledWith('ali-tan', 'ali.tan@gdexpress.com', expect.any(String));
    expect(title(t.updatedCards[0])).toBe('Setting up REQ-0001');
    expect(title(t.updatedCards[t.updatedCards.length - 1])).toBe('Ready: REQ-0001');
    expect(t.events).toEqual(['approved', 'provisioned', 'announced']);
  });

  it('uses a corrected secret from the card', async () => {
    const t = setup({ req: { status: 'Failed', cardMessageId: 'om_card', appSecret: 'typo' } });
    await t.click('prov.approve', { app_secret: ' right-secret ' });
    await t.settled();
    expect(t.req.status).toBe('Ready');
    expect(t.add.mock.calls[0]?.[0]).toMatchObject({ appSecret: 'right-secret' });
  });

  it('answers the click before the slow checks finish', async () => {
    let finish: (v: { ok: boolean }) => void = () => undefined;
    const t = setup({ req: { status: 'Carded', cardMessageId: 'om_card' } });
    t.validate.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const reply = await t.click('prov.approve');
    expect(reply?.toast.type).toBe('info');
    expect(t.add).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.validate).toHaveBeenCalled());
    finish({ ok: true });
    await t.settled();
    expect(t.req.status).toBe('Ready');
  });

  it('shows the failing line of lark-bots.sh output when it only says "a command failed"', async () => {
    const t = setup({
      req: { status: 'Carded', cardMessageId: 'om_card' },
      addResult: {
        ok: false,
        code: 1,
        result: { ok: false, step: 'Checking the container\'s hostname', error: 'a command failed (exit 1); see the output above' },
        output:
          '==> Checking the container\'s hostname\nvalidating /x/bot.yaml: error in parsing "compose-spec.json": stat .: permission denied\n' +
          'warning: removing the half-made bot ali-tan\n{"ok":false}\n',
      },
    });
    await t.click('prov.approve');
    await t.settled();
    const card = text(t.updatedCards[t.updatedCards.length - 1]);
    expect(card).toContain('stat .: permission denied');
    expect(card).not.toContain('see the output above');
  });

  it('does not provision when Lark rejects the secret', async () => {
    const t = setup({ req: { status: 'Carded', cardMessageId: 'om_card', appSecret: 'typo' } });
    const reply = await t.click('prov.approve');
    expect(reply?.toast.type).toBe('info');
    await t.settled();
    expect(t.add).not.toHaveBeenCalled();
    expect(t.req.status).toBe('Failed');
    const card = t.updatedCards[t.updatedCards.length - 1];
    expect(title(card)).toBe('Needs attention REQ-0001');
    expect(text(card)).toContain('"name":"app_secret"');
    expect(text(card)).toContain('Retry');
  });

  it('holds the request, telling nobody, until the seat is signed in; then announces it', async () => {
    const t = setup({
      req: { status: 'Carded', cardMessageId: 'om_card' },
      accounts: [{ recordId: 'recAcc', account: 'ai@gdexpress.com', kind: 'Standard seat', credential: 'Not saved', botRecordIds: [] }],
      addResult: { result: { ok: true, bot: 'ali-tan', claude: 'missing' } },
    });
    await t.click('prov.approve');
    await t.settled();
    expect(t.req.status).toBe('Waiting for Claude');
    expect(t.accountUpdates).toEqual([{ 'Credential on server': 'Waiting for sign-in' }]);
    // Only a note that it isn't ready yet, from the bot itself.
    expect(t.welcome).toHaveBeenCalledTimes(1);
    expect(t.welcome).toHaveBeenCalledWith('ali-tan', 'ali.tan@gdexpress.com', expect.stringContaining("can't answer yet"));
    expect(title(t.updatedCards[t.updatedCards.length - 1])).toBe('Waiting for Claude: REQ-0001');
    expect(text(t.updatedCards[t.updatedCards.length - 1])).toContain('not ready yet');

    // Still waiting: nothing more happens.
    await t.p.poll();
    expect(t.welcome).toHaveBeenCalledTimes(1);

    // The holder finished the Claude sign-in card.
    (t.accounts[0] as { credential: string }).credential = 'Saved';
    await t.p.poll();
    expect(t.req.status).toBe('Ready');
    const [, , welcomeText] = t.welcome.mock.calls[1] ?? [];
    expect(welcomeText).toContain("I'm ready: you can start chatting with me now");
    expect(welcomeText).toContain('https://gdexgroup.sg.larksuite.com/wiki/Jh7owFCemi3GO7kBBeblkcydg7c');
    expect(title(t.updatedCards[t.updatedCards.length - 1])).toBe('Ready: REQ-0001');
    // And a fresh message in the AI Team group.
    expect(title(t.sent[t.sent.length - 1])).toBe("Connected: Ali's AI Agent");
    expect(text(t.sent[t.sent.length - 1])).toContain('sent the welcome message with the user guide');
  });

  it('does not provision an app that belongs to someone else', async () => {
    const t = setup({ req: { status: 'Carded', cardMessageId: 'om_card' }, owner: 'on_someone_else' });
    await t.click('prov.approve');
    await t.settled();
    expect(t.add).not.toHaveBeenCalled();
    expect(t.req.status).toBe('Failed');
    expect(text(t.updatedCards[t.updatedCards.length - 1])).toContain('belongs to someone else');
  });

  it('marks the request Failed with the secret fix when lark-bots.sh exits 4', async () => {
    const t = setup({
      req: { status: 'Carded', cardMessageId: 'om_card' },
      addResult: { ok: false, code: 4, result: { ok: false, error: 'Lark rejected app cli_a1b2c3 with this App Secret' } },
    });
    await t.click('prov.approve');
    await t.settled();
    expect(t.req.status).toBe('Failed');
    const card = text(t.updatedCards[t.updatedCards.length - 1]);
    expect(card).toContain('Lark rejected app cli');
    expect(card).toContain('baseinfo');
  });

  it('saves a new API key as a Claude account and uses it', async () => {
    const t = setup({ req: { status: 'Carded', cardMessageId: 'om_card' } });
    await t.click('prov.approve', { api_key: 'sk-ant-api03-x' });
    await t.settled();
    expect(t.setApiKey).toHaveBeenCalledWith('key-ali-tan', 'sk-ant-api03-x');
    expect(t.created).toEqual([{ Account: 'key-ali-tan', Kind: 'API key', 'Credential on server': 'Saved' }]);
    expect(t.add.mock.calls[0]?.[0]).toMatchObject({ claudeAccount: 'key-ali-tan' });
  });

  it('records a new seat as a Claude account with no credential yet', async () => {
    const t = setup({ req: { status: 'Carded', cardMessageId: 'om_card' } });
    await t.click('prov.approve', { new_seat: 'Ali.Tan@gdexpress.com' });
    await t.settled();
    expect(t.created).toEqual([{ Account: 'ali.tan@gdexpress.com', Kind: 'Standard seat', 'Credential on server': 'Not saved' }]);
    expect(t.add.mock.calls[0]?.[0]).toMatchObject({ claudeAccount: 'ali.tan@gdexpress.com' });
  });

  it('creates a department bot in team mode under dept-<department>, avoiding taken names', async () => {
    const t = setup({
      req: { status: 'Carded', cardMessageId: 'om_card', botType: 'Department', department: 'HR & Admin', sensitivity: 'yes' },
      existingBots: ['dept-hr-admin'],
    });
    await t.click('prov.approve');
    await t.settled();
    expect(t.add.mock.calls[0]?.[0]).toMatchObject({ name: 'dept-hr-admin-2', mode: 'team' });
  });

  it('rejects only with a reason, and tells nobody the secret', async () => {
    const t = setup({ req: { status: 'Carded', cardMessageId: 'om_card' } });
    expect((await t.click('prov.reject'))?.toast.type).toBe('error');
    expect(t.req.status).toBe('Carded');
    expect((await t.click('prov.reject', { reject_reason: 'Use the department bot' }))?.toast.type).toBe('info');
    await t.settled();
    expect(t.req.status).toBe('Rejected');
    expect(t.updates[0]).toMatchObject({ 'Reject reason': 'Use the department bot', 'App Secret': null });
    expect(title(t.updatedCards[0])).toBe('Rejected: REQ-0001');
  });

  it('ignores a click on a request that is already done', async () => {
    const t = setup({ req: { status: 'Ready', cardMessageId: 'om_card' } });
    expect((await t.click('prov.approve'))?.toast.type).toBe('info');
    expect(t.add).not.toHaveBeenCalled();
  });

  it('department bot: writes its instructions, checks its access, waits in knowledge setup', async () => {
    const t = setup({
      req: {
        status: 'Carded',
        cardMessageId: 'om_card',
        botType: 'Department',
        department: 'HR',
        sensitivity: 'yes',
        purpose: 'Answer leave questions',
        documents: 'https://gdexgroup.sg.larksuite.com/docx/AbCdEf123456\nhttps://gdexgroup.sg.larksuite.com/base/ZyXwVu987654',
        groupChats: 'HR Team\nFinance Team',
      },
    });
    await t.click('prov.approve');
    await t.settled();
    expect(t.req.status).toBe('Knowledge setup');
    const [, text0] = t.setInstructions.mock.calls[0] ?? [];
    expect(text0).toContain('AI agent for the HR department');
    expect(text0).toContain('- https://gdexgroup.sg.larksuite.com/docx/AbCdEf123456');
    const card = t.updatedCards[t.updatedCards.length - 1];
    expect(title(card)).toBe('Knowledge setup: REQ-0001');
    expect(text(card)).toContain('2 of 4');
    const [, , welcome] = t.welcome.mock.calls[0] ?? [];
    expect(welcome).toContain('base/ZyXwVu987654');
    expect(welcome).toContain('Finance Team');
    expect(welcome).not.toContain('HR Team');

    t.req.serverBotName = 'dept-hr';
    expect((await t.click('prov.go_live'))?.toast.type).toBe('info');
    await t.settled();
    expect(t.req.status).toBe('Live');
    expect(title(t.updatedCards[t.updatedCards.length - 1])).toBe('Live: REQ-0001');
  });
});

describe('Provisioner.recover', () => {
  it('turns a request left Provisioning by a restart into Failed with Retry', async () => {
    const t = setup({ req: { status: 'Provisioning', cardMessageId: 'om_card' } });
    await t.p.recover();
    expect(t.req.status).toBe('Failed');
    expect(text(t.updatedCards[0])).toContain('restarted');
  });
});

describe('claudeChoice', () => {
  it('defaults to the default account and validates the alternatives', () => {
    expect(claudeChoice({}, 'ai@gdexpress.com')).toEqual({ account: 'ai@gdexpress.com' });
    expect(claudeChoice({ claude_account: 'key-hr' }, 'ai@gdexpress.com')).toEqual({ account: 'key-hr' });
    expect(claudeChoice({ new_seat: 'not-an-email' }, '')).toMatch(/isn't a seat email/);
    expect(claudeChoice({ new_seat: 'a@b.com', api_key: 'k' }, '')).toMatch(/not both/);
    expect(claudeChoice({ api_key: 'k', api_key_label: 'Bad Label' }, '')).toMatch(/lowercase/);
    expect(claudeChoice({}, '')).toBe('Choose a Claude account');
  });
});
