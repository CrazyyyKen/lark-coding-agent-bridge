import { join } from 'node:path';
import { createLarkChannel } from '@larksuite/channel';
import type { TenantBrand } from '../config/schema';
import { configureLogger, log } from '../core/logger';
import { validateAppCredentials } from '../utils/feishu-auth';
import { BaseStore } from './base-store';
import { LarkApi, appOwnerUnionId } from './lark-api';
import { LarkBots, scriptRunner } from './lark-bots';
import { ClaudeAccounts } from './claude-accounts';
import { Provisioner, type AppPort, type MembersPort } from './service';
import { dockerSetupToken, removeLeftoverSignIns } from './setup-token';

export interface ProvisionerConfig {
  appId: string;
  appSecret: string;
  baseToken: string;
  approvalChatId: string;
  tenant: TenantBrand;
  larkBotsDir: string;
  pollSeconds: number;
  logsDir?: string;
}

/** Settings come from the environment (deploy/docker/provisioner.env). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProvisionerConfig {
  const need = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is not set (see deploy/docker/provisioner.env.example)`);
    return v;
  };
  const tenant = (env.PROVISIONER_TENANT?.trim() || 'lark') as TenantBrand;
  if (tenant !== 'lark' && tenant !== 'feishu') throw new Error('PROVISIONER_TENANT must be lark or feishu');
  const pollSeconds = Number.parseInt(env.PROVISIONER_POLL_SECONDS ?? '60', 10);
  return {
    appId: need('PROVISIONER_APP_ID'),
    appSecret: need('PROVISIONER_APP_SECRET'),
    baseToken: need('PROVISIONER_BASE_TOKEN'),
    approvalChatId: need('PROVISIONER_CHAT_ID'),
    tenant,
    larkBotsDir: env.LARK_BOTS_DIR?.trim() || '/lark-bots',
    pollSeconds: Number.isFinite(pollSeconds) && pollSeconds >= 15 ? pollSeconds : 60,
    logsDir: env.PROVISIONER_LOGS_DIR?.trim() || undefined,
  };
}

const MEMBERS_TTL_MS = 5 * 60_000;

/** Group membership, re-read at most every five minutes. */
function membersPort(api: LarkApi): MembersPort {
  const cache = new Map<string, { at: number; ids: Set<string> }>();
  return {
    async isMember(chatId, openId) {
      let entry = cache.get(chatId);
      if (!entry || Date.now() - entry.at > MEMBERS_TTL_MS || !entry.ids.has(openId)) {
        const ids = new Set<string>();
        let pageToken: string | undefined;
        do {
          const data = await api.call<{
            items?: Array<{ member_id: string }>;
            has_more?: boolean;
            page_token?: string;
          }>('GET', `/open-apis/im/v1/chats/${chatId}/members`, {
            query: { member_id_type: 'open_id', page_size: 100, page_token: pageToken },
          });
          for (const m of data.items ?? []) ids.add(m.member_id);
          pageToken = data.has_more ? data.page_token : undefined;
        } while (pageToken);
        entry = { at: Date.now(), ids };
        cache.set(chatId, entry);
      }
      return entry.ids.has(openId);
    },
  };
}

function appPort(tenant: TenantBrand): AppPort {
  return {
    async validate(appId, secret) {
      const r = await validateAppCredentials(appId, secret, tenant);
      return { ok: r.ok, reason: r.reason, network: r.reason?.startsWith('Network error') };
    },
    ownerUnionId: (appId, secret) => appOwnerUnionId(new LarkApi({ tenant, appId, appSecret: secret }), appId),
  };
}

function formValues(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
  }
  return out;
}

/**
 * `lark-channel-bridge provisioner --check`: reads the Base and the approval group
 * once and prints what it finds, without connecting for events. With a recipient,
 * also sends them the approval card for the newest request (or a sample), so the
 * card can be seen without posting in the group.
 */
