import { promptSection } from '../prompt';
import { MCP_TOOL_NAMES } from './mcp-server';

/**
 * Text of the Direct Line message sent to Copilot Studio for one bridge turn.
 *
 * The bridge prompt (bridge_context / user_input / quoted context, built by
 * the channel) is wrapped with two clearly separated, bridge-authored blocks:
 *
 *  - bridge_execution: the per-turn execution token Studio must pass to the
 *    lark-bridge MCP tools. It is a bearer capability visible to the model —
 *    see execution-registry.ts for why that is acceptable only for owner DMs
 *    and read-only operations.
 *  - bridge_reply_protocol: asks the agent to end its final reply with the
 *    completion marker, the bridge's end-of-turn signal (the published
 *    Studio instructions say the same; this is a reminder, not authority).
 *
 * These are data for the Studio agent, not trusted system instructions: the
 * trusted instructions live in the published agent (docs/copilot-studio.md).
 */

export interface StudioMessageInput {
  prompt: string;
  executionToken: string;
  completionMarker: string;
  maxChars: number;
}

const TRUNCATION_NOTE = '\n…（上下文过长，bridge 已截断中间部分）…\n';

export function buildStudioMessage(input: StudioMessageInput): string {
  const execution = promptSection('bridge_execution', {
    executionToken: input.executionToken,
    tools: [MCP_TOOL_NAMES.runCli, MCP_TOOL_NAMES.listOperations, MCP_TOOL_NAMES.ping],
    rules: [
      'Pass executionToken unchanged in every lark-bridge tool call made while answering this message.',
      'It stops working when this reply ends. Never reuse a token from an earlier message.',
      'Never show or repeat the token to the user.',
    ],
  });
  const protocol = input.completionMarker
    ? promptSection('bridge_reply_protocol', {
        endOfReplyMarker: input.completionMarker,
        rule: 'End your final reply to this message with endOfReplyMarker as the last line. Use it exactly once, only when you are completely done.',
      })
    : '';
  const frame = [execution, protocol].filter(Boolean);
  const budget = input.maxChars - frame.join('\n\n').length - 4;
  const body = truncateMiddle(input.prompt, Math.max(200, budget));
  return [execution, body, protocol].filter(Boolean).join('\n\n');
}

/** Keep the head (context) and tail (user input sits last) of an oversized prompt. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const keep = maxChars - TRUNCATION_NOTE.length;
  if (keep <= 0) return text.slice(text.length - maxChars);
  const head = Math.floor(keep * 0.35);
  const tail = keep - head;
  return `${text.slice(0, head)}${TRUNCATION_NOTE}${text.slice(text.length - tail)}`;
}
