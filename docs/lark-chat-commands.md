# Lark chat commands

Commands you can send to a bot in a Lark chat. Anything that doesn't start with `/` goes to the agent (Claude or Codex) as a normal message.

- In a group, @mention the bot first (for example `@Bot /status`).
- **Admin** commands work only for the bot's owner (the person who created the app) and anyone added with `/invite admin`. Other people get "This command is for admins only."
- `/help` in the chat shows the short version of this list.

Source of truth: the `handlers` table in [src/commands/index.ts](../src/commands/index.ts).

## Conversation

| Command | Who | What it does |
|---|---|---|
| `/new` (or `/reset`) | everyone | Start a fresh conversation in this chat; stops any running task. |
| `/new chat [name]` | everyone | Create a new group with a fresh conversation and add you to it. |
| `/resume [N]` | everyone | List the last N past conversations (default 5, max 20) and pick one to continue. |
| `/stop` | everyone | Stop the task that's running now (same as the ⏹ button on the reply card). |
| `/stop comment:<scopeHash>` | admin | Stop a task started from a cloud-doc comment. |
| `/status` | everyone | Show the bot's current state: workspace, session, running task. |
| `/timeout [N\|off\|default]` | everyone | Set this conversation's inactivity check to N minutes (1–120), turn it off, or go back to the global default. |
| `/timeout comment:<scopeHash> N` | admin | Set the inactivity check for a doc-comment task. |
| `/help` | everyone | Show the command list. |

## Settings and access

| Command | Who | What it does |
|---|---|---|
| `/config` | admin | Open the settings card: **model**, run mode (personal / team), reply style, tool-call display, progress messages, **quick-reply buttons** (Off or up to 1–10, default 6), concurrency, default timeout, meeting agent, access lists and lark-cli identity policy. |
| `/invite user @someone` | admin | Let someone DM the bot. |
| `/invite admin @someone` | admin | Make someone an admin (admins can also DM the bot). |
| `/invite group` | admin | Let the bot answer in this group. |
| `/invite all group` | admin | Let the bot answer in every group it's already in. |
| `/remove user\|admin @someone` | admin | Undo `/invite user` or `/invite admin`. |
| `/remove group` | admin | Stop the bot answering in this group. |
| `/account` | admin | Show the Lark app the bot runs as; `/account change` switches App ID and secret, then reconnects. |

In **team** mode the user and group allow-lists are switched off (anyone can use the bot). Admin commands still need an admin.

## Your own Lark login (team bots only)

These appear only on team bots that have per-person login turned on. Each one acts only on the sender's own login.

| Command | Who | What it does |
|---|---|---|
| `/login` | everyone | Sign in once with your own Lark account, so the bot reads your docs and calendar as you. Send it in a DM. Replies with a **Sign in with Lark** button. |
| `/whoami` | everyone | Show whether you're signed in, with a **Sign out** (or **Sign in**) button. |
| `/logout` | everyone | Delete your login from the bot. |

The first time you DM a team bot it greets you with the same **Sign in with Lark** card.

## Scheduled tasks

The bot does something for you on a timetable, for example "every weekday at 08:30, triage my unread inbox and draft replies". When a task is due, the bot posts `⏰ Scheduled task …` in your DM and works on it as if you had sent it, using your own Lark login and the same conversation (so "send draft 2" afterwards works).

Send these in a **DM** with the bot. A task belongs to whoever created it: nobody else can see, run or remove it, admins included.

| Command | Who | What it does |
|---|---|---|
| `/schedule` | everyone | Show the scheduled-task help and the time zone the bot uses. |
| `/schedule add <when> <task>` | everyone | Create a task, e.g. `/schedule add weekdays 08:30 Triage my unread inbox and draft replies, don't send`. |
| `/schedule list` | everyone | A card with your tasks (ids, next run, last result) and **Run now / Pause / Resume / Remove** buttons. |
| `/schedule run <id>` | everyone | Run a task now; its timetable doesn't change. |
| `/schedule pause <id>` / `resume <id>` | everyone | Turn a task off or back on. |
| `/schedule remove <id>` | everyone | Delete a task. |

