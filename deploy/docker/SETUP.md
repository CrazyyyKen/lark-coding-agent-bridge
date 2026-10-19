# Setting up Lark bots on a server

Step-by-step setup for running personal Lark assistants in containers, one container per person, on a server that already runs other containers. For how it works and why, see [README.md](README.md).

Replace `<user>` and `<server>` with the server's login user and address (the same ones you use with `ssh`), and `ken` with the bot's name.

**What you need**

- Docker with Compose 2.24 or newer on the server, and a user in the `docker` group (`docker ps` works without `sudo`).
- Outbound HTTPS from the server to `larksuite.com`, `api.anthropic.com`, `registry.npmjs.org` and Docker Hub.
- The server owner's OK, since the bots run next to their containers.

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
- `/status` → agent `claude`, access `workspace`
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

Someone who only wants general Claude answers, not their own mail and calendar, doesn't need a bot: the owner of an existing bot sends `/invite user @them` in Lark.

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
| One bot different from the shared one | Put `CLAUDE_CODE_OAUTH_TOKEN=…` (or `ANTHROPIC_API_KEY=…`) in `bots/<name>.claude.env` with mode 600, then restart that bot |
| Back to each bot's own sign-in | Delete `claude.env` (or `bots/<name>.claude.env`) and restart |

## When something goes wrong

| Symptom | Fix |
|---|---|
| `add` printed `warning: Claude did not answer` | The bot isn't signed in. Open Claude Code (see "Which account"), `/login`, `/exit`, then `./lark-bots.sh restart <name>` |
| `status` says "Owner's Lark account: not connected" | `./lark-bots.sh authorize <name>` |
| Authorization page or `authorize` complains about permissions | Remove permissions the bot doesn't need from the app in the Lark developer console, or `./lark-bots.sh authorize <name> --domain calendar,mail` |
| Bot shows `Restarting` or `Exited` | `docker logs --tail 50 lark-bot-<name>` |
| Log says "read-only file system" | Comment out `read_only: true` in `bot.yaml`, `./lark-bots.sh restart <name>`, and report what tried to write |
| Bot doesn't reply in Lark | `./lark-bots.sh status <name>`, then `./lark-bots.sh logs <name>` while sending it a message |
| `bash\r: No such file or directory` | A script got Windows line endings: `sed -i 's/\r$//' lark-bots.sh` |

## Good to know

- **The bots don't touch other containers.** Everything they create is named `lark-bot-*`, they publish no ports, and each has a memory cap (1.5 GB), a CPU cap (1 core, low priority) and rotated logs.
- **Each bot only reaches its owner's data.** Its owner's Lark login is stored in its own volume, which no other container can see, and the bot answers only its owner.
- **Anyone in the server's `docker` group can read every bot's volume**, including the owners' Lark logins. Keep that group small.
- **The bot's permissions follow the Lark app.** `authorize` requests every user permission the app enables. An app created by the QR code enables several hundred, including sending mail as the owner; remove the ones the bot doesn't need from the app before authorizing.
- **Don't change a bot's hostname** in `bot.yaml`. The bridge's encryption key depends on it, and the bot would lose its Lark app secret.
