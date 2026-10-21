#!/usr/bin/env bash
# Create one bot instance: its own Linux user, Lark app, workspace and systemd
# service. Automates deploy/README.md §1–4. Run as root on the server, or in
# WSL2 with systemd enabled. Self-contained: copy this file (and
# remove-instance.sh) to the server; the repo is not needed there.
#
#   sudo bash new-instance.sh <name> [options]
#
# Options:
#   --app-id <cli_xxx>       Use an app the Lark admin created (prompts for its App Secret).
#                            Without it a QR code is shown; whoever scans it creates the
#                            app and becomes its owner.
#   --tenant <lark|feishu>   Tenant for --app-id. Default: lark
#   --mode <personal|team>   personal: answers only the app owner and may use the owner's
#                            Lark login. team: anyone may use it, bot identity only.
#                            Default: personal
#   --access <workspace|read-only|full>
#                            Claude Code permission level. Default: full for personal bots (no
#                            permission prompts, keeps memory), workspace for team bots (which
#                            can't be full)
#   --claude <login|api-key|skip>
#                            login: sign in to a Claude account now (personal assistants).
#                            api-key: store ANTHROPIC_API_KEY in service.env (shared bots).
#                            Default: login
#
# Remove an instance again with remove-instance.sh <name>.

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE=/srv/lark
UNIT=/etc/systemd/system/lark-bridge@.service

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ─── Embedded files ───────────────────────────────────────────────────────────
# Copies of deploy/systemd/lark-bridge@.service and
# deploy/workspace-template/.claude/settings.json. Keep them in sync.

unit_file() {
  cat <<'EOF'
# System-level template unit: one bridge instance per Linux user.
#
#   instance name (%i) = Linux user = home under /srv/lark/%i
#   e.g. systemctl enable --now lark-bridge@exec-teong
#
# Each instance holds exactly one profile (its own Lark app), so the bridge
# runs the instance's active profile. See deploy/README.md for setup.
#
# Prefer this over `lark-channel-bridge start` on servers: `start` installs a
# per-user unit (systemctl --user), which needs lingering and a user session
# for every service account.

[Unit]
Description=Lark Channel Bridge instance %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
Group=%i
WorkingDirectory=/srv/lark/%i
Environment=HOME=/srv/lark/%i
Environment=LARK_CHANNEL_HOME=/srv/lark/%i/.lark-channel
Environment=PATH=/usr/local/bin:/usr/bin:/bin
# Claude Code is updated by the admin (Ansible), never by a running bot.
Environment=DISABLE_AUTOUPDATER=1
# Optional, 0600: ANTHROPIC_API_KEY for shared bots, or the owner's Claude
# token for personal assistants. Values here override the lines above.
EnvironmentFile=-/srv/lark/%i/.lark-channel/service.env
ExecStart=/usr/bin/env lark-channel-bridge run
Restart=always
RestartSec=5

# Hardening: the instance can write only inside its own home. Other
# instances' homes are 0700 and owned by other users, so they stay
# unreadable even if the agent is manipulated.
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/srv/lark/%i
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF
}

# Full access (personal bots): copy of deploy/docker/workspace-settings-personal.json.
# Otherwise: copy of deploy/workspace-template/.claude/settings.json.
workspace_settings() {
  if [ "$1" = full ]; then
    cat <<'EOF'
{
  "permissions": {
    "allow": [
      "Bash(lark-cli:*)",
      "Bash(date)",
      "Read(~/.lark-channel/profiles/*/media/**)"
    ],
    "deny": [
      "Read(~/.lark-channel/config.json)",
      "Read(~/.lark-channel/service.env)",
      "Read(~/.lark-channel/**/secrets.enc)",
      "Read(~/.lark-channel/**/.keystore.salt)",
      "Read(~/.lark-channel/**/lark-cli/**)",
      "Read(~/.local/share/lark-cli/**)",
      "Edit(~/.local/share/lark-cli/**)",
      "Read(~/.claude.json)",
      "Read(~/.claude/.credentials.json)",
      "Edit(~/.lark-channel/**)",
      "Edit(~/.claude.json)",
      "Edit(~/.claude/.credentials.json)",
      "Edit(~/.claude/settings.json)",
      "Edit(~/.claude/settings.local.json)"
    ]
  }
}
EOF
    return
  fi
  cat <<'EOF'
{
  "permissions": {
    "allow": [
      "Bash(lark-cli:*)",
      "Bash(date)",
      "Read(~/.lark-channel/profiles/*/media/**)"
    ],
    "deny": [
      "Read(~/.lark-channel/config.json)",
      "Read(~/.lark-channel/service.env)",
      "Read(~/.lark-channel/**/secrets.enc)",
      "Read(~/.lark-channel/**/.keystore.salt)",
      "Read(~/.lark-channel/**/lark-cli/**)",
      "Read(~/.local/share/lark-cli/**)",
      "Edit(~/.local/share/lark-cli/**)",
      "Read(~/.claude.json)",
      "Read(~/.claude/.credentials.json)",
      "Edit(~/.lark-channel/**)",
      "Edit(~/.claude/**)"
    ]
  }
}
EOF
}

