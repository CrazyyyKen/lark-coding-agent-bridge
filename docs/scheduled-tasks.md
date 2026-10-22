# Scheduled tasks (`/schedule`)

People can ask their bot to do something on a timetable, such as "every weekday at 08:30, triage my unread inbox and draft replies". This works the same on a laptop and in a server container.

## Why the bridge does it, not the agent

Each Lark message starts a fresh `claude -p` run that exits after the reply. Nothing inside that run can keep a timer:

| What the agent might try | Why it fails here |
|---|---|
| Claude Code `CronCreate` | Lives only while that run's process lives (seconds). The bridge now passes `--disallowedTools CronCreate,CronDelete,CronList`. |
| A background loop (`setsid nohup script.sh &` that sleeps until 08:30) | Survives the run, but not a container restart, and every bridge update recreates the container. Wei Leong's bot did this on 2026-10-21 at 16:01, and the 17:07 roll-out killed it before its first run. The prompt names this one explicitly. |
| `crontab`, systemd timers | Not in the container (read-only filesystem, no cron daemon). On a laptop or dedicated host, a cron job running `claude` skips the bridge: no per-person login, no access check, and the reply has to be sent by hand. |
| Windows Task Scheduler | Works only on that laptop, with full access, and only for fixed messages unless it starts `claude` outside the bridge. |
| Cloud routine (`/schedule` skill, `RemoteTrigger`) | Runs on Anthropic's servers with no `lark-cli` login. |

The bridge process stays up, so it keeps the timetable. When a task is due it posts `⏰ Scheduled task …` in the owner's DM and feeds the task in as a message from them. The run then takes the normal path: access check, the person's own Lark login (team mode with `perUserLogin`), the DM's session (so "send draft 2" afterwards has context), and normal reply rendering.

## Commands (DM only)

| Command | Does |
|---|---|
| `/schedule add <when> <task>` | Create. `<when>`: `daily 08:30`, `weekdays 8:30am`, `weekends 10:00`, `mon,wed,fri 17:00`, `mon-thu 5pm`, `once 2026-12-24 09:00`, `cron 30 8 * * 1-5` |
| `/schedule list` | A card with your tasks (next run, last result) and **Run now / Pause or Resume / Remove** buttons; taps update the card in place |
| `/schedule run <id>` | Run now; the timetable is unchanged |
| `/schedule pause <id>` / `resume <id>` | Turn off / on (resume recomputes the next run) |
| `/schedule remove <id>` | Delete |

## One-tap cards

- **Asking in plain words.** When someone asks the agent for a recurring task, it writes the `/schedule add …` line on its own line in its reply. After the reply, the bridge finds such lines (up to 3) and posts a **📅 Create this scheduled task?** card under it: **Create schedule** / **Not now**. Nothing is created until someone taps. Only the person who asked can confirm, and only once (a second tap creates no duplicate). Suggestions are checked like `/schedule add` before the card is shown, live in memory for 24 hours, and expire on restart (the visible command still works). A line slipped into the reply by an email or document still needs that person's tap.
- **Task list.** `/schedule list` buttons act only on the clicker's own tasks.
- **Missed run.** The "skipped" notice has a **Run it now** button.
- **Each run.** The task starts with a **⏰ Scheduled task** card (the run's reply hangs off it) with **Run again** and **Pause schedule**; Pause turns the card into **Resume schedule**. Those buttons carry `arg: "<id> run-card"` so the tap redraws that card, not the task list.

Buttons carry `{cmd: 'schedule.<sub>', arg: <id>}` and run as `/schedule <sub> <id>` with the clicker as sender (the existing card-command path in `src/card/dispatcher.ts`).

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
