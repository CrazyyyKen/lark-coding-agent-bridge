import { describe, expect, it } from 'vitest';
import {
  createQuickReplyFilter,
  findQuickReplies,
  MAX_QUICK_REPLIES,
  QUICK_REPLY_TTL_MS,
  QuickReplies,
  stripQuickReplies,
} from '../../../src/bot/quick-replies';

const REPLY = [
  "Here's the draft to Kenny:",
  '',
  '> Hi Kenny, please find the maintenance fee request attached.',
  '',
  '```quick-replies',
  'Send it',
  '- Edit the draft',
  '3. Cancel',
  '```',
].join('\n');

describe('stripQuickReplies', () => {
  it('hides the block and keeps the rest of the reply', () => {
    expect(stripQuickReplies(REPLY)).toBe(
      "Here's the draft to Kenny:\n\n> Hi Kenny, please find the maintenance fee request attached.",
    );
  });

  it('hides a block that is still streaming in, and a half-typed fence', () => {
    expect(stripQuickReplies('Draft ready.\n```quick-replies\nSend')).toBe('Draft ready.');
    expect(stripQuickReplies('Draft ready.\n```quick')).toBe('Draft ready.');
  });

  it('leaves ordinary code blocks alone, including one that ends the reply', () => {
    const code = 'Run this:\n```bash\nls -la\n```';
    expect(stripQuickReplies(code)).toBe(code);
    expect(stripQuickReplies('plain text')).toBe('plain text');
  });
});

describe('findQuickReplies', () => {
  it('reads one option per line, without list markers', () => {
    expect(findQuickReplies(REPLY)).toEqual(['Send it', 'Edit the draft', 'Cancel']);
  });

  it(`caps at ${MAX_QUICK_REPLIES}, dedupes and skips overlong lines`, () => {
    const lines = ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'x'.repeat(200)];
    expect(findQuickReplies(`ok\n\`\`\`quick-replies\n${lines.join('\n')}\n\`\`\``)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  it('finds nothing without a block', () => {
    expect(findQuickReplies('Send it\nCancel')).toEqual([]);
  });
});

describe('QuickReplies', () => {
  it('lets only the requester answer, once', () => {
    const store = new QuickReplies();
    const offer = store.offer({ requesterId: 'ou_alice', chatId: 'oc', options: ['Send it', 'Cancel'] });

    expect(store.take(offer.id, 0, 'ou_bob')).toEqual({ ok: false, reason: 'not-requester' });
    expect(store.take(offer.id, 5, 'ou_alice')).toEqual({ ok: false, reason: 'bad-option' });
    expect(store.take(offer.id, 1, 'ou_alice')).toMatchObject({ ok: true, option: 'Cancel' });
    expect(store.take(offer.id, 0, 'ou_alice')).toEqual({ ok: false, reason: 'expired' });
  });

  it('expires offers after a day', () => {
    let now = 1_000;
    const store = new QuickReplies(() => now);
    const offer = store.offer({ requesterId: 'ou_alice', chatId: 'oc', options: ['Yes'] });
    now += QUICK_REPLY_TTL_MS + 1;
    expect(store.take(offer.id, 0, 'ou_alice')).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('createQuickReplyFilter', () => {
  it('passes on only visible text, whether the block comes whole or in pieces', () => {
    const whole = createQuickReplyFilter();
    expect(whole('Draft ready.')).toBe('Draft ready.');
    expect(whole('\n```quick-replies\nSend it\nCancel\n```')).toBe('');

    const pieces = createQuickReplyFilter();
    const shown = ['Draft ', 'ready.', '\n```quick', '-replies\nSend', ' it\n```', '\nThanks!'].map(pieces).join('');
    expect(shown).toBe('Draft ready.\nThanks!');
  });
});
