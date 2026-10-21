import { log } from '../core/logger';
import {
  scheduleListCard,
  scheduleResultCard,
  scheduleRunCard,
  type ScheduleCardEntry,
} from '../card/templates';
import type { Scheduler } from '../scheduler/scheduler';
import { formatRunTime, parseScheduleArgs, WHEN_HELP } from '../scheduler/spec';
import type { Schedule } from '../scheduler/store';
import type { CommandContext } from './index';

/**
 * /schedule — scheduled tasks. Open to everyone who may DM the bot: a task
 * always belongs to its sender and runs in their DM as them, so nobody can
 * schedule, see or remove anyone else's.
 *
 * Card buttons arrive here too (`schedule.run` → `/schedule run <id>`), with
 * the clicker as sender and `fromCardAction` set; list-card buttons update
 * that card in place instead of replying.
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
  const id = rest[0];

  switch (sub.toLowerCase()) {
    case '':
    case 'help':
      return send(ctx, usage(scheduler));
    case 'add':
    case 'new':
      return add(ctx, scheduler, restText);
    case 'list':
    case 'ls':
      return sendCard(ctx, listCard(scheduler, ownerId));
    case 'confirm': {
      if (!id) return;
      const result = scheduler.confirm(ownerId, id);
      if (!result.ok) return answerCard(ctx, scheduleResultCard('📅 Scheduled task', result.error));
      const s = result.schedule;
      return answerCard(
        ctx,
        scheduleResultCard(
          '✅ Scheduled',
          `\`${s.id}\` · **${s.label}** (${s.timeZone})\n> ${s.prompt}\n${nextLine(s)}\n\n` +
            `Try it now: \`/schedule run ${s.id}\` · manage: \`/schedule list\``,
        ),
      );
    }
    case 'dismiss': {
      if (!id || !scheduler.dismiss(ownerId, id)) return;
      return answerCard(ctx, scheduleResultCard('📅 Not scheduled', 'OK — nothing was scheduled.'));
    }
    case 'remove':
    case 'delete':
    case 'rm': {
      if (!id) return send(ctx, 'Which one? `/schedule remove <id>` — see `/schedule list`.');
      const removed = scheduler.remove(ownerId, id);
      if (ctx.fromCardAction) return refreshListCard(ctx, scheduler);
      return send(ctx, removed ? `Removed \`${id}\`.` : notFound(id));
    }
    case 'pause':
    case 'resume': {
      if (!id) return send(ctx, `Which one? \`/schedule ${sub} <id>\` — see \`/schedule list\`.`);
      const enabled = sub.toLowerCase() === 'resume';
      const updated = scheduler.setEnabled(ownerId, id, enabled);
      // From the card posted when the task ran: redraw that card, not the list.
      if (ctx.fromCardAction && rest[1] === 'run-card') {
        if (!updated) return;
        return answerCard(
          ctx,
          scheduleRunCard({ id: updated.id, label: updated.label, prompt: updated.prompt, paused: !enabled }),
        );
      }
      if (ctx.fromCardAction) return refreshListCard(ctx, scheduler);
      if (!updated) return send(ctx, notFound(id));
      return send(
        ctx,
        enabled
          ? `Resumed \`${updated.id}\`. ${nextLine(updated)}`
          : `Paused \`${updated.id}\`. Send \`/schedule resume ${updated.id}\` to turn it back on.`,
      );
    }
    case 'run': {
      if (!id) return send(ctx, 'Which one? `/schedule run <id>` — see `/schedule list`.');
      const schedule = scheduler.getOwned(ownerId, id);
      if (!schedule) return send(ctx, notFound(id));
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
    '- `/schedule list` — your tasks, with buttons to run, pause or remove them',
    '- `/schedule run <id>` — run one now',
    '- `/schedule pause <id>` · `/schedule resume <id>` · `/schedule remove <id>`',
    '',
    `When: ${WHEN_HELP}. Times are ${scheduler.timeZone}.`,
    '',
    'Or just ask me ("every weekday at 8:30, summarize my inbox") and tap **Create schedule**.',
  ].join('\n');
}

function listCard(scheduler: Scheduler, ownerId: string): object {
  const entries: ScheduleCardEntry[] = scheduler.listFor(ownerId).map((s) => ({
    id: s.id,
    label: s.label,
    timeZone: s.timeZone,
    prompt: truncate(s.prompt, 200),
    enabled: s.enabled,
    ...(s.nextRunAt !== undefined ? { nextRun: formatRunTime(s.nextRunAt, s.timeZone) } : {}),
    ...(s.lastRunAt !== undefined
      ? { lastRun: `${formatRunTime(s.lastRunAt, s.timeZone)} (${s.lastResult ?? 'ran'})` }
      : {}),
  }));
  return scheduleListCard(entries, scheduler.timeZone);
}

/** After a list-card button: redraw that card with the new state. */
async function refreshListCard(ctx: CommandContext, scheduler: Scheduler): Promise<void> {
  await answerCard(ctx, listCard(scheduler, ctx.msg.senderId));
}

/**
 * Show `card` in place of the card whose button was pressed; for a typed
 * command (or if the update fails) send it as a reply instead.
 */
async function answerCard(ctx: CommandContext, card: object): Promise<void> {
  if (ctx.fromCardAction) {
    try {
      await ctx.channel.updateCard(ctx.msg.messageId, card);
      return;
    } catch (err) {
      log.warn('command', 'schedule-card-update-failed', { err: String(err) });
    }
  }
  await sendCard(ctx, card);
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

async function sendCard(ctx: CommandContext, card: object): Promise<void> {
  try {
    await ctx.channel.send(ctx.msg.chatId, { card }, { replyTo: ctx.msg.messageId });
  } catch (err) {
    log.fail('command', err, { step: 'schedule-card' });
  }
}