# ─── Arguments ────────────────────────────────────────────────────────────────

NAME=""
APP_ID=""
TENANT="lark"
MODE="personal"
ACCESS=""
CLAUDE="login"

while [ $# -gt 0 ]; do
  case "$1" in
    --app-id) APP_ID="${2:-}"; shift 2 ;;
    --tenant) TENANT="${2:-}"; shift 2 ;;
    --mode)   MODE="${2:-}"; shift 2 ;;
    --access) ACCESS="${2:-}"; shift 2 ;;
    --claude) CLAUDE="${2:-}"; shift 2 ;;
    -h|--help) usage 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *)  [ -z "$NAME" ] || die "only one instance name expected"; NAME="$1"; shift ;;
  esac
done

[ -n "$NAME" ] || usage 1
[[ "$NAME" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "name must be 2-31 characters: lowercase letters, digits and '-', starting with a letter"
[[ "$TENANT" =~ ^(lark|feishu)$ ]] || die "--tenant must be lark or feishu"
[[ "$MODE" =~ ^(personal|team)$ ]] || die "--mode must be personal or team"
# A personal bot serves only its owner: no permission prompts (no one can answer them in a
# chat) and it may keep memory. A team bot can't be full: permission rules bind only Claude's
# file tools, not the shell, so one member's run could reach another member's login.
if [ -z "$ACCESS" ]; then
  [ "$MODE" = team ] && ACCESS=workspace || ACCESS=full
fi
[[ "$ACCESS" =~ ^(workspace|read-only|full)$ ]] || die "--access must be workspace, read-only or full"
[ "$MODE" = team ] && [ "$ACCESS" = full ] \
  && die "a team bot can't have full access: one member could reach another member's Lark login"
[[ "$CLAUDE" =~ ^(login|api-key|skip)$ ]] || die "--claude must be login, api-key or skip"

HOME_DIR="$BASE/$NAME"
WORKSPACE="$HOME_DIR/workspace"
CFG="$HOME_DIR/.lark-channel/config.json"

# ─── Checks ───────────────────────────────────────────────────────────────────

step "Checking the host"
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash $0 $NAME ..."
[ -d /run/systemd/system ] || die "systemd is not running (in WSL, set systemd=true in /etc/wsl.conf and run 'wsl --shutdown')"
for tool in node lark-channel-bridge claude lark-cli; do
  path="$(command -v "$tool" || true)"
  [ -n "$path" ] || die "$tool is not installed (see deploy/README.md §1)"
  case "$path" in
    /mnt/*) die "$tool resolves to a Windows install ($path); set appendWindowsPath=false in /etc/wsl.conf" ;;
  esac
done
id -u "$NAME" >/dev/null 2>&1 && die "Linux user '$NAME' already exists; pick another name or remove it with remove-instance.sh"
[ ! -e "$HOME_DIR" ] || die "$HOME_DIR already exists"
echo "ok: $(lark-channel-bridge --version 2>/dev/null | head -1) · node $(node -v)"

# ─── Host setup (idempotent) ──────────────────────────────────────────────────

step "Installing the service template"
install -d -m 755 "$BASE"
tmp_unit="$(mktemp)"
unit_file > "$tmp_unit"
if cmp -s "$tmp_unit" "$UNIT"; then
  echo "unchanged: $UNIT"
else
  install -m 644 "$tmp_unit" "$UNIT"
  systemctl daemon-reload
  echo "installed: $UNIT"
fi
rm -f "$tmp_unit"

# From here on, a failure leaves a half-made instance behind.
trap 'warn "setup stopped part-way; clean up with: sudo bash $SELF_DIR/remove-instance.sh $NAME"' ERR

# ─── Linux user and workspace ─────────────────────────────────────────────────

step "Creating Linux user $NAME"
useradd --system --user-group --create-home --home-dir "$HOME_DIR" --shell /usr/sbin/nologin "$NAME"
chmod 700 "$HOME_DIR"
install -d -m 700 -o "$NAME" -g "$NAME" "$WORKSPACE" "$WORKSPACE/.claude"
workspace_settings "$ACCESS" > "$WORKSPACE/.claude/settings.json"
chown -R "$NAME:$NAME" "$WORKSPACE"
chmod 600 "$WORKSPACE/.claude/settings.json"
echo "home: $HOME_DIR (mode 700) · workspace with the permission template"

# Commands below run as the instance user from a folder it owns.
as_bot() { (cd "$WORKSPACE" && sudo -u "$NAME" -H "$@"); }

# ─── Lark app and bridge profile ──────────────────────────────────────────────

step "Connecting the Lark app"
if [ -n "$APP_ID" ]; then
  echo "Using app $APP_ID. Paste its App Secret when asked."
  as_bot lark-channel-bridge profile create "$NAME" --agent claude \
    --workspace "$WORKSPACE" --app-id "$APP_ID" --tenant "$TENANT"
else
  echo "A QR code follows. The person who will own this bot scans it with the Lark app"
  echo "and creates a new app, e.g. \"<Name>'s Assistant\". Don't pick an app that is"
  echo "already running somewhere else."
  as_bot lark-channel-bridge profile create "$NAME" --agent claude --workspace "$WORKSPACE"
fi
[ -f "$CFG" ] || die "profile was not created ($CFG missing)"

step "Setting mode=$MODE, access=$ACCESS"
as_bot node -e '
  const fs = require("fs");
  const [file, name, mode, access] = process.argv.slice(1);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const p = cfg.profiles && cfg.profiles[name];
  if (!p) { console.error(`profile ${name} not found in ${file}`); process.exit(1); }
  p.mode = mode;
  p.permissions = { defaultAccess: access, maxAccess: access };
  fs.writeFileSync(file + ".tmp", JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
' "$CFG" "$NAME" "$MODE" "$ACCESS"
echo "ok"

# ─── Claude credential ────────────────────────────────────────────────────────

step "Claude sign-in ($CLAUDE)"
case "$CLAUDE" in
  api-key)
    read -rsp 'Anthropic API key: ' KEY; echo
    [ -n "$KEY" ] || die "no key entered"
    printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" \
      | as_bot sh -c 'umask 077; cat > "$HOME/.lark-channel/service.env"'
    unset KEY
    echo "saved to $HOME_DIR/.lark-channel/service.env"
    ;;
  login)
    echo "Claude Code opens next. Type /login, choose your Claude account, open the link"
    echo "in a browser and paste the code back. Then type /exit to continue."
    as_bot claude || true
    ;;
  skip)
    warn "no Claude credential set; the bot can't answer until you add one"
    ;;
esac

if [ "$CLAUDE" != skip ]; then
  echo "Checking that Claude answers as $NAME..."
  if reply="$(as_bot sh -c '[ -f "$HOME/.lark-channel/service.env" ] && { set -a; . "$HOME/.lark-channel/service.env"; set +a; }; exec timeout 90 claude -p "Reply with the single word OK"' 2>&1)"; then
    echo "Claude: $reply"
  else
    warn "Claude did not answer: $reply"
    warn "fix the sign-in, then: sudo systemctl restart lark-bridge@$NAME"
  fi
fi

# ─── Service ──────────────────────────────────────────────────────────────────

step "Starting lark-bridge@$NAME"
systemctl enable --now "lark-bridge@$NAME" >/dev/null 2>&1
sleep 8
if systemctl is-active --quiet "lark-bridge@$NAME"; then
  echo "running"
else
  warn "the service is not running"
fi
journalctl -u "lark-bridge@$NAME" -n 15 --no-pager || true

trap - ERR

cat <<EOF

$(printf '\033[1m')Done: $NAME$(printf '\033[0m')
  1. The owner DMs the bot "hi" in Lark, then "/status".
EOF
if [ "$MODE" = personal ]; then
  cat <<EOF
  2. To connect their own Lark account, they ask in a DM for something personal,
     e.g. "summarize my unread emails today", and approve the link the bot sends.
EOF
fi
cat <<EOF

  Logs:    journalctl -u lark-bridge@$NAME -f
  Restart: sudo systemctl restart lark-bridge@$NAME
  Remove:  sudo bash $SELF_DIR/remove-instance.sh $NAME
EOF
