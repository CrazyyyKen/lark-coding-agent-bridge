import { describe, expect, it } from 'vitest';
import {
  assertTrustedDirectLineOrigin,
  DirectLineClient,
  DirectLineError,
  parseRetryAfter,
} from '../../../../src/agent/copilot-studio/direct-line.js';

interface Recorded {
  url: string;
  method: string;
  auth: string | null;
  body: string | undefined;
  redirect: RequestInit['redirect'];
}

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
    });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const noSleep = async () => {};

describe('Direct Line client', () => {
  it('accepts only trusted https Direct Line origins', () => {
    expect(assertTrustedDirectLineOrigin('https://directline.botframework.com/')).toBe(
      'https://directline.botframework.com',
    );
    expect(assertTrustedDirectLineOrigin('https://europe.directline.botframework.com')).toBe(
      'https://europe.directline.botframework.com',
    );
    for (const bad of [
      'http://directline.botframework.com',
      'https://directline.botframework.com.evil.example',
      'https://evil.example',
      'not a url',
    ]) {
      expect(() => assertTrustedDirectLineOrigin(bad), bad).toThrow(DirectLineError);
    }
  });

  it('exchanges the secret for a token and refuses redirects', async () => {
    const { impl, calls } = fakeFetch([json({ token: 'tok', conversationId: 'c1', expires_in: 1800 })]);
    const client = new DirectLineClient({ baseUrl: 'https://directline.botframework.com', fetch: impl });
    await expect(client.generateToken('the-secret', 'dl_u')).resolves.toEqual({
      token: 'tok',
      conversationId: 'c1',
      expiresInSec: 1800,
    });
    expect(calls[0]).toMatchObject({
      url: 'https://directline.botframework.com/v3/directline/tokens/generate',
      method: 'POST',
      auth: 'Bearer the-secret',
      redirect: 'error',
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ user: { id: 'dl_u' } });
  });

  it('retries safe reads on 429/5xx honouring Retry-After, but never retries a POST', async () => {
    const slept: number[] = [];
    const { impl, calls } = fakeFetch([
      new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      new Response('', { status: 503 }),
      json({ activities: [{ type: 'message', id: 'a1' }], watermark: '3' }),
    ]);
    const client = new DirectLineClient({
      baseUrl: 'https://directline.botframework.com',
      fetch: impl,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const set = await client.getActivities('tok', 'conv/1', '2');
    expect(set).toEqual({ activities: [{ type: 'message', id: 'a1' }], watermark: '3' });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe(
      'https://directline.botframework.com/v3/directline/conversations/conv%2F1/activities?watermark=2',
    );
    expect(slept[0]).toBe(2000);

    const post = fakeFetch([new Response('', { status: 502 })]);
    const postClient = new DirectLineClient({ baseUrl: 'https://directline.botframework.com', fetch: post.impl, sleep: noSleep });
    await expect(postClient.postActivity('tok', 'c1', { type: 'message' })).rejects.toMatchObject({
      code: 'server',
      status: 502,
    });
    expect(post.calls).toHaveLength(1);
  });

  it('maps statuses to error codes without leaking credentials or conversation ids', async () => {
    const { impl } = fakeFetch([new Response('', { status: 403 })]);
    const client = new DirectLineClient({ baseUrl: 'https://directline.botframework.com', fetch: impl, sleep: noSleep });
    const err = await client.postActivity('secret-token-value', 'conv-123', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirectLineError);
    expect((err as DirectLineError).code).toBe('forbidden');
    expect((err as DirectLineError).conversationGone).toBe(true);
    expect((err as Error).message).not.toContain('secret-token-value');
    expect((err as Error).message).not.toContain('conv-123');
  });

  it('reports network failures and aborts distinctly', async () => {
    const { impl } = fakeFetch([new TypeError('fetch failed')]);
    const client = new DirectLineClient({
      baseUrl: 'https://directline.botframework.com',
      fetch: impl,
      maxReadRetries: 0,
      sleep: noSleep,
    });
    await expect(client.getActivities('t', 'c', undefined)).rejects.toMatchObject({ code: 'network' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(client.getActivities('t', 'c', undefined, aborted.signal)).rejects.toMatchObject({ code: 'aborted' });
  });

  it('parses Retry-After seconds and dates with a cap', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('9999')).toBe(60_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });
});
