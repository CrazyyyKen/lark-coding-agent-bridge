import { log } from '../core/logger';
import type { Scheduler } from '../scheduler/scheduler';
import { formatRunTime, parseScheduleArgs, WHEN_HELP } from '../scheduler/spec';
import type { Schedule } from '../scheduler/store';
import type { CommandContext } from './index';

/**
 * /schedule — scheduled tasks. Open to everyone who may DM the bot: a task
 * always belongs to its sender and runs in their DM as them, so nobody can
 * schedule, see or remove anyone else's.
 */

const NOT_AVAILABLE = "Scheduled tasks aren't available on this bot.";
const DM_ONLY = 'Please set up scheduled tasks in a private chat with me — they run as you, in that chat.';

export async function handleSchedule(args: string, ctx: CommandContext): Promise<void> {
  const scheduler = ctx.controls.scheduler;
  if (!scheduler) return send(ctx, NOT_AVAILABLE);
  if (ctx.chatMode !== 'p2p') return send(ctx, DM_ONLY);
  const ownerId = ctx.msg.senderId;
  const [sub = '', ...rest] = args.trim().split(/\s+/);
  const restText = rest.join(' ');

  switch (sub.toLowerCase()) {
    case '':
    case 'help':
      return send(ctx, usage(scheduler));
    case 'add':
    case 'new':
      return add(ctx, scheduler, restText);
    case 'list':
    case 'ls':
      return send(ctx, listText(scheduler.listFor(ownerId)));
    case 'remove':
    case 'delete':
    case 'rm': {
      if (!rest[0]) return send(ctx, 'Which one? `/schedule remove <id>` — see `/schedule list`.');
      const removed = scheduler.remove(ownerId, rest[0]);
      return send(ctx, removed ? `Removed \`${rest[0]}\`.` : notFound(rest[0]));
    }
    case 'pause':
    case 'resume': {
      if (!rest[0]) return send(ctx, `Which one? \`/schedule ${sub} <id>\` — see \`/schedule list\`.`);
      const enabled = sub.toLowerCase() === 'resume';
      const updated = scheduler.setEnabled(ownerId, rest[0], enabled);
      if (!updated) return send(ctx, notFound(rest[0]));
      return send(
        ctx,
        enabled
          ? `Resumed \`${updated.id}\`. ${nextLine(updated)}`
          : `Paused \`${updated.id}\`. Send \`/schedule resume ${updated.id}\` to turn it back on.`,
      );
    }
    case 'run': {
      if (!rest[0]) return send(ctx, 'Which one? `/schedule run <id>` — see `/schedule list`.');
      const schedule = scheduler.getOwned(ownerId, rest[0]);
      if (!schedule) return send(ctx, notFound(rest[0]));
      // Once a command returns, the bridge drops the chat's queued messages;
      // start the task after that, or it would be dropped along with them.
      setTimeout(() => {
        void scheduler.runNow(ownerId, schedule.id).then((result) => {
          if (result !== 'ran') {
            return send(ctx, "Sorry — I couldn't start that task. Please try again in a minute.");
          }
        });
      }, 0);
      return;
    }
    default:
      return send(ctx, usage(scheduler));
  }
}

async function add(ctx: CommandContext, scheduler: Scheduler, text: string): Promise<void> {
  const parsed = parseScheduleArgs(text);
  if ('error' in parsed) return send(ctx, parsed.error);
  const result = scheduler.add({
    ...parsed,
    ownerId: ctx.msg.senderId,
    ...(ctx.msg.senderName ? { ownerName: ctx.msg.senderName } : {}),
    chatId: ctx.msg.chatId,
  });
  if (!result.ok) return send(ctx, result.error);
  const s = result.schedule;
  await send(
    ctx,
    [
      `Scheduled \`${s.id}\` · **${s.label}** (${s.timeZone})`,
      `> ${s.prompt}`,
      nextLine(s),
      '',
      "I'll post the task here when it's due and work on it, as if you had sent it. " +
        'I only run while the bot is online; if it was offline for over an hour at that time, ' +
        "I'll tell you instead of running late.",
      `Manage: \`/schedule list\` · \`/schedule run ${s.id}\` (try it now) · \`/schedule remove ${s.id}\``,
    ].join('\n'),
  );
}

function usage(scheduler: Scheduler): string {
  return [
    '**Scheduled tasks**',
    '- `/schedule add <when> <task>` — e.g. `/schedule add weekdays 08:30 Triage my unread inbox and draft replies, don\'t send`',
    '- `/schedule list` — your tasks',
    '- `/schedule run <id>` — run one now',
    '- `/schedule pause <id>` · `/schedule resume <id>` · `/schedule remove <id>`',
    '',
    `When: ${WHEN_HELP}. Times are ${scheduler.timeZone}.`,
  ].join('\n');
}

function listText(schedules: Schedule[]): string {
  if (schedules.length === 0) {
    return 'You have no scheduled tasks. Add one with `/schedule add weekdays 08:30 <task>`.';
  }
  const lines = ['**Your scheduled tasks**'];
  for (const s of schedules) {
    const state = s.enabled ? nextLine(s) : 'Paused.';
    const last = s.lastRunAt
      ? ` Last: ${formatRunTime(s.lastRunAt, s.timeZone)} (${s.lastResult ?? 'ran'}).`
      : '';
    lines.push(`- \`${s.id}\` · **${s.label}** — ${truncate(s.prompt, 120)}\n  ${state}${last}`);
  }
  return lines.join('\n');
}

function nextLine(s: Schedule): string {
  return s.nextRunAt !== undefined ? `Next run: ${formatRunTime(s.nextRunAt, s.timeZone)}.` : 'No upcoming run.';
}

function notFound(id: string): string {
  return `You have no scheduled task \`${id}\`. See \`/schedule list\`.`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function send(ctx: CommandContext, markdown: string): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { markdown }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'schedule-reply' });
  }
}
