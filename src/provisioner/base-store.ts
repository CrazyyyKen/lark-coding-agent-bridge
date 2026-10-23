import type { LarkApi } from './lark-api';

/** Table and field names in the "AI Agent Requests" Base (docs/bot-provisioning-plan.md §3.1). */
export const TABLES = {
  requests: 'Requests',
  accounts: 'Claude Accounts',
  events: 'Events',
  settings: 'Settings',
} as const;

/** Claude Accounts → "Credential on server". "Waiting for sign-in" asks the provisioner for a sign-in card. */
export const CREDENTIAL = {
  saved: 'Saved',
  waiting: 'Waiting for sign-in',
  notSaved: 'Not saved',
} as const;

export const STATUS = {
  submitted: 'Submitted',
  carded: 'Carded',
  approved: 'Approved',
  provisioning: 'Provisioning',
  /** Bot created, its Claude seat not signed in yet: the requester hears nothing until it can answer. */
  waitingClaude: 'Waiting for Claude',
  ready: 'Ready',
  knowledgeSetup: 'Knowledge setup',
  live: 'Live',
  rejected: 'Rejected',
  failed: 'Failed',
} as const;

export interface Person {
  id: string;
  name?: string;
  email?: string;
}

export interface RequestRecord {
  recordId: string;
  requestId: string;
  agentName: string;
  botType: string;
  appId: string;
  appSecret: string;
  confirmations: string[];
  department: string;
  purpose: string;
  documents: string;
  wikiPages: string;
  groupChats: string;
  sensitivity: string;
  requester?: Person;
  approver?: Person;
  /** The Claude account the requester says the agent will use, and who signs in to it. */
  claudeEmail: string;
  claudeHolder?: Person;
  status: string;
  serverBotName: string;
  cardMessageId: string;
  claudeAccountRecordIds: string[];
}

export interface ClaudeAccount {
  recordId: string;
  account: string;
  kind: string;
  credential: string;
  holder?: Person;
  botRecordIds: string[];
  /** Epoch ms, when known. */
  tokenExpires?: number;
  signInSentAt?: number;
}

/** Date cells come back as epoch ms. */
export function cellTime(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type Fields = Record<string, unknown>;

interface RawRecord {
  record_id: string;
  fields: Fields;
}

/** Text out of any Base cell shape: plain strings, rich-text segments, numbers, options. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(cellText).join('');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.name === 'string') return o.name;
    if ('value' in o) return cellText(o.value);
  }
  return '';
}

/** Multi-select options or a list of strings. */
export function cellList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(cellText).filter(Boolean);
  const s = cellText(v);
  return s ? [s] : [];
}

export function cellPeople(v: unknown): Person[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list
    .map((p) => p as { id?: string; name?: string; email?: string; en_name?: string })
    .filter((p) => typeof p.id === 'string' && p.id)
    // Names can carry stray whitespace (seen: a trailing tab).
    .map((p) => ({ id: p.id as string, name: (p.name ?? p.en_name)?.trim(), email: p.email?.trim() }));
}

/** Record ids out of a link cell, whichever shape the API returns. */
export function cellLinks(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.flatMap((x) => {
      if (typeof x === 'string') return [x];
      const o = x as { record_ids?: string[]; record_id?: string };
      if (Array.isArray(o.record_ids)) return o.record_ids;
      return o.record_id ? [o.record_id] : [];
    });
  }
  const o = v as { link_record_ids?: string[] };
  return Array.isArray(o.link_record_ids) ? o.link_record_ids : [];
}

export function toRequest(r: RawRecord): RequestRecord {
  const f = r.fields;
  return {
    recordId: r.record_id,
    requestId: cellText(f['Request ID']),
    agentName: cellText(f['Agent name']).trim(),
    botType: cellText(f['Bot type']),
    appId: cellText(f['App ID']).trim(),
    appSecret: cellText(f['App Secret']).trim(),
    confirmations: cellList(f.Confirmations),
    department: cellText(f.Department).trim(),
    purpose: cellText(f.Purpose).trim(),
    documents: cellText(f.Documents).trim(),
    wikiPages: cellText(f['Wiki pages']).trim(),
    groupChats: cellText(f['Group chats']).trim(),
    sensitivity: cellText(f['Sensitivity confirmation']),
    requester: cellPeople(f.Requester)[0],
    approver: cellPeople(f.Approver)[0],
    claudeEmail: cellText(f['Claude account email']).trim().toLowerCase(),
    claudeHolder: cellPeople(f['Claude account holder'])[0],
    status: cellText(f.Status),
    serverBotName: cellText(f['Server bot name']).trim(),
    cardMessageId: cellText(f['Card message ID']).trim(),
    claudeAccountRecordIds: cellLinks(f['Claude account']),
  };
}

