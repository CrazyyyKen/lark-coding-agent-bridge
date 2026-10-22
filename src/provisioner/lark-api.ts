import type { TenantBrand } from '../config/schema';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

// Bounds every call so one hung endpoint can't stall the poll loop.
const REQUEST_TIMEOUT_MS = 20_000;

export class LarkApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'LarkApiError';
  }
}

export interface CallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/**
 * Minimal OpenAPI client on an app's tenant token. The provisioner talks to
 * Base, chat membership and the application API, none of which the bridge's
 * channel wraps, and it also needs short-lived clients for the apps it is
 * about to provision.
 */
export class LarkApi {
  private readonly baseUrl: string;
  private token: string | undefined;
  private tokenExpiresAt = 0;

  constructor(
    private readonly opts: {
      tenant: TenantBrand;
      appId: string;
      appSecret: string;
      fetchImpl?: typeof fetch;
    },
  ) {
    this.baseUrl = ENDPOINTS[opts.tenant];
  }

  /**
   * fetch, tried up to three times when the network itself fails ("fetch failed",
   * timeouts), which the bot server sees now and then. API errors are not retried.
   */
  private async fetch(url: string | URL, init: RequestInit): Promise<Response> {
    const f = this.opts.fetchImpl ?? fetch;
    for (let attempt = 1; ; attempt++) {
      try {
        return await f(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }

  async tenantToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.tokenExpiresAt - now > 60_000) return this.token;
    const resp = await this.fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.opts.appId, app_secret: this.opts.appSecret }),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new LarkApiError(data.code ?? -1, `tenant token: ${data.msg ?? `HTTP ${resp.status}`}`);
    }
    this.token = data.tenant_access_token;
    this.tokenExpiresAt = now + (data.expire ?? 7200) * 1000;
    return this.token;
  }

  async call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const resp = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.tenantToken()}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const data = (await resp.json().catch(() => ({}))) as { code?: number; msg?: string; data?: T };
    if (data.code !== 0) {
      throw new LarkApiError(data.code ?? -1, `${method} ${path}: ${data.msg ?? `HTTP ${resp.status}`}`);
    }
    return data.data as T;
  }
}

/**
 * Owner of an app, as a union_id. union_ids are the same across a tenant's own
 * apps, so this can be compared with the form submitter as Base reports them
 * to the provisioner app. undefined when the app may not read its own info.
 */
export async function appOwnerUnionId(api: LarkApi, appId: string): Promise<string | undefined> {
  const data = await api.call<{
    app?: { owner?: { owner_id?: string }; creator_id?: string };
  }>('GET', `/open-apis/application/v6/applications/${encodeURIComponent(appId)}`, {
    query: { lang: 'en_us', user_id_type: 'union_id' },
  });
  return data.app?.owner?.owner_id || undefined;
}
