/**
 * When a scheduled task runs. Every recurring form (`daily 08:30`,
 * `weekdays 8:30am`, `mon,wed 17:00`) is normalized to a 5-field cron
 * expression; `once` is a single local date-time. Times are wall-clock in the
 * schedule's IANA time zone.
 */
export type ScheduleWhen =
  | { kind: 'cron'; expr: string }
  | { kind: 'once'; at: string };

export interface ParsedSchedule {
  when: ScheduleWhen;
  /** What the user typed for the time, normalized ("weekdays 08:30"). */
  label: string;
  prompt: string;
}

/** Recurring schedules may not run more often than this. */
export const MIN_INTERVAL_MS = 15 * 60 * 1000;

export const WHEN_HELP = [
  '`daily 08:30`',
  '`weekdays 8:30am`',
  '`weekends 10:00`',
  '`mon,wed,fri 17:00` or `mon-thu 5pm`',
  '`once 2026-12-24 09:00`',
  '`cron 30 8 * * 1-5`',
].join(' · ');

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Split `/schedule add` arguments into the time and the task prompt.
 * Returns an error message (for the user) when the time isn't understood.
 */
export function parseScheduleArgs(args: string): ParsedSchedule | { error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0]?.toLowerCase();
  if (!head) return { error: 'Tell me when and what, e.g. `/schedule add weekdays 08:30 Triage my inbox`.' };

  let when: ScheduleWhen;
  let label: string;
  let used: number;
  if (head === 'cron') {
    const fields = tokens.slice(1, 6);
    const expr = fields.join(' ');
    if (fields.length < 5) return { error: 'A cron schedule needs 5 fields, e.g. `cron 30 8 * * 1-5`.' };
    const cronError = validateCron(expr);
    if (cronError) return { error: cronError };
    when = { kind: 'cron', expr };
    label = `cron ${expr}`;
    used = 6;
  } else if (head === 'once') {
    const date = tokens[1];
    const time = tokens[2] ? parseTime(tokens[2]) : undefined;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !validDate(date)) {
      return { error: 'Write a one-off time as `once YYYY-MM-DD HH:MM`.' };
    }
    if (!time) return { error: 'Write a one-off time as `once YYYY-MM-DD HH:MM`.' };
    const hhmm = `${pad(time.hour)}:${pad(time.minute)}`;
    when = { kind: 'once', at: `${date}T${hhmm}` };
    label = `once ${date} ${hhmm}`;
    used = 3;
  } else {
    const days = parseDays(head);
    if (!days) return { error: `I don't understand "${tokens[0]}". Try one of: ${WHEN_HELP}` };
    const time = tokens[1] ? parseTime(tokens[1]) : undefined;
    if (!time) return { error: `Add a time after "${tokens[0]}", e.g. \`${head} 08:30\`.` };
    const hhmm = `${pad(time.hour)}:${pad(time.minute)}`;
    when = { kind: 'cron', expr: `${time.minute} ${time.hour} * * ${days.cron}` };
    label = `${days.label} ${hhmm}`;
    used = 2;
  }

  const prompt = tokens.slice(used).join(' ').trim();
  if (!prompt) return { error: 'Add what I should do after the time, e.g. `/schedule add weekdays 08:30 Triage my inbox`.' };
  return { when, label, prompt };
}

/** The next time `when` is due strictly after `after` (epoch ms), or undefined. */
export function nextRunAt(when: ScheduleWhen, timeZone: string, after: number): number | undefined {
  if (when.kind === 'once') {
    const [date, time] = when.at.split('T');
    const [y, mo, d] = date!.split('-').map(Number);
    const [h, mi] = time!.split(':').map(Number);
    const at = zonedToUtc(y!, mo!, d!, h!, mi!, timeZone);
    return at > after ? at : undefined;
  }
  const cron = parseCron(when.expr);
  if (!cron) return undefined;
  const start = zonedParts(after, timeZone);
  const startDay = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; offset <= 400; offset++) {
    const day = new Date(startDay + offset * 86_400_000);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    if (!cron.month.has(month) || !dayMatches(cron, date, day.getUTCDay())) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const at = zonedToUtc(year, month, date, hour, minute, timeZone);
        if (at > after) return at;
      }
    }
  }
  return undefined;
}

