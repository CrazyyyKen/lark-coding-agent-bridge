import { describe, expect, it } from 'vitest';
import { cellLinks, cellPeople, cellText, toRequest } from '../../../src/provisioner/base-store';
import { md, person } from '../../../src/provisioner/cards';
import { LarkBots } from '../../../src/provisioner/lark-bots';
import { baseBotName, freeBotName } from '../../../src/provisioner/naming';

describe('Base cell parsing', () => {
  it('reads text from strings, rich-text segments and options', () => {
    expect(cellText('plain')).toBe('plain');
    expect(cellText([{ type: 'text', text: 'cli_' }, { type: 'text', text: 'abc' }])).toBe('cli_abc');
    expect(cellText({ value: [{ text: 'REQ-0001' }] })).toBe('REQ-0001');
    expect(cellText(null)).toBe('');
  });

  it('reads people and links', () => {
    expect(cellPeople([{ id: 'ou_1', name: 'Ali', email: 'a@x.com' }])).toEqual([{ id: 'ou_1', name: 'Ali', email: 'a@x.com' }]);
    expect(cellLinks({ link_record_ids: ['rec1'] })).toEqual(['rec1']);
    expect(cellLinks([{ record_ids: ['rec2', 'rec3'] }])).toEqual(['rec2', 'rec3']);
  });

  it('maps a form record', () => {
    const r = toRequest({
      record_id: 'rec1',
      fields: {
        'Agent name': [{ text: " Ali's AI Agent ", type: 'text' }],
        'Bot type': 'Personal',
        'App ID': 'cli_x',
        Confirmations: ['one', 'two'],
        Requester: [{ id: 'ou_1', name: 'Ali' }],
      },
    });
    expect(r).toMatchObject({ agentName: "Ali's AI Agent", botType: 'Personal', appId: 'cli_x', confirmations: ['one', 'two'], status: '' });
    expect(r.requester?.id).toBe('ou_1');
  });
});

describe('bot names', () => {
  it('uses the email prefix for personal bots and dept-<department> for department bots', () => {
    expect(baseBotName({ botType: 'Personal', email: 'Ali.Tan@gdexpress.com' })).toBe('ali-tan');
    expect(baseBotName({ botType: 'Department', department: 'HR & Admin' })).toBe('dept-hr-admin');
    expect(baseBotName({ botType: 'Personal', email: '007@x.com' })).toBe('bot-007');
    expect(baseBotName({ botType: 'Personal', personName: '王小明' })).toBe('bot');
  });

  it('adds a number when the name is taken', () => {
    expect(freeBotName('ali', new Set())).toBe('ali');
    expect(freeBotName('ali', new Set(['ali', 'ali-2']))).toBe('ali-3');
  });
});

describe('person', () => {
  it('uses the name when Lark sends one, else an @-mention of the clicker', () => {
    expect(person('Ho Joe Ee', 'ou_abc')).toBe('Ho Joe Ee');
    expect(person(undefined, 'ou_abc123')).toBe('<at id=ou_abc123></at>');
    expect(person('', 'not-an-id')).toBe('an approver');
  });
});

describe('card text', () => {
  it('neutralises markdown and tags from form answers', () => {
    expect(md('<at id=all></at> **bold** [x](http://y)')).toBe('＜at id=all＞＜/at＞ \\*\\*bold\\*\\* \\[x\\]\\(http://y\\)');
    expect(md(undefined)).toBe('—');
  });
});

describe('LarkBots.add', () => {
  it('passes the secret on stdin, never as an argument, and reads the JSON result', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const bots = new LarkBots(async (args, stdin) => {
      calls.push({ args, stdin });
      return { code: 4, output: '\u001b[1m==> step\u001b[0m\n{"ok":false,"code":4,"step":"Connecting the Lark app","error":"Lark rejected app"}\n' };
    }, '/tmp');
    const r = await bots.add({ name: 'ali', appId: 'cli_x', appSecret: 'S3CRET', mode: 'personal', tenant: 'lark', claudeAccount: 'ai@gdexpress.com' });
    expect(calls[0]?.args).toEqual([
      'add', 'ali', '--app-id', 'cli_x', '--mode', 'personal', '--tenant', 'lark',
      '--claude-account', 'ai@gdexpress.com', '--app-secret-stdin', '--yes', '--json',
    ]);
    expect(calls[0]?.args.join(' ')).not.toContain('S3CRET');
    expect(calls[0]?.stdin).toBe('S3CRET\n');
    expect(r).toMatchObject({ ok: false, code: 4, result: { error: 'Lark rejected app' } });
    expect(r.output).not.toContain('\u001b');
  });
});
