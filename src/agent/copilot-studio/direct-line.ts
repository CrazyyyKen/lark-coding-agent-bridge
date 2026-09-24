import type { DirectLineActivity } from './activities';

/**
 * Minimal Bot Framework Direct Line 3.0 REST client for a published Copilot
 * Studio agent (https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-direct-line-3-0-api-reference).
 *
 * Credentials (the Studio "web channel security" secret, and the scoped
 * conversation tokens it is exchanged for) are only ever sent to trusted
 * HTTPS Direct Line origins, and redirects are refused so a response can
 * never bounce an Authorization header to another host.
 */

export const TRUSTED_DIRECT_LINE_ORIGINS: readonly string[] = [
  'https://directline.botframework.com',
  'https://europe.directline.botframework.com',
  'https://india.directline.botframework.com',
  'https://directline.botframework.azure.us',
];

export type DirectLineErrorCode =
  | 'untrusted-origin'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'protocol';

export class DirectLineError extends Error {
  constructor(
    readonly code: DirectLineErrorCode,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DirectLineError';
  }

  /** True when the conversation/token can no longer be used. */
  get conversationGone(): boolean {
    return this.code === 'forbidden' || this.code === 'not-found' || this.code === 'unauthorized';
  }
}

export interface DirectLineToken {
  token: string;
  conversationId?: string;
  expiresInSec: number;
}

export interface DirectLineActivitySet {
  activities: DirectLineActivity[];
  watermark?: string;
}

export interface DirectLineClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /**
   * Test-only override of the trusted origin list (e.g. a local fake on
   * http://127.0.0.1). Not reachable from profile config.
   */
  trustedOriginsForTesting?: readonly string[];
  requestTimeoutMs?: number;
  maxReadRetries?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class DirectLineClient {
  readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(opts: DirectLineClientOptions) {
    this.origin = assertTrustedDirectLineOrigin(opts.baseUrl, opts.trustedOriginsForTesting);
    this.fetchImpl = opts.fetch ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
    this.maxReadRetries = opts.maxReadRetries ?? 3;
    this.sleep = opts.sleep ?? abortableSleep;
  }

  /** Exchange the Studio secret for a conversation-scoped token. */
  async generateToken(secret: string, userId: string, signal?: AbortSignal): Promise<DirectLineToken> {
    const body = await this.request('POST', '/v3/directline/tokens/generate', secret, {
      body: { user: { id: userId } },
      signal,
    });
    return parseToken(body);
  }

  async refreshToken(token: string, signal?: AbortSignal): Promise<DirectLineToken> {
    const body = await this.request('POST', '/v3/directline/tokens/refresh', token, { signal });
    return parseToken(body);
  }

  /** Start the conversation the token was generated for. */
  async startConversation(token: string, signal?: AbortSignal): Promise<{ conversationId: string }> {
    const body = (await this.request('POST', '/v3/directline/conversations', token, {
      signal,
    })) as { conversationId?: unknown };
    if (typeof body?.conversationId !== 'string' || !body.conversationId) {
      throw new DirectLineError('protocol', 'Direct Line did not return a conversationId');
    }
    return { conversationId: body.conversationId };
  }

  /**
   * Send one activity. Never retried here: a POST that timed out may already
   * have been accepted, so callers must reconcile (see the adapter) instead of
   * blindly resending.
   */
  async postActivity(
    token: string,
    conversationId: string,
    activity: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ id?: string }> {
    const body = (await this.request(
      'POST',
      `/v3/directline/conversations/${encodeURIComponent(conversationId)}/activities`,
      token,
      { body: activity, signal },
    )) as { id?: unknown };
    return typeof body?.id === 'string' ? { id: body.id } : {};
  }

  /** Read activities after `watermark`. Safe to retry. */
  async getActivities(
    token: string,
    conversationId: string,
    watermark: string | undefined,
    signal?: AbortSignal,
  ): Promise<DirectLineActivitySet> {
    const query = watermark !== undefined ? `?watermark=${encodeURIComponent(watermark)}` : '';
    const body = (await this.request(
      'GET',
      `/v3/directline/conversations/${encodeURIComponent(conversationId)}/activities${query}`,
      token,
      { signal, retry: true },
    )) as { activities?: unknown; watermark?: unknown };
    const activities = Array.isArray(body?.activities)
      ? (body.activities.filter((a) => a && typeof a === 'object') as DirectLineActivity[])
      : [];
    return {
      activities,
      ...(typeof body?.watermark === 'string' ? { watermark: body.watermark } : {}),
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    bearer: string,
    opts: { body?: unknown; signal?: AbortSignal; retry?: boolean },
  ): Promise<unknown> {
    const attempts = opts.retry ? this.maxReadRetries + 1 : 1;
    let lastError: DirectLineError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && lastError) {
        const backoff = lastError.retryAfterMs ?? Math.min(10_000, 500 * 2 ** (attempt - 1));
        await this.sleep(Math.min(backoff, 30_000), opts.signal);
      }
      try {
        return await this.requestOnce(method, path, bearer, opts.body, opts.signal);
      } catch (err) {
        if (!(err instanceof DirectLineError)) throw err;
        lastError = err;
        const retryable =
          err.code === 'rate-limited' || err.code === 'server' || err.code === 'network' || err.code === 'timeout';
        if (!opts.retry || !retryable) throw err;
      }
    }
    throw lastError ?? new DirectLineError('network', 'Direct Line request failed');
  }

  private async requestOnce(
    method: 'GET' | 'POST',
    path: string,
    bearer: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (signal?.aborted) throw new DirectLineError('aborted', 'Direct Line request aborted');
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
        },
        ...(method === 'POST' ? { body: body === undefined ? '' : JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw new DirectLineError('aborted', 'Direct Line request aborted');
      if (timeout.aborted) {
        throw new DirectLineError('timeout', `Direct Line ${method} timed out after ${this.requestTimeoutMs}ms`);
      }
      throw new DirectLineError('network', `Direct Line ${method} failed: ${describeNetworkError(err)}`);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new DirectLineError(
        codeForStatus(res.status),
        `Direct Line ${method} ${redactPath(path)} returned HTTP ${res.status}`,
        res.status,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DirectLineError('protocol', `Direct Line ${method} returned invalid JSON`);
    }
  }
}