/** Shortest gap between the next few runs of a recurring schedule. */
export function shortestInterval(when: ScheduleWhen, timeZone: string, from: number): number {
  if (when.kind === 'once') return Infinity;
  let shortest = Infinity;
  let previous = nextRunAt(when, timeZone, from);
  for (let i = 0; previous !== undefined && i < 48; i++) {
    const next = nextRunAt(when, timeZone, previous);
    if (next === undefined) break;
    shortest = Math.min(shortest, next - previous);
    previous = next;
  }
  return shortest;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "Mon 27 Oct, 08:30" in the schedule's time zone. */
export function formatRunTime(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

// ─── Parsing helpers ─────────────────────────────────────────────────────────

function parseTime(token: string): { hour: number; minute: number } | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(token);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.toLowerCase();
  if (!m[2] && !meridiem) return undefined;
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

function parseDays(token: string): { cron: string; label: string } | undefined {
  if (token === 'daily' || token === 'everyday') return { cron: '*', label: 'daily' };
  if (token === 'weekdays') return { cron: '1-5', label: 'weekdays' };
  if (token === 'weekends') return { cron: '0,6', label: 'weekends' };
  const days = new Set<number>();
  for (const part of token.split(',')) {
    const [from, to] = part.split('-');
    const a = dayIndex(from);
    const b = to === undefined ? a : dayIndex(to);
    if (a === undefined || b === undefined) return undefined;
    for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  const sorted = [...days].sort((x, y) => x - y);
  return { cron: sorted.join(','), label: sorted.map((d) => DAY_NAMES[d]).join(',') };
}

function dayIndex(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const i = DAY_NAMES.indexOf(name.slice(0, 3).toLowerCase());
  if (i < 0) return undefined;
  // Accept "mon", "monday", "tues" — but not arbitrary words starting with a day.
  const full = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][i]!;
  return full.startsWith(name.toLowerCase()) ? i : undefined;
}

interface Cron {
  minutes: number[];
  hours: number[];
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function validateCron(expr: string): string | undefined {
  return parseCron(expr) ? undefined : `"${expr}" isn't a valid cron expression (minute hour day month weekday).`;
}

function parseCron(expr: string): Cron | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const minutes = parseField(fields[0]!, 0, 59);
  const hours = parseField(fields[1]!, 0, 23);
  const dom = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12);
  const dow = parseField(fields[4]!, 0, 7, DAY_NAMES);
  if (!minutes || !hours || !dom || !month || !dow) return undefined;
  // 7 is Sunday too.
  const dayOfWeek = new Set(dow.map((d) => d % 7));
  return {
    minutes,
    hours,
    dayOfMonth: new Set(dom),
    month: new Set(month),
    dayOfWeek,
    domAny: fields[2] === '*',
    dowAny: fields[4] === '*',
  };
}

function parseField(field: string, min: number, max: number, names?: string[]): number[] | undefined {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else {
      const [a, b] = range!.split('-');
      const start = fieldValue(a, names);
      const end = b === undefined ? (stepText === undefined ? start : max) : fieldValue(b, names);
      if (start === undefined || end === undefined) return undefined;
      from = start;
      to = end;
    }
    if (from < min || to > max || from > to) return undefined;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((x, y) => x - y);
}

function fieldValue(text: string | undefined, names?: string[]): number | undefined {
  if (text === undefined || text === '') return undefined;
  if (/^\d+$/.test(text)) return Number(text);
  const i = names?.indexOf(text.toLowerCase()) ?? -1;
  return i >= 0 ? i : undefined;
}

/** Standard cron: when both day fields are restricted, either may match. */
function dayMatches(cron: Cron, date: number, weekday: number): boolean {
  if (cron.domAny) return cron.dayOfWeek.has(weekday);
  if (cron.dowAny) return cron.dayOfMonth.has(date);
  return cron.dayOfMonth.has(date) || cron.dayOfWeek.has(weekday);
}

function validDate(text: string): boolean {
  const [y, m, d] = text.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m! - 1 && t.getUTCDate() === d;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// ─── Time zones ──────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedParts(at: number, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(at)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}

/** Offset of `timeZone` from UTC at instant `at`, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(at / 60_000) * 60_000;
}

/** The UTC instant of a wall-clock time in `timeZone`. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  return second;
}