export function toAccount(r: RawRecord): ClaudeAccount {
  const f = r.fields;
  return {
    recordId: r.record_id,
    account: cellText(f.Account).trim(),
    kind: cellText(f.Kind),
    credential: cellText(f['Credential on server']),
    holder: cellPeople(f.Holder)[0],
    botRecordIds: cellLinks(f.Bots),
    tokenExpires: cellTime(f['Token expires']),
    signInSentAt: cellTime(f['Sign-in sent at']),
  };
}

/** The Base, through the provisioner app (a collaborator with edit rights). */
export class BaseStore {
  private tableIds = new Map<string, string>();

  constructor(
    private readonly api: LarkApi,
    private readonly baseToken: string,
  ) {}

  private get root(): string {
    return `/open-apis/bitable/v1/apps/${this.baseToken}`;
  }

  async init(): Promise<void> {
    const data = await this.api.call<{ items?: Array<{ table_id: string; name: string }> }>(
      'GET',
      `${this.root}/tables`,
      { query: { page_size: 100 } },
    );
    for (const t of data.items ?? []) this.tableIds.set(t.name, t.table_id);
    for (const name of Object.values(TABLES)) {
      if (!this.tableIds.has(name)) throw new Error(`table "${name}" not found in Base ${this.baseToken}`);
    }
  }

  private table(name: string): string {
    const id = this.tableIds.get(name);
    if (!id) throw new Error(`BaseStore.init() has not found table "${name}"`);
    return `${this.root}/tables/${id}`;
  }

  private async search(table: string, filter?: object, userIdType = 'open_id'): Promise<RawRecord[]> {
    const out: RawRecord[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.api.call<{ items?: RawRecord[]; has_more?: boolean; page_token?: string }>(
        'POST',
        `${this.table(table)}/records/search`,
        {
          query: { page_size: 200, page_token: pageToken, user_id_type: userIdType },
          body: filter ? { filter } : {},
        },
      );
      out.push(...(data.items ?? []));
      pageToken = data.has_more ? data.page_token : undefined;
    } while (pageToken);
    return out;
  }

  private async get(table: string, recordId: string, userIdType = 'open_id'): Promise<RawRecord> {
    const data = await this.api.call<{ record: RawRecord }>('GET', `${this.table(table)}/records/${recordId}`, {
      query: { user_id_type: userIdType },
    });
    return data.record;
  }

  private async update(table: string, recordId: string, fields: Fields): Promise<void> {
    await this.api.call('PUT', `${this.table(table)}/records/${recordId}`, {
      query: { user_id_type: 'open_id' },
      body: { fields },
    });
  }

  private async create(table: string, fields: Fields): Promise<string> {
    const data = await this.api.call<{ record: RawRecord }>('POST', `${this.table(table)}/records`, {
      query: { user_id_type: 'open_id' },
      body: { fields },
    });
    return data.record.record_id;
  }

  /** Requests the form has written that nobody has looked at yet. */
  async newRequests(): Promise<RequestRecord[]> {
    const rows = await this.search(TABLES.requests, {
      conjunction: 'or',
      conditions: [
        { field_name: 'Status', operator: 'isEmpty', value: [] },
        { field_name: 'Status', operator: 'is', value: [STATUS.submitted] },
      ],
    });
    return rows.map(toRequest);
  }

  async requestsWithStatus(status: string): Promise<RequestRecord[]> {
    const rows = await this.search(TABLES.requests, {
      conjunction: 'and',
      conditions: [{ field_name: 'Status', operator: 'is', value: [status] }],
    });
    return rows.map(toRequest);
  }

  async request(recordId: string): Promise<RequestRecord> {
    return toRequest(await this.get(TABLES.requests, recordId));
  }

  /** The submitter as a union_id, comparable with an app's owner (lark-api.ts). */
  async requesterUnionId(recordId: string): Promise<string | undefined> {
    const raw = await this.get(TABLES.requests, recordId, 'union_id');
    return cellPeople(raw.fields.Requester)[0]?.id;
  }

  async updateRequest(recordId: string, fields: Fields): Promise<void> {
    await this.update(TABLES.requests, recordId, fields);
  }

  async accounts(): Promise<ClaudeAccount[]> {
    return (await this.search(TABLES.accounts)).map(toAccount);
  }

  async createAccount(fields: Fields): Promise<string> {
    return this.create(TABLES.accounts, fields);
  }

  async updateAccount(recordId: string, fields: Fields): Promise<void> {
    await this.update(TABLES.accounts, recordId, fields);
  }

  async settings(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const r of await this.search(TABLES.settings)) {
      const key = cellText(r.fields.Setting).trim();
      if (key) out[key] = cellText(r.fields.Value).trim();
    }
    return out;
  }

  /** Audit trail: one row per click and provisioning step. Never throws. */
  async event(requestRecordId: string, event: string, detail: string, byOpenId?: string): Promise<void> {
    try {
      await this.create(TABLES.events, {
        Event: event,
        Detail: detail.slice(0, 2000),
        Request: [requestRecordId],
        ...(byOpenId ? { By: [{ id: byOpenId }] } : {}),
      });
    } catch {
      // The audit row is best effort; the request itself already moved on.
    }
  }
}