export async function checkProvisioner(cfg: ProvisionerConfig, cardTo?: string): Promise<void> {
  const api = new LarkApi({ tenant: cfg.tenant, appId: cfg.appId, appSecret: cfg.appSecret });
  await api.tenantToken();
  console.log(`✓ app ${cfg.appId}: tenant token ok`);
  const store = new BaseStore(api, cfg.baseToken);
  await store.init();
  console.log('✓ Base: all four tables found');
  const [settings, accounts, pending] = await Promise.all([store.settings(), store.accounts(), store.newRequests()]);
  console.log(`  settings: ${JSON.stringify(settings)}`);
  console.log(`  Claude accounts: ${accounts.map((a) => `${a.account} (${a.kind}, ${a.credential})`).join('; ') || 'none'}`);
  console.log(`  requests waiting for a card: ${pending.length}`);
  for (const r of pending) {
    console.log(`    ${r.requestId} ${r.botType} "${r.agentName}" ${r.appId} by ${r.requester?.name ?? '?'} <${r.requester?.email ?? '?'}>`);
  }
  const members = await api.call<{ items?: unknown[] }>('GET', `/open-apis/im/v1/chats/${cfg.approvalChatId}/members`, {
    query: { member_id_type: 'open_id', page_size: 100 },
  });
  console.log(`✓ approval group: ${members.items?.length ?? 0} members visible`);
  if (!cardTo) return;

  const { requestCard } = await import('./cards');
  const sample = pending[0] ?? {
    recordId: 'recSample', requestId: 'REQ-SAMPLE', agentName: "Sample's AI Agent", botType: 'Personal',
    appId: 'cli_sample000000000', appSecret: '', confirmations: [], department: '', purpose: '', documents: '',
    wikiPages: '', groupChats: '', sensitivity: '', status: '', serverBotName: '', cardMessageId: '',
    claudeAccountRecordIds: [], requester: { id: 'ou_sample', name: 'Sample Person', email: 'sample@gdexpress.com' },
  };
  const bought = Number.parseInt(settings['Team seats bought'] ?? '', 10);
  const card = requestCard({
    req: sample,
    checks: { credentials: 'bad', credentialsDetail: 'sample', owner: 'unknown', problems: ['This is a preview card; its buttons do nothing'] },
    accounts,
    defaultAccount: settings['Default Claude account'] ?? '',
    seats: { bought: Number.isFinite(bought) ? bought : undefined, inUse: accounts.filter((a) => /seat/i.test(a.kind)).length },
  });
  const type = cardTo.startsWith('oc_') ? 'chat_id' : cardTo.startsWith('ou_') ? 'open_id' : 'email';
  await api.call('POST', '/open-apis/im/v1/messages', {
    query: { receive_id_type: type },
    body: { receive_id: cardTo, msg_type: 'interactive', content: JSON.stringify(card) },
  });
  console.log(`✓ preview card sent to ${cardTo}`);
}

/** `lark-channel-bridge provisioner`: runs until stopped. */
export async function runProvisioner(cfg: ProvisionerConfig = configFromEnv()): Promise<void> {
  if (cfg.logsDir) configureLogger({ logsDir: cfg.logsDir });
  const api = new LarkApi({ tenant: cfg.tenant, appId: cfg.appId, appSecret: cfg.appSecret });
  const store = new BaseStore(api, cfg.baseToken);
  await store.init();

  const channel = createLarkChannel({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    source: 'lark-bot-provisioner',
    policy: { dmMode: 'open', requireMention: true, respondToMentionAll: false },
    includeRawEvent: true,
    wsConfig: { pingTimeout: 3 },
    handshakeTimeoutMs: 8_000,
    httpTimeoutMs: 30_000,
    respectProxyEnv: true,
  });

  const cards = {
    send: async (to: string, card: object) => (await channel.send(to, { card })).messageId,
    update: (messageId: string, card: object) => channel.updateCard(messageId, card),
  };
  const members = membersPort(api);
  const bots = new LarkBots(scriptRunner(join(cfg.larkBotsDir, 'lark-bots.sh')), cfg.larkBotsDir);
  const provisioner = new Provisioner({
    store,
    cards,
    members,
    apps: appPort(cfg.tenant),
    bots,
    approvalChatId: cfg.approvalChatId,
    tenant: cfg.tenant,
  });

  const accounts = new ClaudeAccounts({
    store,
    cards,
    members,
    bots,
    setupToken: dockerSetupToken('lark-bot:latest'),
    approvalChatId: cfg.approvalChatId,
  });

  channel.on({
    cardAction: async (evt) => {
      const value = (evt.action.value ?? {}) as { cmd?: unknown; record?: unknown };
      if (typeof value.cmd !== 'string' || typeof value.record !== 'string') return undefined;
      const raw = evt.raw as { action?: { form_value?: Record<string, unknown> } } | undefined;
      const input = {
        cmd: value.cmd,
        recordId: value.record,
        messageId: evt.messageId,
        chatId: evt.chatId,
        operatorOpenId: evt.operator.openId,
        operatorName: evt.operator.name,
        form: formValues(evt.action.formValue ?? raw?.action?.form_value),
      };
      return (await provisioner.handleAction(input)) ?? (await accounts.handleAction(input));
    },
    error: (err) => log.fail('provisioner', err, { step: 'channel' }),
  });
  await channel.connect();
  log.info('provisioner', 'started', { base: cfg.baseToken, chat: cfg.approvalChatId, every: cfg.pollSeconds });

  await provisioner.recover().catch((err) => log.fail('provisioner', err, { step: 'recover' }));
  // Sign-ins from before a restart can't be finished: their containers only wait.
  await removeLeftoverSignIns();
  let stopping = false;
  const loop = async () => {
    while (!stopping) {
      await provisioner.poll().catch((err) => log.fail('provisioner', err, { step: 'poll' }));
      await accounts.poll().catch((err) => log.fail('provisioner', err, { step: 'accounts' }));
      await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
    }
  };
  // Once a day, the first a few minutes after start: account health and renewals,
  // and department bots' access while they are in knowledge setup.
  const daily = async () => {
    await accounts.daily().catch((err) => log.fail('provisioner', err, { step: 'daily-accounts' }));
    await provisioner.daily().catch((err) => log.fail('provisioner', err, { step: 'daily-knowledge' }));
  };
  const firstDaily = setTimeout(daily, 5 * 60_000);
  const everyDay = setInterval(daily, 24 * 60 * 60_000);
  const stop = async () => {
    stopping = true;
    clearTimeout(firstDaily);
    clearInterval(everyDay);
    await channel.disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await loop();
}
