// Server bot names follow lark-bots.sh check_name: 2-31 characters, lowercase
// letters, digits and '-', starting with a letter.
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

export const APP_ID_RE = /^cli_[A-Za-z0-9]+$/;

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Base name for a new bot: the email prefix for a personal bot (ali.tan@… → ali-tan),
 * dept-<department> for a department bot. Falls back to the agent name.
 */
export function baseBotName(opts: {
  botType: string;
  email?: string;
  personName?: string;
  department?: string;
  agentName?: string;
}): string {
  const raw =
    opts.botType === 'Department'
      ? `dept-${slug(opts.department || opts.agentName || 'bot')}`
      : slug(opts.email?.split('@')[0] || opts.personName || opts.agentName || 'bot');
  let name = raw.slice(0, 28).replace(/-+$/, '');
  if (!/^[a-z]/.test(name)) name = `bot-${name}`.slice(0, 28).replace(/-+$/, '');
  if (!NAME_RE.test(name)) name = 'bot';
  return name;
}

/** First free name: base, then base-2, base-3, … */
export function freeBotName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`no free bot name for ${base}`);
}

export function isValidBotName(name: string): boolean {
  return NAME_RE.test(name);
}
