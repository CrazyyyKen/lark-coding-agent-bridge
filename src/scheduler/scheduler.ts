import { randomBytes } from 'node:crypto';
import { log } from '../core/logger';
import { MIN_INTERVAL_MS, nextRunAt, shortestInterval, type ParsedSchedule } from './spec';
import type { Schedule, ScheduleStore } from './store';

/** Most schedules one person may have on a bot. */
export const MAX_SCHEDULES_PER_USER = 10;
/** Longest task prompt a schedule may hold. */
export const MAX_PROMPT_CHARS = 2000;
/** A run that was due while the bridge was offline still runs if it's at most this late. */
export const CATCH_UP_MS = 60 * 60 * 1000;

const TICK_MS = 30_000;

export type FireResult = 'ran' | 'not-allowed' | 'failed';

export interface SchedulerOptions {
  store: ScheduleStore;
  /** Start the task: post it to the owner's DM and queue the run. */
  fire: (schedule: Schedule) => Promise<FireResult>;
  /** Tell the owner a run was skipped because the bridge was offline too long. */
  notifyMissed?: (schedule: Schedule, dueAt: number) => Promise<void>;
  timeZone: string;
  now?: () => number;
  tickMs?: number;
}

export type AddResult = { ok: true; schedule: Schedule } | { ok: false; error: string };

/**
 * Bridge-side scheduled tasks. The agent process exits after every reply, so
 * nothing inside it can keep a timer; the bridge stays up and, when a task is
 * due, feeds its prompt into the owner's DM as if they had sent it — the run
 * goes through the same access checks, per-person login and session.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get timeZone(): string {
    return this.opts.timeZone;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  listFor(ownerId: string): Schedule[] {
    return this.opts.store.listFor(ownerId).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The owner's schedule with this id; never someone else's. */
  getOwned(ownerId: string, id: string): Schedule | undefined {
    const schedule = this.opts.store.get(id.trim().toLowerCase());
    return schedule?.ownerId === ownerId ? schedule : undefined;
  }

  add(input: ParsedSchedule & { ownerId: string; ownerName?: string; chatId: string }): AddResult {
    if (input.prompt.length > MAX_PROMPT_CHARS) {
      return { ok: false, error: `That task is too long (max ${MAX_PROMPT_CHARS} characters).` };
    }
    if (this.opts.store.listFor(input.ownerId).length >= MAX_SCHEDULES_PER_USER) {
      return {
        ok: false,
        error: `You already have ${MAX_SCHEDULES_PER_USER} scheduled tasks. Remove one first (\`/schedule list\`).`,
      };
    }
    const now = this.now();
    const next = nextRunAt(input.when, this.opts.timeZone, now);
    if (next === undefined) {
      return { ok: false, error: 'That time never comes up again — is the date in the past?' };
    }
    if (shortestInterval(input.when, this.opts.timeZone, now) < MIN_INTERVAL_MS) {
      return { ok: false, error: 'Scheduled tasks can run at most once every 15 minutes.' };
    }
    const schedule: Schedule = {
      id: this.newId(),
      ownerId: input.ownerId,
      ...(input.ownerName ? { ownerName: input.ownerName } : {}),
      chatId: input.chatId,
      prompt: input.prompt,
      label: input.label,
      when: input.when,
      timeZone: this.opts.timeZone,
      enabled: true,
      createdAt: now,
      nextRunAt: next,
    };
    this.opts.store.add(schedule);
    log.info('scheduler', 'added', { id: schedule.id, owner: schedule.ownerId.slice(-6), label: schedule.label });
    return { ok: true, schedule };
  }

  remove(ownerId: string, id: string): boolean {
    const schedule = this.getOwned(ownerId, id);
    if (!schedule) return false;
    log.info('scheduler', 'removed', { id: schedule.id, owner: ownerId.slice(-6) });
    return this.opts.store.remove(schedule.id);
  }

  setEnabled(ownerId: string, id: string, enabled: boolean): Schedule | undefined {
    const schedule = this.getOwned(ownerId, id);
    if (!schedule) return undefined;
    const next = enabled ? nextRunAt(schedule.when, schedule.timeZone, this.now()) : schedule.nextRunAt;
    return this.opts.store.update(schedule.id, {
      enabled,
      ...(next !== undefined ? { nextRunAt: next } : {}),
    });
  }

  /** Run a task now (`/schedule run`), leaving its timetable unchanged. */
  async runNow(ownerId: string, id: string): Promise<FireResult | undefined> {
    const schedule = this.getOwned(ownerId, id);
    if (!schedule) return undefined;
    return this.fire(schedule);
  }

  /** Fire everything that is due. Public for tests; the timer calls it. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const schedule of this.opts.store.list()) {
        if (!schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue;
        const dueAt = schedule.nextRunAt;
        let result: Schedule['lastResult'];
        if (now - dueAt <= CATCH_UP_MS) {
          result = await this.fire(schedule);
        } else {
          result = 'missed';
          log.warn('scheduler', 'missed', { id: schedule.id, dueAt: new Date(dueAt).toISOString() });
          await this.opts.notifyMissed?.(schedule, dueAt).catch((err) =>
            log.warn('scheduler', 'notify-missed-failed', { id: schedule.id, err: String(err) }),
          );
        }
        const next = nextRunAt(schedule.when, schedule.timeZone, now);
        if (schedule.when.kind === 'once') {
          this.opts.store.remove(schedule.id);
        } else {
          this.opts.store.update(schedule.id, {
            lastRunAt: now,
            lastResult: result,
            ...(next !== undefined ? { nextRunAt: next } : { enabled: false }),
          });
        }
      }
    } catch (err) {
      log.fail('scheduler', err, { step: 'tick' });
    } finally {
      this.ticking = false;
    }
  }

  async flush(): Promise<void> {
    await this.opts.store.flush();
  }

  private async fire(schedule: Schedule): Promise<FireResult> {
    log.info('scheduler', 'fire', { id: schedule.id, owner: schedule.ownerId.slice(-6) });
    try {
      return await this.opts.fire(schedule);
    } catch (err) {
      log.fail('scheduler', err, { step: 'fire', id: schedule.id });
      return 'failed';
    }
  }

  private newId(): string {
    for (;;) {
      const id = `s${randomBytes(3).toString('hex').slice(0, 4)}`;
      if (!this.opts.store.get(id)) return id;
    }
  }
}