/** Validate a configured base URL; returns its origin. */
export function assertTrustedDirectLineOrigin(
  baseUrl: string,
  trustedOverride?: readonly string[],
): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DirectLineError('untrusted-origin', 'copilotStudio.directLineBaseUrl is not a valid URL');
  }
  const trusted = trustedOverride ?? TRUSTED_DIRECT_LINE_ORIGINS;
  if (!trusted.includes(url.origin)) {
    throw new DirectLineError(
      'untrusted-origin',
      `copilotStudio.directLineBaseUrl ${url.origin} is not a trusted Direct Line origin ` +
        `(expected one of ${TRUSTED_DIRECT_LINE_ORIGINS.join(', ')})`,
    );
  }
  if (!trustedOverride && url.protocol !== 'https:') {
    throw new DirectLineError('untrusted-origin', 'copilotStudio.directLineBaseUrl must use https');
  }
  return url.origin;
}

function parseToken(body: unknown): DirectLineToken {
  const raw = body as { token?: unknown; conversationId?: unknown; expires_in?: unknown };
  if (typeof raw?.token !== 'string' || !raw.token) {
    throw new DirectLineError('protocol', 'Direct Line did not return a token');
  }
  const expiresInSec =
    typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in) && raw.expires_in > 0
      ? raw.expires_in
      : 1800;
  return {
    token: raw.token,
    expiresInSec,
    ...(typeof raw.conversationId === 'string' ? { conversationId: raw.conversationId } : {}),
  };
}

function codeForStatus(status: number): DirectLineErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'protocol';
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return undefined;
}

function redactPath(path: string): string {
  return path.replace(/conversations\/[^/?]+/, 'conversations/{id}').replace(/\?.*$/, '');
}

function describeNetworkError(err: unknown): string {
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  if (cause) return cause;
  return err instanceof Error ? err.name : 'unknown error';
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DirectLineError('aborted', 'aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DirectLineError('aborted', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
