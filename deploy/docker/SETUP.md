# Setting up Lark bots on a server

Step-by-step setup for running Lark bots in containers, one container per bot, on a server that already runs other containers: **personal assistants** (one per person, acting as that person) and **department bots** (shared by a department, acting only as the bot; see [Creating a department bot](#creating-a-department-bot)). For how it works and why, see [README.md](README.md).

Replace `<user>` and `<server>` with the server's login user and address (the same ones you use with `ssh`), and `ken` with the bot's name.

**What you need**

- Docker with Compose 2.24 or newer on the server, and a user in the `docker` group (`docker ps` works without `sudo`).
- Outbound HTTPS from the server to `larksuite.com`, `api.anthropic.com`, `registry.npmjs.org` and Docker Hub.
- The server owner's OK, since the bots run next to their containers.

## Quick reference: add a bot

Once the one-time setup (steps 1–4) is done, adding a person's bot is:

```bash
cd ~/lark-bots

# 1. Create the bot. The owner scans the QR code and creates their own new app.
#    At "Connect the owner's Lark account now?" answer n to do it in step 2 instead
#    (or Y to do it right here and skip step 2).
./lark-bots.sh add <name>

# 2. Connect the owner's Lark account. Send the owner the link (or let them scan the
#    QR code); they sign in as themselves and approve each link.
./lark-bots.sh authorize <name>

# 3. Restart. authorize already restarts the bot, so this is only needed if you changed
#    something by hand or the bot isn't answering.
./lark-bots.sh restart <name>

# 4. Check: running, and connected as the owner.
./lark-bots.sh status <name>
```

Then the owner DMs their bot in Lark: `hi`, then "What's on my calendar today?". Details for each step are below.

## 1. Copy the folder to the server

Run this **on your laptop**, not inside an SSH session. It asks for the server user's password.

```powershell
# Windows PowerShell
scp -r C:\Users\70685\Desktop\lark-coding-agent-bridge\deploy\docker <user>@<server>:~/lark-bots
```

```bash
# or WSL
scp -r /mnt/c/Users/70685/Desktop/lark-coding-agent-bridge/deploy/docker <user>@<server>:~/lark-bots
```

- Copy from the repo, not from a `~/lark-bots` folder you tested with: that one holds test bots (`bots/`) and maybe a credential (`claude.env`).
- If `~/lark-bots` already exists on the server, `scp` puts the files in `~/lark-bots/docker` instead. Remove or rename the old folder first.
- If the server's name doesn't resolve from your laptop, use its IP address.

Check on the server:

```bash
ls ~/lark-bots
# Dockerfile  README.md  SETUP.md  bot.yaml  entrypoint.sh  lark-bots.sh  workspace-settings.json
```

## 2. Save a baseline

On the server. This only reads; it records how busy the server is before any bot exists, so you can compare later.

```bash
cd ~/lark-bots
{ date; free -h; docker stats --no-stream; } > baseline-before-bots.txt
```

## 3. Prepare and build

```bash
cd ~/lark-bots && chmod +x lark-bots.sh
BOT=test docker compose -f bot.yaml config >/dev/null && echo "compose file OK"
docker images | grep -E '^node '      # nothing, or no 22-bookworm-slim line: nothing shared
./lark-bots.sh build
```

- `build` takes a few minutes, downloads about 1 GB and uses CPU and disk while it runs. It doesn't stop or change any running container. Run it when the server's own workload is quietest.
- If `docker images` lists `node 22-bookworm-slim`, another image uses the same base; ask before building, because the build refreshes that tag.

## 4. Claude credential (optional)

Two ways for bots to use Claude:

| | How | When |
|---|---|---|
| **Sign in per bot** | Skip this step. `add` opens Claude Code for each new bot and you sign in there | One or two bots |
| **Sign in once for all bots** | Get a token with `claude setup-token` on your laptop (where Claude Code is installed), then run `./lark-bots.sh set-claude` on the server, choose 1 and paste it | Several bots |

The token is saved in `~/lark-bots/claude.env` (mode 600). Treat it like a password: it gives full use of the Claude account.

## 5. Add a bot

One bot per person. The person should be with you (or on a screen share), because they scan a QR code and approve a link.

```bash
cd ~/lark-bots
./lark-bots.sh add ken
```

Bot names: lowercase letters, digits and `-`, unique per person.

The script walks through four parts:

1. **Lark app.** A QR code appears. The person scans it with the Lark app and creates a **new** app (for example "Ken's Assistant"); they become its owner. Don't reuse an app that runs anywhere else. If the Lark admin created the app, use `./lark-bots.sh add ken --app-id cli_xxx` instead and paste the App Secret.
2. **Claude.** Skipped if step 4 saved a credential. Otherwise Claude Code opens:
   - type `/login` and choose the Claude account,
   - open the link it shows in your laptop's browser and sign in,
   - paste the code back into the terminal,
   - type `/exit` (Ctrl+C before pasting the code cancels the sign-in).
   
   The script then checks that Claude answers (`Claude: OK`).
3. **Start.** The bot starts as container `lark-bot-ken`.
4. **Lark account.** "Connect the owner's Lark account now?" Answer `Y`. A link and QR code appear; the person opens it, signs in as **themselves** and approves. An app with more than 250 permissions needs several links (Lark's limit per link); approve each one as it appears. The script ends with how many permissions were granted.

## 6. Check

```bash
./lark-bots.sh status ken
```

Expect:

```
Container:  running since … · restarts: 0
Resources:  CPU 0.00% · memory 70MiB / 1.5GiB
Owner's Lark account: <their name> · token valid · N permissions granted
```

Then the person DMs their bot in Lark:

- `hi` → a reply card
- `/status` → agent `claude`, access `full` (personal bots; team bots show `workspace`)
- "What's on my calendar today?" → their calendar, without the bot asking for authorization

## 7. Compare after a day

```bash
cd ~/lark-bots
{ date; free -h; docker stats --no-stream; } > baseline-after-bots.txt
diff baseline-before-bots.txt baseline-after-bots.txt
```

The other containers' rows and the available memory should look about the same; the new rows are the `lark-bot-*` containers. Each file is one moment, so small swings are normal.

## Adding more people

Repeat step 5 with a new name, then step 6. Each bot uses about 70 MB idle and at most 1.5 GB while answering.

**Don't `/invite` other people to someone's personal assistant.** A personal assistant acts with its owner's Lark login, so anyone invited would be reading and sending as the owner: their mail, calendar and documents. People who don't need their own assistant use their department's bot instead.

## Creating a department bot

A department bot (for example **HR Agent**) is shared by everyone in a department. It answers from the department's knowledge and acts only as **the bot itself**, never as a person, so nobody's mail or calendar is reachable through it ([plan §7.1](../../docs/department-agents-plan.md)).

Two things decide who can use it, and both must be right:

| | Set by | Must be |
|---|---|---|
| **Who can reach the bot in Lark** | The Lark app's **availability** | The department (or the whole company, for a company-wide bot like HR Help) |
| **Whom the bot answers** | The bot's **mode** | `team`: everyone who can reach it. (`personal` answers only the app's owner and silently ignores everyone else) |

That's why a department bot needs an app **created by the Lark admin**, not from the QR code. A QR-created app belongs to the person who scans it and is normally available only to them, so other members can't find or message the bot even in team mode. `add --mode team` without `--app-id` warns about this.

### 1. Lark admin creates the app

In the Lark Developer Console ([open.larksuite.com/app](https://open.larksuite.com/app)):

1. **Create a custom app** (企业自建应用), e.g. "HR Agent", with an icon and a description staff will recognise. It must be a custom app: Lark's long-connection delivery only works for custom apps.
2. **Features → Bot**: enable.
3. **Permissions** (*tenant* / app-identity permissions only). The bot needs these to work at all:

   | What for | Permission |
   |---|---|
   | Receive direct messages | `im:message.p2p_msg:readonly` (Read direct messages sent to the bot) |
   | Receive @-mentions in groups | `im:message.group_at_msg:readonly` (Receive group messages that @ the bot) |
   | Reply | `im:message:send_as_bot`, and `im:message:update` to edit its replies |
   | Live-updating reply cards | `cardkit:card:write` |
   | Read images and files people send | `im:resource` |
   | "Typing" reaction while it works | `im:message.reactions:write_only` |
   | Group info and members | `im:chat:read` |

   Add document, wiki, Drive and Base permissions for the knowledge it should read or write (plan §10.2). **Don't** add user-identity permissions such as mail: a department bot never uses them. If something doesn't work later, the bot's log names the missing permission: Lark's error says which scope is required (`./lark-bots.sh logs <name>`, look for `99991672` or `scope`). Add it and publish a new version.
4. **Events & Callbacks**. These are two separate settings on the same page:
   - **Event configuration**: subscription mode **Receive events through persistent connection** (长连接, no public URL needed). Add **Receive messages v2.0** (`im.message.receive_v1`). Optionally add **Comment added** (`drive.notice.comment_add_v1`) if the bot should answer @-mentions in document comments.
   - **Callback configuration**: also set it to **persistent connection**, and add **card.action.trigger** (卡片回传交互). Without this, the bot's buttons (stop, settings, choices) don't respond. Use the new `card.action.trigger`, not the old `card.action.trigger_v1`, which can't use a persistent connection.
5. **Version management & release → Availability**: choose the department (for HR Help: all members). **Create and publish the version**, then approve it in **Lark Admin → Workplace → App review** if your tenant requires review.
6. Send the **App ID** (`cli_…`) and **App Secret** to whoever runs `lark-bots.sh`, over a private channel.

Every later change to permissions, events, callbacks or availability needs a **new published version** before it takes effect. Console labels can differ slightly between Lark versions and languages; the codes in brackets are what to search for.

**Who manages the bot.** Settings commands in Lark (`/config`, `/invite`) are for the app's owner, which here is whoever created the app in the console. To let the department's knowledge owner manage it, the app owner DMs the bot `/invite admin @them`.

### 2. Add the bot on the server

```bash
cd ~/lark-bots
./lark-bots.sh add hr-agent --app-id cli_xxx --mode team   # paste the App Secret when asked
```

There's no owner login to connect: `add` skips that step for team bots, and `authorize` refuses them.

> **Coming:** optional per-person Lark sign-in for team bots (each member signs in with their own account, in their own folder) is being built on branch `feat/per-user-login`; see [docs/per-user-login.md](../../docs/per-user-login.md). Until it ships and is switched on for a bot, a team bot acts only as the bot itself.

### 3. Give it its own Claude credential

A department bot serves many people, so don't let it share Claude usage with every other bot or ride on someone's personal sign-in. Both ways below work; you can switch any time.

```bash
./lark-bots.sh set-claude hr-agent    # choose 1 (subscription token) or 2 (API key)
./lark-bots.sh restart hr-agent
```

| | **1. Subscription seat set aside for the bot** | **2. API key** |
|---|---|---|
| How | A Team seat used only by this bot; run `claude setup-token` signed in as that seat and paste the token | A key from the Claude Console organisation linked to the Team plan |
| Cost | Fixed: USD 25/month (Standard) or USD 125 (Premium, 5× the usage) | Per use: the Team plan's monthly API credits first (USD 20 per seat, pooled, up to USD 500), then pay-as-you-go |
| When usage runs out | The bot answers **everyone** with a usage-limit error until the seat's limit resets (a few hours; there's also a weekly limit) | Only if the credits run out and auto-reload is off; you set the spend limit |
| Good for | A small department or light use. Start here and watch for limit errors | A busy department, or a company-wide bot like HR Help |
| Check first | Team seats are licensed to named members. Confirm with Anthropic that a seat may be assigned to a shared internal bot before relying on it in production | Nothing extra |

Don't use a person's own seat for a department bot: their own Claude use and the whole department's would share one limit. `add` and `set-mode` remind you if the bot has no credential of its own. Plan §10.3 has the cost comparison.

### 4. Give it its knowledge and groups

The bot can only read what is shared with it, like a new colleague:

- Add the bot as a member of the department's wiki space, and as a collaborator on the folders, docs and Bases it should use.
- Add it to the department's group chats (group settings → Bots → Add). In groups, people @-mention it.
- Share only what **every** member of the department may see. Restricted material (payroll, disciplinary files) stays out; people with access reach it through their own personal assistant.

### 5. Check with a member who isn't the app owner

Have a department member DM the bot `hi`, then ask it something from the department's documents. If they get no reply, see "Department members get no reply" in [When something goes wrong](#when-something-goes-wrong).

### Changing an existing bot's mode

```bash
./lark-bots.sh set-mode <name> team       # or: personal
```

It explains what changes, asks to confirm, and restarts the bot. Switching to `team` also **removes the owner's Lark login** from the bot, so nobody can act through it. Switching to `personal` makes the bot answer only the app's owner; run `authorize` afterwards to connect their account.

Converting someone's personal assistant into a department bot isn't recommended: its app was usually created from the QR code (so members can't reach it), and it carried a person's login. Create a fresh department bot as above instead.

## Day to day

| Task | Command |
|---|---|
| All bots | `./lark-bots.sh list` |
| One bot in detail | `./lark-bots.sh status <name>` |
| Live log (Ctrl+C stops watching, the bot keeps running) | `./lark-bots.sh logs <name>` |
| All containers on the server | `docker ps` or `docker stats --no-stream` |
| Restart (also starts a paused bot) | `./lark-bots.sh restart <name>` or `restart all` |
| Pause a bot, keep everything | `docker stop lark-bot-<name>` |
| Reconnect the owner's Lark account | `./lark-bots.sh authorize <name>` (or `--domain calendar,mail` for fewer permissions) |
| Change who a bot answers | `./lark-bots.sh set-mode <name> <personal\|team>` |
| Change how much Claude Code may do | `./lark-bots.sh set-access <name> <full\|workspace\|read-only>` (personal bots default to `full`: no permission prompts, keeps memory; team bots can't be `full`) |
| Update the bridge, Claude Code and lark-cli | `./lark-bots.sh update` (a build: run it at a quiet time) |
| Remove a bot, keep its data | `./lark-bots.sh remove <name>` |
| Remove a bot and its data | `./lark-bots.sh remove <name> --purge` |
| Remove everything | `remove --purge` each bot, then `docker image rm lark-bot:latest` |

## Is a bot running? Stopping it

A Lark app must be connected from **one place at a time**: if the same app runs on two machines (say your laptop's WSL and the server), Lark splits its messages between them. So before a bot goes live on the server, check where else its app might be running.

**Container bots** (on the server, or in WSL if you tested there):

| | Command |
|---|---|
| Check | `cd ~/lark-bots && ./lark-bots.sh list`, or `docker ps --filter name=lark-bot-` |
| Pause (keeps data and logins; stays stopped across restarts) | `docker stop lark-bot-<name>` |
| Start again | `./lark-bots.sh restart <name>` |
| Remove for good | `./lark-bots.sh remove <name> --purge`, then delete its app in the Lark developer console if no longer needed |

**Bridges started directly with `lark-channel-bridge`** (for example an earlier test in WSL):

| | Command |
|---|---|
| Check | `lark-channel-bridge ps` ("当前没有 bot 在运行" means none is running) |
| Stop one started in a terminal | Ctrl+C in that terminal, or `lark-channel-bridge kill <#>` with the number from `ps` |
| Check / stop one installed with `lark-channel-bridge start` | `lark-channel-bridge status`, then `lark-channel-bridge stop` (add `--profile <name>` for other profiles) |

## Claude account

Claude Code is only inside the containers, so `claude` on the server itself says "command not found". That's expected.

**Which account a bot uses**

```bash
ls claude.env bots/<name>.claude.env 2>/dev/null   # listed: shared credential; nothing: the bot's own sign-in
docker compose -f bot.yaml --env-file bots/<name>.env run --rm bot claude
# then /status, then /exit
```

**Change account**

| Change | How |
|---|---|
| One bot's own sign-in | Open Claude Code as above, `/logout`, `/login` with the other account, `/exit`, then `./lark-bots.sh restart <name>` |
| All bots to one shared account | `./lark-bots.sh set-claude`, then `./lark-bots.sh restart all` (the shared credential takes priority over each bot's own sign-in) |
| One bot different from the shared one (subscription token or API key) | `./lark-bots.sh set-claude <name>`, choose 1 or 2, then `./lark-bots.sh restart <name>`. It writes `bots/<name>.claude.env`, which wins over the shared one |
| One bot back to its own sign-in while a shared credential exists | `./lark-bots.sh set-claude <name>`, choose 3, then restart it |
| Everything back to each bot's own sign-in | Delete `claude.env` and every `bots/*.claude.env`, then `./lark-bots.sh restart all` |

`set-claude <name>` needs the current image (its entrypoint keeps only the credential the bot is meant to use): run `./lark-bots.sh update` once after updating these files. Older per-bot files written by hand still work, except a hand-written subscription token can't override a shared **API key**. Rewrite such files with `set-claude <name>`.

## When something goes wrong

| Symptom | Fix |
|---|---|
| `add` printed `warning: Claude did not answer` | The bot isn't signed in. Open Claude Code (see "Which account"), `/login`, `/exit`, then `./lark-bots.sh restart <name>` |
| `status` says "Owner's Lark account: not connected" | `./lark-bots.sh authorize <name>` |
| `authorize` fails with `strict mode is "bot"` | Your `lark-bots.sh` is older than this guide: copy the current one over. `authorize` now lifts strict mode before the login. If the bot is a `team` bot, that's correct: team bots never act as a person |
| Authorization page or `authorize` complains about permissions | Remove permissions the bot doesn't need from the app in the Lark developer console, or `./lark-bots.sh authorize <name> --domain calendar,mail` |
| Bot shows `Restarting` or `Exited` | `docker logs --tail 50 lark-bot-<name>` |
| Log says "read-only file system" | Comment out `read_only: true` in `bot.yaml`, `./lark-bots.sh restart <name>`, and report what tried to write |
| Bot doesn't reply in Lark | `./lark-bots.sh status <name>`, then `./lark-bots.sh logs <name>` while sending it a message |
| **Department members get no reply** (the owner does) | Have a member DM the bot, then run `docker exec lark-bot-<name> sh -c 'grep -h skip-not-allowed-user ~/.lark-channel/profiles/*/logs/bridge-*.jsonl \| tail -3'`. **A line appears:** the bot received the message but is in `personal` mode: `./lark-bots.sh set-mode <name> team`. **Nothing appears, or members can't find the bot in Lark search:** Lark isn't delivering their messages, because the app's availability doesn't include them. The Lark admin adds the department under Version management → Availability and publishes a new version. A QR-created app: create a department bot instead ([Creating a department bot](#creating-a-department-bot)) |
| `bash\r: No such file or directory` | A script got Windows line endings: `sed -i 's/\r$//' lark-bots.sh` |

## Good to know

- **The bots don't touch other containers.** Everything they create is named `lark-bot-*`, they publish no ports, and each has a memory cap (1.5 GB), a CPU cap (1 core, low priority) and rotated logs.
- **A personal assistant only reaches its owner's data.** Its owner's Lark login is stored in its own volume, which no other container can see, and the bot answers only its owner. A department bot holds no person's login at all; it sees only what is shared with the bot.
- **Anyone in the server's `docker` group can read every bot's volume**, including the owners' Lark logins. Keep that group small.
- **The bot's permissions follow the Lark app.** `authorize` requests every user permission the app enables. An app created by the QR code enables several hundred, including sending mail as the owner; remove the ones the bot doesn't need from the app before authorizing.
- **Don't change a bot's hostname** in `bot.yaml`. The bridge's encryption key depends on it, and the bot would lose its Lark app secret.
