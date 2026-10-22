# Lark bots in containers

Runs each bot in its own container on a host that already runs other containers, without installing anything on the host. Step-by-step setup: [SETUP.md](SETUP.md). Use this instead of the systemd setup in [../README.md](../README.md) when the host is shared, for example a production server.

| Per bot | |
|---|---|
| Container | `lark-bot-<name>`, its own Compose project and network |
| Data | Volume `lark-bot-<name>-home`: Lark app, Lark login, chats, Claude history |
| Wall | A container can't see another container's volume |
| Limits | 1.5 GB memory (no swap), 1 CPU, low CPU priority, 256 processes, one Claude run at a time |
| Hardening | All capabilities dropped, no new privileges, read-only image, no published ports, rotated logs (3 × 10 MB) |

Shared by all bots: the image `lark-bot:latest` and, optionally, one Claude credential in `claude.env`. Bots can instead be assigned to a Claude account in `claude-accounts/` (see [Claude accounts](#claude-accounts)).

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | The image: Node 22, the bridge, Claude Code, lark-cli, an unprivileged `bot` user |
| `entrypoint.sh` | Puts the permission template into a new bot's workspace |
| `workspace-settings.json` | Copy of [../workspace-template/.claude/settings.json](../workspace-template/.claude/settings.json); keep them in sync |
| `bot.yaml` | Compose template for one bot, with the limits above |
| `lark-bots.sh` | Everything else: build, add, list, logs, restart, update, remove |

## Setup on the host (once)

Needs Docker with Compose, and a user in the `docker` group. Pack the bridge first (next section), copy this folder to the host, for example to `~/lark-bots`, then:

```bash
cd ~/lark-bots
chmod +x lark-bots.sh
./lark-bots.sh build        # about 1 GB image
./lark-bots.sh set-claude   # optional: one Claude credential for every bot
```

## Packing the bridge

The image installs the bridge from this repo, not from npm (the npm release lacks our changes). On a machine with the repo, from its root:

```bash
pnpm install && pnpm build && pnpm pack
mv lark-channel-bridge-*.tgz deploy/docker/lark-channel-bridge.tgz
scp deploy/docker/lark-channel-bridge.tgz <host>:~/lark-bots/
```

Copy the other files in this folder too when they've changed, but never the host's `bots/`, `claude.env`, `claude-accounts/` or `provisioner.env`.

## Add a bot

```bash
./lark-bots.sh add ken                              # personal assistant; the owner scans the QR code
./lark-bots.sh add dept-hr --app-id cli_xxx --mode team
```

A department bot (`--mode team`) needs an app the **Lark admin** created with availability set to the department; a QR-created app is normally available only to the person who scanned it, so other members couldn't reach the bot. Give it its own API key too. Step by step: [SETUP.md, Creating a department bot](SETUP.md#creating-a-department-bot).

For a personal assistant, `add` then offers to connect the owner's Lark account: it shows a link and a QR code, the owner opens it, signs in as themselves and approves, and the bot restarts using their identity. To do it later, or again after the owner revokes it:

```bash
./lark-bots.sh authorize ken                         # every user permission enabled on the app (default)
./lark-bots.sh authorize ken --domain calendar,mail  # or only some areas
```

By default the link asks for exactly the user permissions enabled on the app, so the app's settings in the Lark developer console decide what the bot may do as the owner. An app created by the QR code comes with several hundred, including sending mail as the owner and deleting documents; remove the ones the bot shouldn't have from the app before authorizing. The owner only grants what the link asks for, and only within what they can see in Lark themselves. The approval page lists every permission; they should read it before approving. Available areas: `lark-cli auth login --help`.

Then the owner DMs the bot `hi` and `/status`.

### Without questions (the provisioner)

The bot provisioner ([docs/bot-provisioning-plan.md](../../docs/bot-provisioning-plan.md)) creates bots without a person at the terminal. The App Secret comes in on stdin, so it never appears in a process list:

```bash
printf '%s\n' "$APP_SECRET" | ./lark-bots.sh add ali --app-id cli_xxx --mode personal \
  --claude-account ai@gdexpress.com --app-secret-stdin --yes --json
```

`--yes` asks nothing: no Claude sign-in (a bot without a credential starts anyway and can't answer until it gets one), no connecting the owner's Lark account (the bot sends them a sign-in card when it first needs it), and a half-made bot is removed when a step fails, so the same command can be retried. `--json` ends with one line:

```
{"ok":true,"bot":"ali","appId":"cli_xxx","mode":"personal","access":"full","claudeAccount":"ai@gdexpress.com","claude":"ok","running":true}
{"ok":false,"code":4,"step":"Connecting the Lark app","error":"Lark rejected app cli_xxx with this App Secret"}
```

`claude` is `ok` (Claude answered), `failed` (it didn't) or `missing` (no credential yet). Exit codes: 0 created, 1 failed, 2 bad arguments, 3 bot name or Lark app already in use, 4 Lark rejected the App ID or App Secret.

## Claude accounts

Each Claude account the bots use (a Team seat's token, or an API key) is saved once, in `claude-accounts/<id>.env`, and bots are assigned to it. Replacing a token is then one command for every bot on that account.

```bash
./lark-bots.sh claude-account set ai@gdexpress.com             # paste the token from `claude setup-token`, signed in as that account
./lark-bots.sh claude-account set dept-hr-key --api-key        # or an API key from the Claude Console
./lark-bots.sh use-claude ali ai@gdexpress.com                 # assign a bot (restarts it)
./lark-bots.sh claude-account list                             # accounts and their bots
./lark-bots.sh claude-account check ai@gdexpress.com           # does it still answer?
printf '%s\n' "$TOKEN" | ./lark-bots.sh claude-account set ai@gdexpress.com --stdin --restart   # replace a token
```

A bot assigned to an account uses that account's credential or none: until the account's credential is saved, it doesn't fall back to the shared `claude.env`, so its usage never lands on another seat. `use-claude <name> shared` puts it back on the shared credential. `status <name>` and `list` show which credential each bot uses.

## The bot provisioner

Requests come in through a Lark form into the **AI Agent Requests** Base. The provisioner (`lark-provisioner`, one more container on this host) posts an approval card for each one in the AI Team group; **Approve** creates the bot with `add --yes`, on the Claude account chosen on the card. How it works: [docs/bot-provisioning-plan.md](../../docs/bot-provisioning-plan.md).

Once:

1. In the Lark developer console, create its own custom app (e.g. "AI Agent Admin"): Bot on; events and callbacks on persistent connection with `card.action.trigger`; permissions to read and write Base records (`bitable:app`), read group members (`im:chat.members:read`), send messages (`im:message:send_as_bot`) and update cards. **Availability:** everyone whose Claude seat may back a bot, because their Claude sign-in card comes to them as a DM from this app and Lark doesn't deliver a bot's DM outside its availability. Simplest is all staff: the app only sends these cards and ignores messages. Publish it and have it approved.
2. Add the app to the approval group, and as a collaborator that can edit on the AI Agent Requests Base.
3. On this host:

   ```bash
   cp provisioner.env.example provisioner.env && chmod 600 provisioner.env   # fill in the app's ID and secret
   ./lark-bots.sh provisioner check you@gdexpress.com   # reads the Base and group once, DMs you a preview card
   ./lark-bots.sh provisioner start      # builds lark-bot-provisioner on top of lark-bot:latest
   ```

| Task | Command |
|---|---|
| Follow its log | `./lark-bots.sh provisioner logs` |
| Stop it | `./lark-bots.sh provisioner stop` |
| After `./lark-bots.sh update` | `./lark-bots.sh provisioner start` again (rebuilds it on the new image) |

It has the Docker socket, which is root-equivalent on this host, and uses it only through `lark-bots.sh`. A request it was handling when it stopped becomes **Failed** on restart; Retry on its card continues it.

## Day to day

| Task | Command |
|---|---|
| See all bots | `./lark-bots.sh list` |
| Follow a log | `./lark-bots.sh logs <name>` |
| Restart | `./lark-bots.sh restart <name>` or `restart all` |
| Change who a bot answers | `./lark-bots.sh set-mode <name> <personal\|team>` |
| Change how much Claude Code may do | `./lark-bots.sh set-access <name> <full\|workspace\|read-only>` |
| Update the bridge, Claude Code and lark-cli on every bot | Pack and copy the bridge, then `./lark-bots.sh update` |
| Update one bot first (test bot) | Pack and copy, `./lark-bots.sh build`, then `./lark-bots.sh restart <name>`; the others stay on the old image until restarted |
| Remove (keep data / delete data) | `./lark-bots.sh remove <name>` / `remove <name> --purge` |
| Remove everything | `remove --purge` each bot, then `docker image rm lark-bot:latest` |

To pin Claude Code or lark-cli, build with `docker build --build-arg CLAUDE_CODE_VERSION=<version> --build-arg LARK_CLI_VERSION=<version> -t lark-bot:latest .`.

## Things to know

- **The hostname is fixed per bot** (`lark-bot-<name>`). The bridge encrypts its secrets with a key derived from the hostname, so don't change it in `bot.yaml`, or the bot loses its Lark app secret.
- **`claude.env` and `claude-accounts/` hold credentials.** They're created with mode 600 (the folder 700) and git-ignored. Anyone in the `docker` group can still read every bot's volume, so keep that group small.
- **A bot over its memory limit is restarted**, not swapped, so it never pushes production into swap. If replies fail on large jobs, raise `MEM_LIMIT` in `bots/<name>.env` (for example `MEM_LIMIT=2g`) and restart it.
- **If a bot fails because the image is read-only**, its logs show `EROFS` or "read-only file system". Comment out `read_only: true` in `bot.yaml`, restart it, and report what tried to write.
