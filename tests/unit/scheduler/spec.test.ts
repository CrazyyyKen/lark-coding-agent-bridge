import { describe, expect, it } from 'vitest';
import {
  findScheduleSuggestions,
  nextRunAt,
  parseScheduleArgs,
  shortestInterval,
  zonedToUtc,
  type ParsedSchedule,
} from '../../../src/scheduler/spec';

const KL = 'Asia/Kuala_Lumpur';
// Wednesday 2026-10-21 09:00 in Kuala Lumpur (UTC+8).
const WED_0900_KL = Date.UTC(2026, 9, 21, 1, 0);

function parsed(args: string): ParsedSchedule {
  const result = parseScheduleArgs(args);
  if ('error' in result) throw new Error(result.error);
  return result;
}

function klTime(at: number | undefined): string {
  if (at === undefined) return 'none';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: KL,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

describe('parseScheduleArgs', () => {
  it('reads the friendly forms into cron and keeps the rest as the prompt', () => {
    expect(parsed('weekdays 08:30 Triage my inbox')).toEqual({
      when: { kind: 'cron', expr: '30 8 * * 1-5' },
      label: 'weekdays 08:30',
      prompt: 'Triage my inbox',
    });
    expect(parsed('daily 9:05pm Check the dashboard').when).toEqual({ kind: 'cron', expr: '5 21 * * *' });
    expect(parsed('weekends 10:00 x').when).toEqual({ kind: 'cron', expr: '0 10 * * 0,6' });
    expect(parsed('mon,wed,fri 17:00 x')).toMatchObject({
      when: { kind: 'cron', expr: '0 17 * * 1,3,5' },
      label: 'mon,wed,fri 17:00',
    });
    expect(parsed('mon-thu 5pm x').when).toEqual({ kind: 'cron', expr: '0 17 * * 1,2,3,4' });
    expect(parsed('Friday 12am x').when).toEqual({ kind: 'cron', expr: '0 0 * * 5' });
    expect(parsed('cron 30 8 * * 1-5 Triage').when).toEqual({ kind: 'cron', expr: '30 8 * * 1-5' });
    expect(parsed('once 2026-12-24 09:00 Wrap presents')).toEqual({
      when: { kind: 'once', at: '2026-12-24T09:00' },
      label: 'once 2026-12-24 09:00',
      prompt: 'Wrap presents',
    });
  });

  it('explains what is wrong instead of guessing', () => {
    expect(parseScheduleArgs('')).toHaveProperty('error');
    expect(parseScheduleArgs('weekdays Triage')).toHaveProperty('error');
    expect(parseScheduleArgs('weekdays 8 Triage')).toHaveProperty('error'); // bare hour is ambiguous
    expect(parseScheduleArgs('weekdays 25:00 Triage')).toHaveProperty('error');
    expect(parseScheduleArgs('weekdays 08:30')).toHaveProperty('error'); // no task
    expect(parseScheduleArgs('tomorrow 08:30 x')).toHaveProperty('error');
    expect(parseScheduleArgs('monkey 08:30 x')).toHaveProperty('error');
    expect(parseScheduleArgs('cron 61 8 * * * x')).toHaveProperty('error');
    expect(parseScheduleArgs('cron 30 8 * x')).toHaveProperty('error');
    expect(parseScheduleArgs('once 2026-02-30 09:00 x')).toHaveProperty('error');
    expect(parseScheduleArgs('once 2026-12-24 x')).toHaveProperty('error');
  });
});

describe('nextRunAt', () => {
  it('skips the weekend for a weekday schedule, in the schedule time zone', () => {
    const when = parsed('weekdays 08:30 x').when;
    // Wednesday 09:00 → Thursday 08:30.
    const thu = nextRunAt(when, KL, WED_0900_KL);
    expect(klTime(thu)).toBe('Thu, 22/10/2026, 08:30');
    // Friday 09:00 → Monday 08:30, never Saturday or Sunday.
    const fri0900 = WED_0900_KL + 2 * 86_400_000;
    expect(klTime(nextRunAt(when, KL, fri0900))).toBe('Mon, 26/10/2026, 08:30');
  });

  it('includes a later time the same day and is strictly after `after`', () => {
    const when = parsed('daily 09:00 x').when;
    expect(klTime(nextRunAt(when, KL, WED_0900_KL - 60_000))).toBe('Wed, 21/10/2026, 09:00');
    expect(klTime(nextRunAt(when, KL, WED_0900_KL))).toBe('Thu, 22/10/2026, 09:00');
  });

  it('treats 08:30 in Kuala Lumpur as 00:30 UTC on the same day', () => {
    const monday = nextRunAt(parsed('mon 08:30 x').when, KL, WED_0900_KL)!;
    expect(new Date(monday).toISOString()).toBe('2026-10-26T00:30:00.000Z');
  });

  it('follows daylight saving changes', () => {
    const ny = 'America/New_York';
    // New York leaves DST on 2026-11-01; 09:00 is 13:00Z before and 14:00Z after.
    const before = nextRunAt(parsed('daily 09:00 x').when, ny, Date.UTC(2026, 9, 31, 12, 0))!;
    const after = nextRunAt(parsed('daily 09:00 x').when, ny, before)!;
    expect(new Date(before).toISOString()).toBe('2026-10-31T13:00:00.000Z');
    expect(new Date(after).toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  it('ORs day-of-month and day-of-week when both are restricted, like cron', () => {
    // 1st of the month or any Monday, at 07:00.
    const when = { kind: 'cron' as const, expr: '0 7 1 * 1' };
    expect(klTime(nextRunAt(when, KL, WED_0900_KL))).toBe('Mon, 26/10/2026, 07:00');
    const tue27 = Date.UTC(2026, 9, 27, 0, 0);
    expect(klTime(nextRunAt(when, KL, tue27))).toBe('Sun, 01/11/2026, 07:00');
  });

  it('runs a one-off once and never again', () => {
    const when = parsed('once 2026-10-22 10:00 x').when;
    const at = nextRunAt(when, KL, WED_0900_KL);
    expect(at).toBe(zonedToUtc(2026, 10, 22, 10, 0, KL));
    expect(nextRunAt(when, KL, at!)).toBeUndefined();
  });
});

describe('shortestInterval', () => {
  it('measures how often a recurring schedule runs', () => {
    expect(shortestInterval(parsed('daily 08:30 x').when, KL, WED_0900_KL)).toBe(86_400_000);
    expect(shortestInterval({ kind: 'cron', expr: '*/5 9 * * *' }, KL, WED_0900_KL)).toBe(5 * 60_000);
    expect(shortestInterval(parsed('once 2026-12-24 09:00 x').when, KL, WED_0900_KL)).toBe(Infinity);
  });
});

describe('findScheduleSuggestions', () => {
  it('finds /schedule add lines in code blocks, inline code and lists', () => {
    const reply = [
      'Sure — tap the card below, or send:',
      '```',
      '/schedule add weekdays 08:30 Triage my unread inbox, draft replies',
      '```',
      '- `/schedule add daily 17:00 Remind me to log my work`',
      '> /schedule add once 2026-12-24 09:00 Wrap presents',
      'You can also type /schedule add mid-sentence, which is ignored.',
    ].join('\n');
    expect(findScheduleSuggestions(reply)).toEqual([
      'weekdays 08:30 Triage my unread inbox, draft replies',
      'daily 17:00 Remind me to log my work',
      'once 2026-12-24 09:00 Wrap presents',
    ]);
  });

  it('dedupes and stops at three', () => {
    const lines = ['a', 'a', 'b', 'c', 'd'].map((x) => `/schedule add daily 09:00 ${x}`).join('\n');
    expect(findScheduleSuggestions(lines)).toEqual([
      'daily 09:00 a',
      'daily 09:00 b',
      'daily 09:00 c',
    ]);
  });
});
