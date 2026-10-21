# Lark bots in containers

Runs each bot in its own container on a host that already runs other containers, without installing anything on the host. Step-by-step setup: [SETUP.md](SETUP.md). Use this instead of the systemd setup in [../README.md](../README.md) when the host is shared, for example a production server.

| Per bot | |
|---|---|
| Container | `lark-bot-<name>`, its own Compose project and network |
| Data | Volume `lark-bot-<name>-home`: Lark app, Lark login, chats, Claude history |
| Wall | A container can't see another container's volume |
| Limits | 1.5 GB memory (no swap), 1 CPU, low CPU priority, 256 processes, one Claude run at a time |
| Hardening | All capabilities dropped, no new privileges, read-only image, no published ports, rotated logs (3 × 10 MB) |

Shared by all bots: the image `lark-bot:latest` and, optionally, one Claude credential in `claude.env`.

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

Copy the other files in this folder too when they've changed, but never the host's `bots/` or `claude.env`.

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
- **`claude.env` holds a credential.** It's created with mode 600 and git-ignored. Anyone in the `docker` group can still read every bot's volume, so keep that group small.
- **A bot over its memory limit is restarted**, not swapped, so it never pushes production into swap. If replies fail on large jobs, raise `MEM_LIMIT` in `bots/<name>.env` (for example `MEM_LIMIT=2g`) and restart it.
- **If a bot fails because the image is read-only**, its logs show `EROFS` or "read-only file system". Comment out `read_only: true` in `bot.yaml`, restart it, and report what tried to write.
