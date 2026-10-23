import { md } from './cards';

/**
 * The provisioner app's answer to anyone who messages it: what a Lark AI agent
 * is and how to request one. A fixed card, no agent run, so it costs nothing.
 * Someone looking for an agent can search for this app in Lark and message it.
 */

/** Links on the card; the Base Settings rows of the same names override them. */
export const FRONT_DOOR_DEFAULTS = {
  'User guide': 'https://gdexgroup.sg.larksuite.com/wiki/Jh7owFCemi3GO7kBBeblkcydg7c',
  'Request guide': 'https://gdexgroup.sg.larksuite.com/wiki/NYRWwPSsYirbBokuOhBlAROzghe',
  'Request form': 'https://gdexgroup.sg.larksuite.com/share/base/form/shrlgH0hereELEP5G4uPrPcz7wb',
  'PR guide': 'https://gdexgroup.sg.larksuite.com/wiki/OMHYwW7XAiWkCZkMvy8lLVBzg7S',
  'Support contact': 'the AI Team',
} as const;

type Links = Record<keyof typeof FRONT_DOOR_DEFAULTS, string>;

export function frontDoorLinks(settings: Record<string, string>): Links {
  const out = { ...FRONT_DOOR_DEFAULTS } as Links;
  for (const key of Object.keys(out) as Array<keyof Links>) {
    const v = settings[key]?.trim();
    if (v) out[key] = v;
  }
  return out;
}

function linkButton(text: string, url: string, type: string): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'open_url', default_url: url }],
  };
}

export function frontDoorCard(links: Links): object {
  return {
    schema: '2.0',
    config: { summary: { content: 'Get your own Lark AI agent' } },
    header: { title: { tag: 'plain_text', content: 'Get your own Lark AI agent' }, template: 'blue' },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            "**What's a Lark AI agent?**",
            'An assistant powered by Claude that lives in Lark. You message it like a colleague, and it can draft documents and emails, summarise your mail and chats, check your calendar, build Lark Bases and forms, and run tasks for you on a schedule. It runs on the AI Team\'s server, so it\'s always on.',
            '',
            '**Two kinds**',
            '- **Personal agent:** just for you. Once you sign in, it works with your own mail, calendar and documents.',
            "- **Department agent:** shared by your department. It answers from the department's documents, and each person signs in for their own data.",
          ].join('\n'),
        },
        {
          tag: 'markdown',
          content: [
            '**How to get one**',
            "1. Make sure it has a **Claude account**: your own seat, or your department's (e.g. hr@gdexpress.com). No seat yet? Your department raises a Purchase Requisition first (**How to raise a PR**).",
            '2. Follow **How to request an agent**: create your agent app in the Lark Developer Console and have your Lark admin approve it.',
            '3. Fill in the **request form**.',
            '4. The AI Team approves it, and your new agent messages you when it\'s ready to chat.',
          ].join('\n'),
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: 'small',
          columns: [
            { tag: 'column', width: 'auto', elements: [linkButton('How to request an agent', links['Request guide'], 'primary')] },
            { tag: 'column', width: 'auto', elements: [linkButton('How to raise a PR', links['PR guide'], 'default')] },
            { tag: 'column', width: 'auto', elements: [linkButton('Request form', links['Request form'], 'default')] },
            { tag: 'column', width: 'auto', elements: [linkButton('How to use your agent', links['User guide'], 'default')] },
          ],
        },
        {
          tag: 'markdown',
          content: `I'm an automatic reply and can't answer questions. Questions about AI agents: ask ${md(links['Support contact'])}.`,
          text_size: 'notation',
        },
      ],
    },
  };
}

/** At most one card per person per minute, so a burst of messages gets one answer. */
const REPLY_GAP_MS = 60_000;

export interface FrontDoorDeps {
  settings: () => Promise<Record<string, string>>;
  reply: (chatId: string, card: object) => Promise<void>;
  now?: () => number;
}

export interface IncomingMessage {
  chatId: string;
  chatType: string;
  senderId: string;
  senderType?: string;
}

export class FrontDoor {
  private readonly lastReply = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: FrontDoorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Answers a person's direct message; groups and other bots get nothing. */
  async handle(msg: IncomingMessage): Promise<boolean> {
    if (msg.chatType !== 'p2p') return false;
    if (msg.senderType && msg.senderType !== 'user') return false;
    const last = this.lastReply.get(msg.senderId);
    if (last !== undefined && this.now() - last < REPLY_GAP_MS) return false;
    this.lastReply.set(msg.senderId, this.now());
    const settings = await this.deps.settings().catch(() => ({}));
    await this.deps.reply(msg.chatId, frontDoorCard(frontDoorLinks(settings)));
    return true;
  }
}
