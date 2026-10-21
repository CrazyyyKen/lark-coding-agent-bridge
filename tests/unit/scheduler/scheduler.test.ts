import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATCH_UP_MS, MAX_SCHEDULES_PER_USER, PROPOSAL_TTL_MS, Scheduler, type FireResult } from '../../../src/scheduler/scheduler';
import { parseScheduleArgs, type ParsedSchedule } from '../../../src/scheduler/spec';
import { ScheduleStore, type Schedule } from '../../../src/scheduler/store';

const KL = 'Asia/Kuala_Lumpur';
// Wednesday 2026-10-21 09:00 in Kuala Lumpur.
const START = Date.UTC(2026, 9, 21, 1, 0);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function parsed(args: string): ParsedSchedule {
  const result = parseScheduleArgs(args);
  if ('error' in result) throw new Error(result.error);
  return result;
}

async function harness(fireResult: FireResult = 'ran') {
  const root = await mkdtemp(join(tmpdir(), 'scheduler-'));
  roots.push(root);
  const path = join(root, 'schedules.json');
  const store = new ScheduleStore(path);
  let now = START;
  const fired: Schedule[] = [];
  const missed: Array<{ schedule: Schedule; dueAt: number }> = [];
  const scheduler = new Scheduler({
    store,
    timeZone: KL,
    now: () => now,
    fire: vi.fn(async (s: Schedule) => {
      fired.push(s);
      return fireResult;
    }),
    notifyMissed: async (schedule, dueAt) => {
      missed.push({ schedule, dueAt });
    },
  });
  const add = (args: string, ownerId = 'ou_alice', chatId = 'oc_alice') => {
    const result = scheduler.add({ ...parsed(args), ownerId, chatId });
    if (!result.ok) throw new Error(result.error);
    return result.schedule;
  };
  return {
    path,
    store,
    scheduler,
    fired,
    missed,
    add,
    setNow: (t: number) => {
      now = t;
    },
  };
}

