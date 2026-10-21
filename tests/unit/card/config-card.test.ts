import { describe, expect, it } from 'vitest';
import { configFormCard, type ConfigFormOpts } from '../../../src/card/config-card';

const base: ConfigFormOpts = {
  agentKind: 'claude',
  mode: 'personal',
  model: 'default',
  messageReply: 'markdown',
  showToolCalls: false,
  cotMessages: 'off',
  quickReplyLimit: 6,
  maxConcurrentRuns: 1,
  runIdleTimeoutMinutes: 0,
  requireMentionInGroup: false,
  larkCliIdentity: 'bot-only',
  allowedUsers: [],
  allowedChats: [],
  admins: [],
  knownChats: [],
};

describe('configFormCard quick-reply limit', () => {
  it('offers Off and 1-10, with the current value selected', () => {
    const card = configFormCard({ ...base, quickReplyLimit: 3 });
    const select = findByName(card, 'quick_reply_limit') as {
      initial_option: string;
      options: Array<{ value: string }>;
    };
    expect(select.initial_option).toBe('3');
    expect(select.options.map((o) => o.value)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(JSON.stringify(card)).toContain('6 (default)');
  });
});

function findByName(node: unknown, name: string): unknown {
  if (!node || typeof node !== 'object') return undefined;
  if ((node as { name?: unknown }).name === name) return node;
  for (const child of Object.values(node)) {
    const found = Array.isArray(child)
      ? child.map((c) => findByName(c, name)).find(Boolean)
      : findByName(child, name);
    if (found) return found;
  }
  return undefined;
}

describe('configFormCard console URL', () => {
  it('shows the web console URL when one is running', () => {
    const url = 'http://127.0.0.1:53219/?token=abc123';
    const card = configFormCard({ ...base, consoleUrl: url });
    expect(JSON.stringify(card)).toContain(url);
    expect(JSON.stringify(card)).toContain('Web console');
  });

  it('omits the console section when no console is running', () => {
    const card = configFormCard(base);
    expect(JSON.stringify(card)).not.toContain('Web console');
  });
});
