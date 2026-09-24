import { describe, expect, it } from 'vitest';
import {
  renderBotMessage,
  sanitizeActivity,
  stripCompletionMarker,
} from '../../../../src/agent/copilot-studio/activities.js';
import { buildStudioMessage, truncateMiddle } from '../../../../src/agent/copilot-studio/studio-message.js';

describe('copilot studio activities', () => {
  it('renders text, adaptive card text and suggested actions', () => {
    const text = renderBotMessage({
      type: 'message',
      text: 'Here is your agenda',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            body: [
              { type: 'TextBlock', text: 'Standup 09:30' },
              { type: 'FactSet', facts: [{ title: 'Room', value: 'A1' }] },
              { type: 'Container', items: [{ type: 'TextBlock', text: 'Nested' }] },
            ],
            actions: [{ type: 'Action.Submit', title: 'Join' }],
          },
        },
      ],
      suggestedActions: { actions: [{ title: 'Tomorrow' }] },
    });
    expect(text).toBe('Here is your agenda\n\nStandup 09:30\nRoom: A1\nNested\n选项：「Join」\n\n建议操作：「Tomorrow」');
  });

  it('describes unrenderable attachments without fetching them', () => {
    expect(
      renderBotMessage({ type: 'message', attachments: [{ contentType: 'image/png', contentUrl: 'https://x/y.png' }] }),
    ).toContain('附件');
  });

  it('only treats a trailing completion marker as end-of-turn', () => {
    expect(stripCompletionMarker('Done.\n[[turn-complete]]\n', '[[turn-complete]]')).toEqual({ text: 'Done.', found: true });
    expect(stripCompletionMarker('I will say [[turn-complete]] later', '[[turn-complete]]')).toEqual({
      text: 'I will say [[turn-complete]] later',
      found: false,
    });
    expect(stripCompletionMarker('x', '')).toEqual({ text: 'x', found: false });
  });

  it('sanitizes activities to shape only', () => {
    const shape = sanitizeActivity(
      {
        type: 'message',
        id: 'a1',
        from: { id: 'bot', role: 'bot' },
        text: 'secret document body',
        replyToId: 'u1',
        channelData: { clientActivityID: 'x', token: 'cst_should_not_leak' },
      },
      'dl_user',
    );
    const serialized = JSON.stringify(shape);
    expect(serialized).not.toContain('secret document body');
    expect(serialized).not.toContain('cst_should_not_leak');
    expect(shape).toMatchObject({ type: 'message', textChars: 20, hasReplyToId: true, fromRole: 'bot' });
  });
});

describe('copilot studio message', () => {
  it('wraps the prompt with the execution token and reply protocol', () => {
    const message = buildStudioMessage({
      prompt: '<user_input>\n{"text":"hi"}\n</user_input>',
      executionToken: 'cst_abc',
      completionMarker: '[[turn-complete]]',
      maxChars: 10_000,
    });
    expect(message.startsWith('<bridge_execution>')).toBe(true);
    expect(message).toContain('"executionToken":"cst_abc"');
    expect(message).toContain('<user_input>');
    expect(message).toContain('"endOfReplyMarker":"[[turn-complete]]"');
  });

  it('omits the protocol block when the marker is disabled', () => {
    const message = buildStudioMessage({ prompt: 'p', executionToken: 't', completionMarker: '', maxChars: 10_000 });
    expect(message).not.toContain('bridge_reply_protocol');
  });

  it('truncates the middle, keeping the user input at the end', () => {
    const prompt = `HEAD${'x'.repeat(5000)}<user_input>keep me</user_input>`;
    const out = truncateMiddle(prompt, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('<user_input>keep me</user_input>')).toBe(true);
    const message = buildStudioMessage({ prompt, executionToken: 'cst_t', completionMarker: '[[m]]', maxChars: 1500 });
    expect(message.length).toBeLessThanOrEqual(1500);
    expect(message).toContain('keep me');
    expect(message).toContain('cst_t');
  });
});
