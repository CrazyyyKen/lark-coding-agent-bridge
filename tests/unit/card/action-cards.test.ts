import { describe, expect, it } from 'vitest';
import {
  helpCard,
  quickRepliesCard,
  scheduleRunCard,
  signInCard,
  whoamiCard,
} from '../../../src/card/templates';

/** Every button in a card, as {text, value?, url?}. */
function buttons(card: unknown): Array<{ text: string; value?: unknown; url?: string }> {
  const out: Array<{ text: string; value?: unknown; url?: string }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { tag?: string; text?: { content?: string }; value?: unknown; url?: string };
    if (n.tag === 'button') {
      out.push({
        text: n.text?.content ?? '',
        ...(n.value !== undefined ? { value: n.value } : {}),
        ...(n.url ? { url: n.url } : {}),
      });
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };
  walk(card);
  return out;
}

describe('action cards', () => {
  it('sign-in card opens the link from a button and keeps the raw link as a fallback', () => {
    const card = signInCard({ url: 'https://lark.example/verify?c=1', minutes: 10, welcome: true });
    expect(buttons(card)).toEqual([{ text: 'Sign in with Lark', url: 'https://lark.example/verify?c=1' }]);
    expect(JSON.stringify(card)).toContain('Button not working? Open: https://lark.example/verify?c=1');
    expect(JSON.stringify(card)).toContain("I'm the team assistant");
  });

  it('whoami card offers the opposite action', () => {
    expect(buttons(whoamiCard({ signedIn: false }))).toEqual([{ text: '🔑 Sign in', value: { cmd: 'login' } }]);
    const signedIn = whoamiCard({ signedIn: true, name: 'Alice', permissions: 12 });
    expect(buttons(signedIn)).toEqual([{ text: 'Sign out', value: { cmd: 'logout' } }]);
    expect(JSON.stringify(signedIn)).toContain('12 permissions');
  });

  it('scheduled-run card offers Run again and Pause, then Resume once paused', () => {
    expect(buttons(scheduleRunCard({ id: 's1ab', label: 'weekdays 08:30', prompt: 'Triage' }))).toEqual([
      { text: '▶ Run again', value: { cmd: 'schedule.run', arg: 's1ab' } },
      { text: '⏸ Pause schedule', value: { cmd: 'schedule.pause', arg: 's1ab run-card' } },
    ]);
    expect(
      buttons(scheduleRunCard({ id: 's1ab', label: 'weekdays 08:30', prompt: 'Triage', paused: true })),
    ).toEqual([{ text: '▶ Resume schedule', value: { cmd: 'schedule.resume', arg: 's1ab run-card' } }]);
  });

  it('help card has shortcuts to scheduled tasks, and to sign-in on team bots', () => {
    const plain = buttons(helpCard('Claude Code')).map((b) => b.value);
    expect(plain).toContainEqual({ cmd: 'schedule.list' });
    expect(plain).not.toContainEqual({ cmd: 'login' });
    const team = buttons(helpCard('Claude Code', { personalLogin: true })).map((b) => b.value);
    expect(team).toContainEqual({ cmd: 'login' });
    expect(team).toContainEqual({ cmd: 'whoami' });
  });

  it('quick-reply card shortens long labels but keeps the option index', () => {
    const long = 'Draft replies for emails 1, 3 and 5 and archive the newsletters';
    const card = quickRepliesCard('q1', ['Send it', long]);
    expect(buttons(card)).toEqual([
      { text: 'Send it', value: { quick_reply: 'q1', i: 0 } },
      { text: `${long.slice(0, 39)}…`, value: { quick_reply: 'q1', i: 1 } },
    ]);
  });
});
