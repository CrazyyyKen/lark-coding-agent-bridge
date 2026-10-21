# Server deployment: one bridge instance per Linux user

How GDEX runs `lark-channel-bridge` on a shared Ubuntu server (or WSL2 for testing). Background and reasoning: [docs/department-agents-plan.md](../docs/department-agents-plan.md) §5–§6.

**On a shared host that already runs other containers (e.g. a production server), use [docker/](docker/README.md) instead:** one container per bot, nothing installed on the host.

Every bot (a department agent, HR Help, or one person's assistant) is its **own instance**:

| | Per instance |
|---|---|
| Linux user | e.g. `exec-teong`, `dept-hr`, `pub-hrhelp` (no login shell) |
| Home | `/srv/lark/<name>`, mode `0700`: bridge state, Claude Code state (`~/.claude`), lark-cli login |
| Lark app | Exactly one; one profile in the instance |
| Service | `lark-bridge@<name>` from [systemd/lark-bridge@.service](systemd/lark-bridge@.service) |
| Claude | Shared bots: `ANTHROPIC_API_KEY` in `service.env`. Personal assistants: the owner's own Team seat sign-in, **no** API key |

Files here:

| File | Purpose |
|---|---|
| `systemd/lark-bridge@.service` | System template unit, hardened so an instance can only write inside its own home |
| `workspace-template/.claude/settings.json` | Claude Code permissions for `workspace` mode: allows `lark-cli`, reads of message attachments, and blocks the agent from reading the bridge's secrets |
| [`new-instance.sh`](new-instance.sh) | Steps 2–4 below (and the service template from step 1) in one command. Carries its own copies of the two files above, so keep them in sync |
| [`remove-instance.sh`](remove-instance.sh) | Stops an instance, archives its home folder and deletes its Linux user |

## Quick start: one command per bot

The server does not need this repo. Install the tools from npm (§1), then copy the two scripts over once:

```bash
# from your machine
scp deploy/new-instance.sh deploy/remove-instance.sh <server>:/tmp/
# on the server
sudo install -d -m 700 /opt/lark-tools
sudo install -m 700 /tmp/new-instance.sh /tmp/remove-instance.sh /opt/lark-tools/
```

Then, per bot:

```bash
# Personal assistant: the owner scans the QR code, then signs in to Claude
sudo bash /opt/lark-tools/new-instance.sh staff-aisyah

# Shared bot with an app the Lark admin created, on the Team plan's API key
sudo bash /opt/lark-tools/new-instance.sh dept-hr --app-id cli_xxx --mode team --claude api-key
```

Defaults: `--mode personal`, `--access full` for a personal bot (no permission prompts, keeps memory; credentials stay denied) or `workspace` for a team bot (with the permission template; team bots can't be `full`), `--claude login`. Run with `--help` for all options. Remove a bot with `sudo bash /opt/lark-tools/remove-instance.sh <name>`. In WSL you can run the scripts straight from the repo under `/mnt/c/...`.

The manual steps below are what the script does.

## 1. Host setup (once, as root)

```bash
# Node 22 + global tools (installed by root, never auto-updated by bots)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs jq
npm install -g lark-channel-bridge @anthropic-ai/claude-code @larksuite/cli

install -d -m 755 /srv/lark
cp lark-bridge@.service /etc/systemd/system/    # new-instance.sh does this for you
systemctl daemon-reload
```

Install the GDEX fork, not the public npm package: the fork carries per-person sign-in, scheduled tasks, the English chat text and the newer models. Build a package on your machine with `pnpm build && pnpm pack` and install that file on the server with `npm install -g ./lark-channel-bridge-<version>.tgz`.

## 2. Create an instance (as root)

```bash
NAME=test-hr          # Linux user + instance name
APP_ID=cli_xxxxxxxx   # the Lark app for this bot

useradd --system --user-group --create-home --home-dir /srv/lark/$NAME --shell /usr/sbin/nologin $NAME
chmod 700 /srv/lark/$NAME

# Workspace with the permission template
install -d -m 700 -o $NAME -g $NAME /srv/lark/$NAME/workspace
cp -r workspace-template/.claude /srv/lark/$NAME/workspace/   # the copy from deploy/
chown -R $NAME:$NAME /srv/lark/$NAME/workspace

# Profile (prompts for the App Secret). Lark international tenant = --tenant lark
sudo -u $NAME -H lark-channel-bridge profile create $NAME \
  --agent claude --app-id $APP_ID --tenant lark --workspace /srv/lark/$NAME/workspace
```

Set the profile's mode and permissions (shared bot shown; for a personal assistant use `"personal"` and `"full"`, with [workspace-settings-personal.json](docker/workspace-settings-personal.json) as the workspace's `.claude/settings.json`):

```bash
CFG=/srv/lark/$NAME/.lark-channel/config.json
sudo -u $NAME -H sh -c "umask 077; jq '.profiles[\"$NAME\"].mode = \"team\"
  | .profiles[\"$NAME\"].permissions = {\"defaultAccess\":\"workspace\",\"maxAccess\":\"workspace\"}' \
  $CFG > $CFG.tmp && mv $CFG.tmp $CFG"
```

## 3. Give the instance its Claude credential

**Shared bot** (HR Agent, HR Help, …): API key from the Console org linked to the Team plan.

```bash
read -rsp 'Anthropic API key: ' KEY; echo
printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" | sudo -u $NAME -H sh -c 'umask 077; cat > ~/.lark-channel/service.env'
unset KEY
```

**Personal assistant**: the owner signs in with their own Team seat. **Do not** put `ANTHROPIC_API_KEY` in its `service.env`, because an API key overrides the seat sign-in. Which sign-in method works headlessly is test S1 in [docs/spike-checklist.md](../docs/spike-checklist.md):

```bash
# Option A: interactive sign-in stored in the instance's ~/.claude
sudo -u $NAME -H claude          # then /login → "Claude account with subscription";
                                 # open the URL on any browser, paste the code back, then /exit

# Option B: long-lived token, if your Claude Code version has it (check `claude --help`)
sudo -u $NAME -H claude setup-token   # prints a token; store it in service.env as:
# CLAUDE_CODE_OAUTH_TOKEN=...
```

## 4. First run in the foreground, then as a service

```bash
sudo -u $NAME -H lark-channel-bridge run   # binds lark-cli, connects to Lark; DM the bot, then Ctrl-C
systemctl enable --now lark-bridge@$NAME
journalctl -u lark-bridge@$NAME -f
```

The foreground run is a quick way to see errors. It is only required when lark-cli is **not** installed: the bridge auto-installs lark-cli only with a terminal. With lark-cli installed globally (§1), the service binds it on start, which is why `new-instance.sh` goes straight to the service.

## Rules

- **Never copy an instance's home to another machine or user.** The bridge encrypts `secrets.enc` with a key derived from the hostname and Linux username. Create instances fresh on each host, and don't rename the host after setup.
- Upgrades (bridge, Claude Code, lark-cli) are done by root on the host. `DISABLE_AUTOUPDATER=1` stops a bot updating Claude Code itself.
- Removing an instance: `systemctl disable --now lark-bridge@$NAME`, archive `/srv/lark/$NAME`, `userdel $NAME`.

## WSL2 instead of a server

The same steps work in WSL2 (Ubuntu 24.04) with two preparations:

```ini
# /etc/wsl.conf, then `wsl --shutdown` from Windows and reopen
[boot]
systemd=true

[interop]
appendWindowsPath=false   # so `node` / `claude` never resolve to the Windows installs
```

WSL stops when idle or when the laptop sleeps, so use it for functional tests, not for multi-day soak tests. Use **separate test Lark apps**. If the same app connects from two machines, Lark splits its messages between them.
