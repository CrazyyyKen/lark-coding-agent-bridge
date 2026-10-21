import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { ScheduleWhen } from './spec';

export interface Schedule {
  /** Short id the user types: `/schedule remove s3k9`. */
  id: string;
  /** open_id of the person who created it; the run acts for them. */
  ownerId: string;
  ownerName?: string;
  /** Their DM with the bot, where the task runs and replies. */
  chatId: string;
  prompt: string;
  label: string;
  when: ScheduleWhen;
  timeZone: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastResult?: 'ran' | 'missed' | 'not-allowed' | 'failed';
}

interface ScheduleData {
  schedules: Schedule[];
}

export class ScheduleStore {
  private data: ScheduleData = { schedules: [] };
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(text) as Partial<ScheduleData>;
      this.data = { schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [] };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  list(): Schedule[] {
    return this.data.schedules.map((s) => ({ ...s }));
  }

  listFor(ownerId: string): Schedule[] {
    return this.list().filter((s) => s.ownerId === ownerId);
  }

  get(id: string): Schedule | undefined {
    const found = this.data.schedules.find((s) => s.id === id);
    return found ? { ...found } : undefined;
  }

  add(schedule: Schedule): void {
    this.data.schedules.push({ ...schedule });
    this.schedulePersist();
  }

  update(id: string, patch: Partial<Omit<Schedule, 'id' | 'ownerId'>>): Schedule | undefined {
    const index = this.data.schedules.findIndex((s) => s.id === id);
    if (index < 0) return undefined;
    const updated = { ...this.data.schedules[index]!, ...patch };
    this.data.schedules[index] = updated;
    this.schedulePersist();
    return { ...updated };
  }

  remove(id: string): boolean {
    const before = this.data.schedules.length;
    this.data.schedules = this.data.schedules.filter((s) => s.id !== id);
    if (this.data.schedules.length === before) return false;
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
          mode: 0o600,
        });
      })
      .catch((err: unknown) => {
        log.fail('scheduler', err, { step: 'persist' });
      });
  }
}
