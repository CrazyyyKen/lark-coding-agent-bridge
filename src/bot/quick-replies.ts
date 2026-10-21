import { randomBytes } from 'node:crypto';

/**
 * Quick replies: the agent ends a reply with a fenced block
 *
 *     ```quick-replies
 *     Send it
 *     Edit the draft
 *     Cancel
 *     ```
 *
 * The bridge hides the block from the rendered reply and posts the lines as
 * buttons. A tap counts as the requester sending that line as their next
 * message (or running it, for a `/command`). Only the requester can tap, once.
 */

export const MAX_QUICK_REPLIES = 6;
export const MAX_QUICK_REPLY_CHARS = 120;
/** How long the buttons keep working. In memory only: a restart expires them. */
export const QUICK_REPLY_TTL_MS = 24 * 60 * 60 * 1000;

const FENCE = '```quick-replies';
// A closed block, or one still streaming in (no closing fence yet).
const BLOCK = /\n?[ \t]*```quick-replies[^\n]*\n?([\s\S]*?)(?:\n[ \t]*```[ \t]*(?=\n|$)|$)/g;

/** The reply text without quick-reply blocks (or a half-typed opening fence). */
export function stripQuickReplies(text: string): string {
  if (!text.includes('```')) return text;
  let out = text.replace(BLOCK, '');
  // While streaming, the opening fence can arrive in pieces ("```quick").
  // Needs a letter after the backticks, so an ordinary code block's closing
  // fence at the end of a reply is left alone.
  const tail = /(?:^|\n)[ \t]*```[a-z-]+$/.exec(out);
  if (tail && FENCE.startsWith(tail[0].trim())) out = out.slice(0, tail.index);
  return out === text ? text : out.trimEnd();
}

/**
 * For consumers that show text as it streams in (the progress bubble): feed
 * each delta, get back only the part that stays visible once quick-reply
 * blocks are hidden. Text already passed on can't be taken back, so a block
 * split mid-fence may leak its first backticks; whole-block deltas never do.
 */
export function createQuickReplyFilter(): (delta: string) => string {
  let full = '';
  let emitted = '';
  return (delta) => {
    full += delta;
    const visible = stripQuickReplies(full);
    if (!visible.startsWith(emitted)) return '';
    const next = visible.slice(emitted.length);
    emitted = visible;
    return next;
  };
}

/** The options listed in the reply's quick-reply blocks, deduped and capped. */
export function findQuickReplies(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(BLOCK)) {
    for (const raw of (match[1] ?? '').split('\n')) {
      const line = raw.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim();
      if (!line || line.startsWith('```') || line.length > MAX_QUICK_REPLY_CHARS) continue;
      if (!found.includes(line)) found.push(line);
      if (found.length >= MAX_QUICK_REPLIES) return found;
    }
  }
  return found;
}

export interface QuickReplyOffer {
  id: string;
  requesterId: string;
  chatId: string;
  options: string[];
  createdAt: number;
}

export type TakeResult =
  | { ok: true; offer: QuickReplyOffer; option: string }
  | { ok: false; reason: 'expired' | 'not-requester' | 'bad-option' };

export class QuickReplies {
  private readonly offers = new Map<string, QuickReplyOffer>();

  constructor(private readonly now: () => number = Date.now) {}

  offer(input: Omit<QuickReplyOffer, 'id' | 'createdAt'>): QuickReplyOffer {
    this.prune();
    const offer: QuickReplyOffer = { ...input, id: this.newId(), createdAt: this.now() };
    this.offers.set(offer.id, offer);
    return offer;
  }

  /** Use one option. Spends the whole offer: one answer per question. */
  take(id: string, index: number, clickerId: string): TakeResult {
    this.prune();
    const offer = this.offers.get(id);
    if (!offer) return { ok: false, reason: 'expired' };
    if (offer.requesterId !== clickerId) return { ok: false, reason: 'not-requester' };
    const option = offer.options[index];
    if (option === undefined) return { ok: false, reason: 'bad-option' };
    this.offers.delete(id);
    return { ok: true, offer, option };
  }

  private prune(): void {
    const now = this.now();
    for (const [id, offer] of this.offers) {
      if (now - offer.createdAt > QUICK_REPLY_TTL_MS) this.offers.delete(id);
    }
  }

  private newId(): string {
    for (;;) {
      const id = `q${randomBytes(5).toString('hex')}`;
      if (!this.offers.has(id)) return id;
    }
  }
}
