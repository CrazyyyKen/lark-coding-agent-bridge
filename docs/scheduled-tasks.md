# Scheduled tasks (`/schedule`)

People can ask their bot to do something on a timetable, such as "every weekday at 08:30, triage my unread inbox and draft replies". This works the same on a laptop and in a server container.

## Why the bridge does it, not the agent

Each Lark message starts a fresh `claude -p` run that exits after the reply. Nothing inside that run can keep a timer:

| What the agent might try | Why it fails here |
|---|---|
| Claude Code `CronCreate` | Lives only while that run's process lives (seconds). The bridge now passes `--disallowedTools CronCreate,CronDelete,CronList`. |
| `crontab`, systemd timers | Not in the container (read-only filesystem, no cron daemon). On a laptop or dedicated host, a cron job running `claude` skips the bridge: no per-person login, no access check, and the reply has to be sent by hand. |
| Windows Task Scheduler | Works only on that laptop, with full access, and only for fixed messages unless it starts `claude` outside the bridge. |
| Cloud routine (`/schedule` skill, `RemoteTrigger`) | Runs on Anthropic's servers with no `lark-cli` login. |

The bridge process stays up, so it keeps the timetable. When a task is due it posts `⏰ Scheduled task …` in the owner's DM and feeds the task in as a message from them. The run then takes the normal path: access check, the person's own Lark login (team mode with `perUserLogin`), the DM's session (so "send draft 2" afterwards has context), and normal reply rendering.

## Commands (DM only)

| Command | Does |
|---|---|
| `/schedule add <when> <task>` | Create. `<when>`: `daily 08:30`, `weekdays 8:30am`, `weekends 10:00`, `mon,wed,fri 17:00`, `mon-thu 5pm`, `once 2026-12-24 09:00`, `cron 30 8 * * 1-5` |
| `/schedule list` | Your tasks, next run, last result |
| `/schedule run <id>` | Run now; the timetable is unchanged |
| `/schedule pause <id>` / `resume <id>` | Turn off / on (resume recomputes the next run) |
| `/schedule remove <id>` | Delete |

When someone asks the agent for a recurring task, the system prompt tells it to reply with the exact `/schedule add …` line for them to send. Sending it is the confirmation.

## Rules

- A task belongs to whoever created it. Nobody can see, run, pause or remove someone else's, admins included.
- Access is checked again at every run. If the person can no longer use the bot, the run is skipped and recorded as `not-allowed`.
- At most 10 tasks per person, at most one run every 15 minutes, a task is at most 2,000 characters.
- Times are wall-clock in the bridge's time zone: the host's (`TZ=Asia/Kuala_Lumpur` in the containers) unless `LARK_CHANNEL_TIMEZONE` is set. Each task keeps the zone it was created in.
- **Offline:** a run that was due while the bridge was down still happens if the bridge is back within an hour. Later than that, the bot tells the person it skipped the run and offers `/schedule run <id>`. A laptop bridge that is shut down doesn't run tasks.
- One-off (`once`) tasks are deleted after they run.

## Where things are

- Tasks: `~/.lark-channel/profiles/<profile>/schedules.json`
- Code: `src/scheduler/` (spec parser, store, timer), `src/commands/schedule.ts`, wiring in `startScheduler` / `fireScheduledTask` in `src/bot/channel.ts`
- Logs: phase `scheduler` (`added`, `fire`, `missed`, `skip-not-allowed`)