**Writing `<when>`:**

| You write | Runs |
|---|---|
| `daily 08:30` | every day at 08:30 |
| `weekdays 8:30am` | Monday to Friday |
| `weekends 10:00` | Saturday and Sunday |
| `mon,wed,fri 17:00` or `mon-thu 5pm` | on those days |
| `once 2026-12-24 09:00` | once, then the task is deleted |
| `cron 30 8 * * 1-5` | a standard 5-field cron expression |

- Times are in the bot's time zone (`Asia/Kuala_Lumpur` on the server); `/schedule` shows it.
- At most 10 tasks per person, at most one run every 15 minutes, and a task can be up to 2,000 characters.
- The bot runs tasks only while it's online. If it was offline at the due time but is back within an hour, the task still runs; after that it tells you it skipped the run, with a **Run it now** button.
- Each run starts with a **⏰ Scheduled task** card with **Run again** and **Pause schedule** buttons, so you can stop a task straight from its output.
- **Easiest:** just ask the bot ("every weekday at 8:30, summarize my inbox"). It shows the `/schedule add …` line and a **📅 Create this scheduled task?** card; tap **Create schedule**. Only you can tap it, and nothing is created until you do.

Comes from the `feat/scheduler` branch of lark-coding-agent-bridge; how it works is in that repo's `docs/scheduled-tasks.md`.

## Workspace (folder the agent works in)

| Command | Who | What it does |
|---|---|---|
| `/cd <path>` | admin | Switch the working folder (starts a new conversation). |
| `/ws list` | admin | List saved folders. |
| `/ws save <name>` / `use <name>` / `remove <name>` | admin | Save the current folder under a name, switch to a saved one, or delete one. |

## Meetings

Needs **Meeting agent** turned on in `/config`, then a bot restart.

| Command | Who | What it does |
|---|---|---|
| `/meeting` | admin | Show meeting status. |
| `/meeting join <9-digit meeting no.>` | admin | Make the bot join a Lark meeting (digits only, not the link). |
| `/meeting leave [no.]` | admin | Leave the meeting. |
| `/meeting notes [no.]` | admin | Write meeting notes from the captions (sent only to you). |
| `/meeting ask <question>` | admin | Ask a question with the meeting's context. |
| `/meeting transcript [no.]` | admin | Show the captions the agent actually received. |
| `/meeting stop [no.]` | admin | Stop a stuck meeting task. |

## Bot maintenance

| Command | Who | What it does |
|---|---|---|
| `/ps` | admin | List the bots running on the same machine and mark the one replying. |
| `/exit <id\|#>` | admin | Shut down a bot from the `/ps` list. |
| `/reconnect` | admin | Force a reconnect if the bot stopped responding after a network blip. |
| `/doctor [description]` | admin | Hand the bot's logs and your description to the agent to diagnose. |
| `/doc` | everyone | Explains doc comments: @mention the bot in a supported cloud-doc comment and it replies there. No setup needed. |

## Buttons under the bot's replies

When the bot needs you to choose (send a draft or not, what to do after an inbox triage), it puts the choices as buttons under its reply, for example **Send it · Edit the draft · Cancel**, or **Archive 4–7 · Draft replies for 1 and 3**.

- Tapping a button is the same as typing that text as your next message. You can always type instead.
- Only the person the bot was answering can tap them; in a group, other people's taps do nothing. Each set of buttons can be answered once, and they expire after a day or when the bot restarts.
- The admin sets how many buttons a reply may have in `/config` → **Quick-reply buttons**: Off, or 1–10 (default 6).
- A button that starts with `/` (like `/schedule list` or `/login`) runs that command.
- `/help` also has buttons: **📅 My scheduled tasks**, and on team bots **🔑 Sign in** and **👤 Who am I**.

## Not a command

- Claude Code's own slash commands (`/model`, `/compact` and so on) aren't passed through. Use `/config` to change the model. Bots default to Sonnet 5.5; "Use default" in the picker means that.
