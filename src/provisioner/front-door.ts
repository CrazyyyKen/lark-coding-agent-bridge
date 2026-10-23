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
  /** Comma-separated; emails become @mentions, which open the person's profile to message them. */
  'Support contacts': 'ai@gdexpress.com, joeee@gdexpress.com, kenhow@gdexpress.com',
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

/** Full width, one per row: side by side, phones cut the labels off. */
function linkButton(text: string, url: string, type: string): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'fill',
    behaviors: [{ type: 'open_url', default_url: url }],
  };
}

function contacts(list: string): string {
  return list
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(c) ? `<at email=${c}></at>` : md(c)))
    .join(' ');
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
            '1. Get two things ready, at the same time:',
            "    - A **Claude seat**: your own, or your department's (e.g. hr@gdexpress.com). No seat yet? Your department raises a Purchase Requisition (**How to raise a PR**).",
            '    - Your **agent app**: create it in the Lark Developer Console and have your Lark admin approve it (**How to request an agent**).',
            '2. Once the app is approved and the seat is active (or its PR approved), fill in the **request form**.',
            '3. The AI Team approves it, and your new agent messages you when it\'s ready to chat.',
          ].join('\n'),
        },
        linkButton('How to request an agent', links['Request guide'], 'primary'),
        linkButton('How to raise a PR for a Claude seat', links['PR guide'], 'default'),
        linkButton('Request form', links['Request form'], 'default'),
        linkButton('How to use your agent', links['User guide'], 'default'),
        {
          tag: 'markdown',
          content: `I'm an automatic reply and can't answer questions. For help with AI agents, message the AI Team: ${contacts(links['Support contacts'])} (tap a name, then **Message**).`,
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
