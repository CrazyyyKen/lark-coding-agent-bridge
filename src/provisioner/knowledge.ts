import type { RequestRecord } from './base-store';

/** One document, wiki page or group a department bot should have, and whether it does. */
export interface KnowledgeItem {
  kind: 'document' | 'wiki' | 'group';
  label: string;
  /** undefined: can't be checked automatically (unknown link type). */
  ok?: boolean;
}

export interface BotGetResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type BotGet = (path: string, params?: Record<string, string | number>) => Promise<BotGetResult>;

interface Probe {
  path: string;
  params?: Record<string, string | number>;
}

const TOKEN = '([A-Za-z0-9_-]{6,})';

/** Which read-only call proves the bot can open a link. */
export function probeFor(link: string): Probe | undefined {
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`/wiki/(?:settings|space)/${TOKEN}`).exec(link))) return { path: `/open-apis/wiki/v2/spaces/${m[1]}` };
  if ((m = new RegExp(`/wiki/${TOKEN}`).exec(link))) return { path: '/open-apis/wiki/v2/spaces/get_node', params: { token: m[1] as string } };
  if ((m = new RegExp(`/docx/${TOKEN}`).exec(link))) return { path: `/open-apis/docx/v1/documents/${m[1]}` };
  if ((m = new RegExp(`/docs/${TOKEN}`).exec(link))) return { path: `/open-apis/doc/v2/meta/${m[1]}` };
  if ((m = new RegExp(`/base/${TOKEN}`).exec(link))) return { path: `/open-apis/bitable/v1/apps/${m[1]}` };
  if ((m = new RegExp(`/sheets/${TOKEN}`).exec(link))) return { path: `/open-apis/sheets/v3/spreadsheets/${m[1]}` };
  if ((m = new RegExp(`/drive/folder/${TOKEN}`).exec(link))) {
    return { path: '/open-apis/drive/v1/files', params: { folder_token: m[1] as string, page_size: 1 } };
  }
  return undefined;
}

/** Non-empty lines of a free-text form answer (links or names, one per line). */
export function lines(text: string): string[] {
  return text
    .split(/[\r\n]+/)
    .map((l) => l.trim().replace(/^[-*•]\s*/, ''))
    .filter(Boolean)
    .slice(0, 30);
}

/** Checks, as the bot, every document, wiki page and group the request lists. */
export async function checkKnowledge(req: RequestRecord, get: BotGet): Promise<KnowledgeItem[]> {
  const items: KnowledgeItem[] = [];
  const probeAll = async (kind: 'document' | 'wiki', text: string) => {
    for (const label of lines(text)) {
      const probe = probeFor(label);
      items.push({ kind, label, ok: probe ? (await get(probe.path, probe.params)).ok : undefined });
    }
  };
  await probeAll('document', req.documents);
  await probeAll('wiki', req.wikiPages);

  const wanted = lines(req.groupChats);
  if (wanted.length) {
    const chats = await get('/open-apis/im/v1/chats', { page_size: 100 });
    const joined = ((chats.data as { items?: Array<{ chat_id?: string; name?: string }> } | undefined)?.items ?? []).map(
      (c) => ({ id: c.chat_id ?? '', name: (c.name ?? '').toLowerCase() }),
    );
    for (const label of wanted) {
      const id = /oc_[A-Za-z0-9]+/.exec(label)?.[0];
      const ok = joined.some((c) => (id ? c.id === id : c.name === label.toLowerCase()));
      items.push({ kind: 'group', label, ok: chats.ok ? ok : undefined });
    }
  }
  return items;
}

/** Starting instructions for a department bot, from the request form. Edited freely afterwards. */
export function starterInstructions(req: RequestRecord, botName: string): string {
  const dept = req.department || 'the department';
  const name = req.agentName || `${dept} agent`;
  const sources = [...lines(req.documents), ...lines(req.wikiPages)];
  return [
    `# ${name}`,
    '',
    `You are ${name}, the AI agent for the ${dept} department at GDEX. The people you talk to are members of ${dept}.`,
    '',
    '## What you are for',
    '',
    req.purpose || `Help ${dept} staff find answers in the department's documents.`,
    '',
    '## Where your answers come from',
    '',
    sources.length
      ? 'Answer from these first, and say which one you used:'
      : 'Answer from the documents and wiki pages shared with you, and say which one you used.',
    ...sources.map((s) => `- ${s}`),
    '',
    `If they don't cover a question, say so and suggest asking someone in ${dept}; don't guess.`,
    '',
    '## Rules',
    '',
    '- Use only what is shared with you. Never pass one person\'s personal data to someone else.',
    `- Questions about a specific person's case (salary, disciplinary matters, medical) go to a person in ${dept}, not to you.`,
    '- In group chats, answer when @mentioned and keep replies short.',
    '',
    `<!-- Started from request ${req.requestId || req.recordId}. Replace with: ./lark-bots.sh set-instructions ${botName} --force -->`,
    '',
  ].join('\n');
}
