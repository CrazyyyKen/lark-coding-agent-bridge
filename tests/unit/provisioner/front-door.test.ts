import { describe, expect, it, vi } from 'vitest';
import { FrontDoor, frontDoorCard, frontDoorLinks } from '../../../src/provisioner/front-door';

const text = (card: object | undefined) => JSON.stringify(card);

function setup(settings: Record<string, string> = {}) {
  let clock = 0;
  const reply = vi.fn(async (_chatId: string, _card: object) => undefined);
  const door = new FrontDoor({ settings: async () => settings, reply, now: () => clock });
  return { door, reply, tick: (ms: number) => (clock += ms) };
}

describe('front door auto-reply', () => {
  it('answers a person who DMs the app with the guide links and the request form', async () => {
    const t = setup();
    expect(await t.door.handle({ chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_a', senderType: 'user' })).toBe(true);
    const card = text(t.reply.mock.calls[0]?.[1]);
    expect(t.reply.mock.calls[0]?.[0]).toBe('oc_dm');
    expect(card).toContain("What's a Lark AI agent?");
    expect(card).toContain('https://gdexgroup.sg.larksuite.com/wiki/NYRWwPSsYirbBokuOhBlAROzghe');
    expect(card).toContain('https://gdexgroup.sg.larksuite.com/wiki/Jh7owFCemi3GO7kBBeblkcydg7c');
    expect(card).toContain('shrlgH0hereELEP5G4uPrPcz7wb');
    expect(card).toContain('https://gdexgroup.sg.larksuite.com/wiki/OMHYwW7XAiWkCZkMvy8lLVBzg7S');
  });

  it('ignores groups and other bots, and answers a burst of messages once a minute', async () => {
    const t = setup();
    expect(await t.door.handle({ chatId: 'oc_g', chatType: 'group', senderId: 'ou_a' })).toBe(false);
    expect(await t.door.handle({ chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_bot', senderType: 'bot' })).toBe(false);
    expect(await t.door.handle({ chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_a' })).toBe(true);
    expect(await t.door.handle({ chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_a' })).toBe(false);
    t.tick(61_000);
    expect(await t.door.handle({ chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_a' })).toBe(true);
    expect(t.reply).toHaveBeenCalledTimes(2);
  });

  it('takes its links from the Base Settings when set', () => {
    const links = frontDoorLinks({ 'Request form': 'https://example.com/form', 'Support contacts': 'joe@example.com, the IT desk' });
    expect(links['Request form']).toBe('https://example.com/form');
    const card = text(frontDoorCard(links));
    expect(card).toContain('<at email=joe@example.com></at> the IT desk');
  });

  it('mentions the AI Team by email and gives every button its own full-width row', () => {
    const card = frontDoorCard(frontDoorLinks({})) as { body: { elements: Array<{ tag: string; width?: string }> } };
    const s = text(card);
    for (const email of ['ai@gdexpress.com', 'joeee@gdexpress.com', 'kenhow@gdexpress.com']) {
      expect(s).toContain(`<at email=${email}></at>`);
    }
    const buttons = card.body.elements.filter((e) => e.tag === 'button');
    expect(buttons).toHaveLength(4);
    expect(buttons.every((b) => b.width === 'fill')).toBe(true);
  });
});