describe('Scheduler', () => {
  it('fires a due task once and moves it to the next weekday', async () => {
    const h = await harness();
    const s = h.add('weekdays 08:30 Triage my inbox');
    expect(new Date(s.nextRunAt!).toISOString()).toBe('2026-10-22T00:30:00.000Z');

    await h.scheduler.tick();
    expect(h.fired).toHaveLength(0);

    h.setNow(s.nextRunAt! + 10_000);
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(h.fired.map((f) => f.id)).toEqual([s.id]);
    const after = h.store.get(s.id)!;
    expect(after.lastResult).toBe('ran');
    expect(new Date(after.nextRunAt!).toISOString()).toBe('2026-10-23T00:30:00.000Z');
  });

  it('still runs a task that is a little late (bridge was briefly offline)', async () => {
    const h = await harness();
    const s = h.add('daily 10:00 x');
    h.setNow(s.nextRunAt! + CATCH_UP_MS - 1000);
    await h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.missed).toHaveLength(0);
  });

  it('skips and reports a task that is over an hour late, then carries on', async () => {
    const h = await harness();
    const s = h.add('daily 10:00 x');
    h.setNow(s.nextRunAt! + CATCH_UP_MS + 60_000);
    await h.scheduler.tick();
    expect(h.fired).toHaveLength(0);
    expect(h.missed.map((m) => m.dueAt)).toEqual([s.nextRunAt]);
    const after = h.store.get(s.id)!;
    expect(after.lastResult).toBe('missed');
    expect(after.nextRunAt).toBeGreaterThan(s.nextRunAt!);
  });

  it('records when the owner may no longer use the bot', async () => {
    const h = await harness('not-allowed');
    const s = h.add('daily 10:00 x');
    h.setNow(s.nextRunAt!);
    await h.scheduler.tick();
    expect(h.store.get(s.id)?.lastResult).toBe('not-allowed');
  });

  it('removes a one-off task after it runs', async () => {
    const h = await harness();
    const s = h.add('once 2026-10-21 12:00 x');
    h.setNow(s.nextRunAt!);
    await h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.store.get(s.id)).toBeUndefined();
  });

  it('does not fire paused tasks and recomputes the next run on resume', async () => {
    const h = await harness();
    const s = h.add('daily 10:00 x');
    h.scheduler.setEnabled('ou_alice', s.id, false);
    h.setNow(s.nextRunAt! + 1000);
    await h.scheduler.tick();
    expect(h.fired).toHaveLength(0);

    h.setNow(s.nextRunAt! + 2 * 86_400_000);
    const resumed = h.scheduler.setEnabled('ou_alice', s.id, true)!;
    expect(resumed.nextRunAt).toBe(s.nextRunAt! + 3 * 86_400_000);
  });

  it("never lets one person see, run, pause or remove another person's task", async () => {
    const h = await harness();
    const s = h.add('daily 10:00 x', 'ou_alice');
    expect(h.scheduler.listFor('ou_bob')).toEqual([]);
    expect(h.scheduler.getOwned('ou_bob', s.id)).toBeUndefined();
    expect(h.scheduler.remove('ou_bob', s.id)).toBe(false);
    expect(h.scheduler.setEnabled('ou_bob', s.id, false)).toBeUndefined();
    expect(await h.scheduler.runNow('ou_bob', s.id)).toBeUndefined();
    expect(h.fired).toHaveLength(0);
    expect(h.scheduler.remove('ou_alice', s.id.toUpperCase())).toBe(true);
  });

  it('runs a task now without changing its timetable', async () => {
    const h = await harness();
    const s = h.add('daily 10:00 x');
    expect(await h.scheduler.runNow('ou_alice', s.id)).toBe('ran');
    expect(h.fired).toHaveLength(1);
    expect(h.store.get(s.id)?.nextRunAt).toBe(s.nextRunAt);
  });

  it('refuses too-frequent, past, oversized and too many tasks', async () => {
    const h = await harness();
    const add = (args: string) => h.scheduler.add({ ...parsed(args), ownerId: 'ou_alice', chatId: 'oc' });
    expect(add('cron */5 * * * * x')).toMatchObject({ ok: false });
    expect(add('once 2026-10-20 09:00 x')).toMatchObject({ ok: false });
    expect(add(`daily 10:00 ${'y'.repeat(2001)}`)).toMatchObject({ ok: false });
    for (let i = 0; i < MAX_SCHEDULES_PER_USER; i++) expect(add(`daily 10:00 task ${i}`).ok).toBe(true);
    expect(add('daily 11:00 one more')).toMatchObject({ ok: false });
    // The limit is per person.
    expect(h.scheduler.add({ ...parsed('daily 10:00 x'), ownerId: 'ou_bob', chatId: 'oc_b' }).ok).toBe(true);
  });

  it('persists tasks and reloads them', async () => {
    const h = await harness();
    const s = h.add('weekdays 08:30 Triage');
    await h.scheduler.flush();
    const saved = JSON.parse(await readFile(h.path, 'utf8')) as { schedules: Schedule[] };
    expect(saved.schedules.map((x) => x.id)).toEqual([s.id]);
    const reloaded = new ScheduleStore(h.path);
    await reloaded.load();
    expect(reloaded.get(s.id)).toMatchObject({ ownerId: 'ou_alice', prompt: 'Triage', timeZone: KL });
  });

  it('keeps going when one task fails to start', async () => {
    const h = await harness('failed');
    const s = h.add('daily 10:00 x');
    h.setNow(s.nextRunAt!);
    await h.scheduler.tick();
    expect(h.store.get(s.id)?.lastResult).toBe('failed');
    expect(h.store.get(s.id)?.nextRunAt).toBeGreaterThan(s.nextRunAt!);
  });
  it("creates a suggested task only when its requester confirms, and only once", async () => {
    const h = await harness();
    const proposed = h.scheduler.propose({ ...parsed("weekdays 08:30 Triage"), ownerId: "ou_alice", chatId: "oc_alice" });
    if (!proposed.ok) throw new Error(proposed.error);
    expect(h.scheduler.listFor("ou_alice")).toEqual([]);

    expect(h.scheduler.confirm("ou_bob", proposed.proposal.id)).toMatchObject({ ok: false });
    const confirmed = h.scheduler.confirm("ou_alice", proposed.proposal.id);
    expect(confirmed).toMatchObject({ ok: true, schedule: { ownerId: "ou_alice", prompt: "Triage" } });
    expect(h.scheduler.listFor("ou_alice")).toHaveLength(1);
    // A second tap does not create a duplicate.
    expect(h.scheduler.confirm("ou_alice", proposed.proposal.id)).toMatchObject({ ok: false });
    expect(h.scheduler.listFor("ou_alice")).toHaveLength(1);
  });

  it("drops dismissed and expired suggestions, and refuses ones add would refuse", async () => {
    const h = await harness();
    const input = { ...parsed("daily 10:00 x"), ownerId: "ou_alice", chatId: "oc_alice" };
    const a = h.scheduler.propose(input);
    const b = h.scheduler.propose(input);
    if (!a.ok || !b.ok) throw new Error("propose failed");
    expect(h.scheduler.dismiss("ou_bob", a.proposal.id)).toBe(false);
    expect(h.scheduler.dismiss("ou_alice", a.proposal.id)).toBe(true);
    expect(h.scheduler.confirm("ou_alice", a.proposal.id)).toMatchObject({ ok: false });

    h.setNow(START + PROPOSAL_TTL_MS + 60_000);
    expect(h.scheduler.confirm("ou_alice", b.proposal.id)).toMatchObject({ ok: false });

    expect(h.scheduler.propose({ ...parsed("cron */5 * * * * x"), ownerId: "ou_alice", chatId: "oc" })).toMatchObject({ ok: false });
  });
});
