#!/usr/bin/env bash
# Run Lark bots in containers, one container per bot, without changing the host.
# Needs only Docker with Compose and membership of the docker group.
#
#   ./lark-bots.sh build                 Build the bot image (once, and after updates)
#   ./lark-bots.sh set-claude [name]     Save the Claude credential: shared by every bot, or for
#                                        one bot (subscription token, API key or its own sign-in)
#   ./lark-bots.sh claude-account set <id> [--api-key] [--stdin] [--restart]
#                                        Save (or replace) the credential of one Claude account,
#                                        e.g. ai@gdexpress.com; bots assigned to it use it.
#                                        --stdin reads it from a pipe, --restart restarts those bots
#   ./lark-bots.sh claude-account list   Every Claude account and the bots assigned to it
#   ./lark-bots.sh claude-account check <id>
#                                        Ask Claude a one-word question with that account's credential
#   ./lark-bots.sh claude-account remove <id>
#                                        Delete an account's credential (no bot may be assigned to it)
#   ./lark-bots.sh use-claude <name> <id|shared>
#                                        Assign a bot to a Claude account, or back to the shared one
#   ./lark-bots.sh add <name> [options]  Create a bot: QR code or --app-id, settings, start
#   ./lark-bots.sh authorize <name> [lark-cli auth login options]
#                                        Show the link (and QR code) the owner opens to let
#                                        the bot act as them. Default: every user permission
#                                        enabled on the app; narrow with e.g. --domain calendar,mail
#   ./lark-bots.sh set-mode <name> <personal|team>
#                                        Change who the bot answers (see --mode below); also
#                                        sets the matching access (personal: full, team: workspace)
#   ./lark-bots.sh set-access <name> <full|workspace|read-only>
#                                        Change how much Claude Code may do (team bots: not full)
#   ./lark-bots.sh status <name>         One bot: container state, resources, owner's Lark account
#   ./lark-bots.sh list                  Show every bot, its state and memory use
#   ./lark-bots.sh logs <name>           Follow a bot's log
#   ./lark-bots.sh restart <name|all>    Restart one bot or all of them
#   ./lark-bots.sh update                Rebuild the image and restart every bot on it
#   ./lark-bots.sh set-instructions <name> [--force]
#                                        Write the bot's CLAUDE.md (its standing instructions) from
#                                        stdin; keeps an existing one unless --force
#   ./lark-bots.sh bot-get <name> <path> [params-json]
#                                        Read-only Lark API call as the bot, e.g. to check what it
#                                        can read: bot-get dept-hr /open-apis/wiki/v2/spaces/get_node '{"token":"..."}'
#   ./lark-bots.sh bot-message <name> <email>
#                                        Send a text DM from the bot to that person (text on stdin)
#   ./lark-bots.sh provisioner <start|check [email]|stop|logs>
#                                        The bot provisioner: approval cards for the request form,
#                                        bots on Approve (needs provisioner.env; see README.md)
#   ./lark-bots.sh remove <name> [--purge] [--yes]
#                                        Stop and delete a bot; --purge also deletes its data;
#                                        --yes skips typing the name to confirm
#
# Options for add:
#   --app-id <cli_xxx>       Use an existing Lark app (asks for its App Secret).
#                            Without it a QR code is shown; whoever scans it owns the new app.
#                            Department (team) bots need an app the Lark admin created with
#                            availability set to the department; see SETUP.md.
#   --tenant <lark|feishu>   Tenant for --app-id. Default: lark
#   --mode <personal|team>   personal: answers only the app owner, may use the owner's Lark
#                            login. team: anyone may use it; each member signs in as themselves
#                            in a DM (per-person login), groups use the bot identity. Default: personal
#   --access <workspace|read-only|full>
#                            Claude Code permission level. Default: full for personal bots (no
#                            permission prompts, keeps memory), workspace for team bots. Team bots
#                            can't be full: one member's run could reach another member's login.
#   --claude-account <id>    Use this Claude account (see claude-account). Its credential may be
#                            saved later; until then the bot can't answer.
#   --app-secret-stdin       Read the App Secret for --app-id from stdin instead of asking.
#   --yes                    Ask nothing (for the provisioner): needs --app-id and
#                            --app-secret-stdin, skips Claude sign-in and connecting the owner's
#                            Lark account, and removes the half-made bot if a step fails.
#   --json                   End with one line of JSON describing the result.
#                            Exit codes: 0 created, 1 failed, 2 bad arguments, 3 bot name or
#                            Lark app already in use, 4 Lark rejected the App ID or App Secret.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# docker compose reads its working directory; run from here whoever calls us.
cd "$DIR"
IMAGE="lark-bot:latest"
CFG=/home/bot/.lark-channel/config.json
ACCOUNTS="$DIR/claude-accounts"

EXIT_ARGS=2       # bad arguments
EXIT_IN_USE=3     # bot name or Lark app already in use
EXIT_LARK_APP=4   # Lark rejected the App ID or App Secret

# add --json: the step that was running, and whether the JSON line is out yet
JSON=0
JSON_DONE=0
JSON_STEP=""
# add --yes: the half-made bot to remove if a step fails
CLEANUP_BOT=""

step() { JSON_STEP="$*"; printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { fail 1 "$@"; }
usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
confirm() { local a; read -rp "$1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }

# Stop with an exit code (see --json above) and, for add --json, a JSON line saying why.
fail() {
  local code="$1"; shift
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  [ -z "$CLEANUP_BOT" ] || cleanup_bot "$CLEANUP_BOT"
  if [ "$JSON" -eq 1 ] && [ "$JSON_DONE" -eq 0 ]; then
    JSON_DONE=1
    printf '{"ok":false,"code":%d,"step":"%s","error":"%s"}\n' "$code" "$(json_str "$JSON_STEP")" "$(json_str "$*")"
  fi
  exit "$code"
}

# A command failed outside fail() (set -e): still remove the half-made bot and end with JSON.
on_exit() {
  local rc=$?
  [ "$rc" -ne 0 ] || return 0
  [ -z "$CLEANUP_BOT" ] || cleanup_bot "$CLEANUP_BOT"
  if [ "$JSON" -eq 1 ] && [ "$JSON_DONE" -eq 0 ]; then
    printf '{"ok":false,"code":1,"step":"%s","error":"a command failed (exit %d); see the output above"}\n' \
      "$(json_str "$JSON_STEP")" "$rc"
  fi
}
trap on_exit EXIT

# Text as a JSON string body: control characters dropped, backslashes and quotes escaped
json_str() {
  local s
  s="$(printf '%s' "$1" | tr '\n\t' '  ' | tr -d '\000-\037')"
  s="${s//\\/\\\\}"
  printf '%s' "${s//\"/\\\"}"
}

# Remove a bot that add --yes started but couldn't finish, so the provisioner can retry
cleanup_bot() {
  local name="$1"
  CLEANUP_BOT=""
  warn "removing the half-made bot $name"
  bot_compose "$name" down -v >/dev/null 2>&1 || true
  rm -f "$DIR/bots/$name.env"
}

check_name() {
  [[ "${1:-}" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || fail "$EXIT_ARGS" "bot name must be 2-31 characters: lowercase letters, digits and '-', starting with a letter"
}

# Claude account ids: an email address or a short label (lowercase), e.g. ai@gdexpress.com
check_account() {
  [[ "${1:-}" =~ ^[a-z0-9][a-z0-9._@+-]{0,63}$ ]] \
    || fail "$EXIT_ARGS" "Claude account id must be up to 64 characters: lowercase letters, digits and . _ @ + -"
}

account_file() { printf '%s/%s.env' "$ACCOUNTS" "$1"; }

# A setting in a bot's env file (bots/<name>.env), or nothing
bot_var() { sed -n "s/^$2=//p" "$DIR/bots/$1.env" 2>/dev/null | head -1; }

# Set KEY in a bot's env file, or remove it when the value is empty
set_bot_var() {
  local file="$DIR/bots/$1.env" key="$2" value="$3" tmp
  tmp="$(mktemp "$file.XXXXXX")"
  grep -v "^$key=" "$file" > "$tmp" || true
  [ -z "$value" ] || printf '%s=%s\n' "$key" "$value" >> "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$file"
}

# Which Claude credential a bot runs on, in words
claude_source() {
  local name="$1" account
  account="$(bot_var "$name" CLAUDE_ACCOUNT)"
  if [ -n "$account" ]; then
    if [ -f "$(account_file "$account")" ]; then echo "account $account"
    else echo "account $account (no credential saved yet)"; fi
  elif [ -f "$DIR/bots/$name.claude.env" ]; then echo "its own credential"
  elif [ -f "$DIR/claude.env" ]; then echo "the shared credential"
  else echo "its own sign-in (/login inside the bot), if any"
  fi
}

# Bots assigned to a Claude account
account_bots() {
  local n
  for n in $(bot_names); do
    [ "$(bot_var "$n" CLAUDE_ACCOUNT)" = "$1" ] && echo "$n"
  done
  return 0
}

# The Lark app a bot runs on: from its env file (recorded since add --app-id), else from
# the running container's config. Empty if neither is available.
bot_app_id() {
  local name="$1" id
  id="$(bot_var "$name" APP_ID)"
  if [ -z "$id" ] && [ "$(docker inspect -f '{{.State.Running}}' "lark-bot-$name" 2>/dev/null)" = true ]; then
    id="$(docker exec "lark-bot-$name" node -e '
      const c = require("/home/bot/.lark-channel/config.json");
      const p = c.profiles[process.argv[1]];
      console.log((p && p.accounts && p.accounts.app && p.accounts.app.id) || "");' "$name" 2>/dev/null)" || id=""
  fi
  printf '%s' "$id"
}

# docker compose for one bot (its own project, network and volume)
bot_compose() {
  local name="$1"; shift
  docker compose -f "$DIR/bot.yaml" --env-file "$DIR/bots/$name.env" "$@"
}

bot_names() {
  local f
  for f in "$DIR"/bots/*.env; do
    [ -e "$f" ] || continue
    case "$f" in *.claude.env) continue ;; esac
    basename "$f" .env
  done
}

ensure_image() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 || cmd_build
}

# A personal bot serves only its owner, so it runs Claude Code without permission prompts
# (no one can answer them in a chat) and may keep memory. A team bot serves many people:
# full access would let one member's run read another member's login folder, because
# permission rules only bind Claude's file tools, not the shell.
default_access() { [ "$1" = team ] && echo workspace || echo full; }

check_access() {
  local mode="$1" access="$2"
  [[ "$access" =~ ^(workspace|read-only|full)$ ]] || fail "$EXIT_ARGS" "--access must be workspace, read-only or full"
  [ "$mode" = team ] && [ "$access" = full ] \
    && fail "$EXIT_ARGS" "a team bot can't have full access: one member could reach another member's Lark login"
  return 0
}

# The bot's workspace permission rules for an access level. Full access drops the blanket
# "no writes under ~/.claude" so the bot can keep memory; credentials stay off-limits.
settings_file() { [ "$1" = full ] && echo workspace-settings-personal.json || echo workspace-settings.json; }

# Run in the container with the settings file on stdin.
WRITE_SETTINGS='mkdir -p "$HOME/workspace/.claude" && cat > "$HOME/workspace/.claude/settings.json"'

# Set a bot's mode and access in its config and swap in the matching permission rules.
# The bot must be running; it picks the change up on the restart that follows.
apply_profile() {
  local name="$1" mode="$2" access="$3" c="lark-bot-$1"
  docker exec "$c" node -e '
    const fs = require("fs");
    const [file, name, mode, access] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const p = cfg.profiles && cfg.profiles[name];
    if (!p) { console.error(`profile ${name} not found in ${file}`); process.exit(1); }
    // Becoming a team bot: each member signs in as themselves
    // (docs/per-user-login.md). set-access keeps whatever a team bot has.
    if (mode === "team" && p.mode !== "team") p.team = { ...(p.team || {}), perUserLogin: true };
    p.mode = mode;
    p.permissions = { ...(p.permissions || {}), defaultAccess: access, maxAccess: access };
    fs.writeFileSync(file + ".tmp", JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  ' "$CFG" "$name" "$mode" "$access"
  docker exec -i "$c" sh -c "$WRITE_SETTINGS" < "$DIR/$(settings_file "$access")"
}

# ─── Commands ────────────────────────────────────────────────────────────────

cmd_build() {
  [ -f "$DIR/lark-channel-bridge.tgz" ] \
    || die "lark-channel-bridge.tgz is missing: pack the bridge from the repo and copy it here (README.md, Packing the bridge)"
  step "Building $IMAGE"
  docker build --pull -t "$IMAGE" "$DIR"
  docker image ls "$IMAGE"
}

cmd_set_claude() {
  local name="${1:-}" file="$DIR/claude.env"
  if [ -n "$name" ]; then
    check_name "$name"
    [ -e "$DIR/bots/$name.env" ] || die "no bot named $name"
    file="$DIR/bots/$name.claude.env"
    step "Claude credential for $name only"
  else
    step "Shared Claude credential"
    echo "Every bot without a credential of its own uses this one."
  fi
  cat <<'EOF'

  1  Claude subscription token: run `claude setup-token` once (on your laptop, or here with
     `docker run --rm -it lark-bot:latest claude setup-token`) and paste the token it prints.
     Usage counts against that Claude account's seat limits.
  2  Anthropic API key from the Claude Console. Usage is paid per use (the Team plan's
     monthly API credits first).
EOF
  [ -z "$name" ] || echo "  3  This bot's own Claude Code sign-in (/login inside the bot; see SETUP.md)."
  local choice var="" kind value=""
  read -rp "Choose: " choice
  case "$choice" in
    1) var=CLAUDE_CODE_OAUTH_TOKEN; kind=subscription ;;
    2) var=ANTHROPIC_API_KEY; kind=api-key ;;
    3) [ -n "$name" ] || die "cancelled"; kind=own ;;
    *) die "cancelled" ;;
  esac
  if [ -n "$var" ]; then
    read -rsp "Paste it (input hidden): " value; echo
    [ -n "$value" ] || die "nothing entered"
  fi
  # LARK_BOT_CLAUDE tells the container which credential to keep if the shared and the
  # bot's own file set different ones (see entrypoint.sh).
  (umask 077
   printf 'LARK_BOT_CLAUDE=%s\n' "$kind" > "$file"
   [ -z "$var" ] || printf '%s=%s\n' "$var" "$value" >> "$file")
  echo "saved $file (mode 600)."
  if [ -n "$name" ]; then
    # A bot's own credential replaces its Claude account; with both set, the entrypoint
    # would drop the credential as not belonging to that account.
    local account
    account="$(bot_var "$name" CLAUDE_ACCOUNT)"
    if [ -n "$account" ]; then
      set_bot_var "$name" CLAUDE_ACCOUNT ""
      echo "$name no longer uses Claude account $account."
    fi
    echo "Apply it: ./lark-bots.sh restart $name"
  else
    echo "Apply it: ./lark-bots.sh restart all"
  fi
}

# One credential per Claude account in claude-accounts/<id>.env. Bots point at an account
# (CLAUDE_ACCOUNT in bots/<name>.env), so replacing a token is one file and a restart.
cmd_claude_account() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    set)    claude_account_set "$@" ;;
    list)   claude_account_list ;;
    check)  claude_account_check "$@" ;;
    remove) claude_account_remove "$@" ;;
    *) fail "$EXIT_ARGS" "usage: ./lark-bots.sh claude-account <set|list|check|remove> ..." ;;
  esac
}

claude_account_set() {
  local id="" kind=subscription from_stdin=0 restart=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --api-key) kind=api-key; shift ;;
      --stdin)   from_stdin=1; shift ;;
      --restart) restart=1; shift ;;
      -*) fail "$EXIT_ARGS" "unknown option: $1" ;;
      *)  [ -z "$id" ] || fail "$EXIT_ARGS" "only one account id expected"; id="$1"; shift ;;
    esac
  done
  check_account "$id"
  local var=CLAUDE_CODE_OAUTH_TOKEN prefix=sk-ant-oat what="subscription token (claude setup-token, signed in as $id)"
  [ "$kind" = subscription ] || { var=ANTHROPIC_API_KEY; prefix=sk-ant-api; what="API key (Claude Console)"; }

  local value=""
  if [ "$from_stdin" -eq 1 ]; then
    IFS= read -r value || true
  else
    read -rsp "Paste the $what for $id (input hidden): " value; echo
  fi
  value="$(printf '%s' "$value" | tr -d '[:space:]')"
  [ -n "$value" ] || fail "$EXIT_ARGS" "nothing entered"
  [[ "$value" == "$prefix"* ]] \
    || warn "a $kind usually starts with $prefix; check that this is the right kind of credential"

  mkdir -p "$ACCOUNTS"
  chmod 700 "$ACCOUNTS"
  local file tmp
  file="$(account_file "$id")"
  tmp="$(mktemp "$file.XXXXXX")"
  # LARK_BOT_CLAUDE_ACCOUNT lets the entrypoint confirm the credential is the account the
  # bot was assigned (see entrypoint.sh).
  printf 'LARK_BOT_CLAUDE=%s\nLARK_BOT_CLAUDE_ACCOUNT=%s\n%s=%s\n' "$kind" "$id" "$var" "$value" > "$tmp"
  mv "$tmp" "$file"
  echo "saved $file (mode 600)"

  local bots
  bots="$(account_bots "$id" | tr '\n' ' ')"
  if [ -z "$bots" ]; then
    echo "No bot uses it yet: ./lark-bots.sh use-claude <name> $id"
  elif [ "$restart" -eq 1 ]; then
    local n
    for n in $bots; do bot_compose "$n" up -d --force-recreate >/dev/null 2>&1 && echo "restarted $n"; done
  else
    echo "Used by: $bots. Apply it: ./lark-bots.sh restart <name> for each"
  fi
}

claude_account_list() {
  local f id kind bots any=0
  printf '%-34s %-13s %s\n' ACCOUNT KIND BOTS
  for f in "$ACCOUNTS"/*.env; do
    [ -e "$f" ] || continue
    any=1
    id="$(basename "$f" .env)"
    kind="$(sed -n 's/^LARK_BOT_CLAUDE=//p' "$f" | head -1)"
    bots="$(account_bots "$id" | tr '\n' ' ')"
    printf '%-34s %-13s %s\n' "$id" "${kind:-?}" "${bots:--}"
  done
  # Bots assigned to an account whose credential isn't saved yet
  local n account
  for n in $(bot_names); do
    account="$(bot_var "$n" CLAUDE_ACCOUNT)"
    [ -z "$account" ] || [ -f "$(account_file "$account")" ] \
      || printf '%-34s %-13s %s\n' "$account" "not saved" "$n"
  done
  [ "$any" -eq 1 ] || echo "(no accounts yet: ./lark-bots.sh claude-account set <id>)"
  [ ! -f "$DIR/claude.env" ] || echo "Shared credential (claude.env): used by bots without an account or their own"
}

claude_account_check() {
  local id="${1:-}"
  check_account "$id"
  local file
  file="$(account_file "$id")"
  [ -f "$file" ] || fail 1 "no credential saved for $id"
  ensure_image
  local reply
  if reply="$(docker run --rm --env-file "$file" "$IMAGE" timeout 90 claude -p "Reply with the single word OK" 2>&1)"; then
    echo "ok: $id answered: $reply"
  else
    fail 1 "$id did not answer: $reply"
  fi
}

claude_account_remove() {
  local id="${1:-}"
  check_account "$id"
  local bots
  bots="$(account_bots "$id" | tr '\n' ' ')"
  [ -z "$bots" ] || fail 1 "still used by: $bots. Move them first: ./lark-bots.sh use-claude <name> <other id|shared>"
  rm -f "$(account_file "$id")"
  echo "removed the credential of $id"
}

cmd_use_claude() {
  local name="${1:-}" target="${2:-}"
  check_name "$name"
  [ -e "$DIR/bots/$name.env" ] || fail 1 "no bot named $name"
  [ -n "$target" ] || fail "$EXIT_ARGS" "usage: ./lark-bots.sh use-claude <name> <account id|shared>"
  if [ "$target" = shared ]; then
    set_bot_var "$name" CLAUDE_ACCOUNT ""
  else
    check_account "$target"
    set_bot_var "$name" CLAUDE_ACCOUNT "$target"
    [ -f "$(account_file "$target")" ] \
      || warn "no credential saved for $target yet: $name can't answer until ./lark-bots.sh claude-account set $target"
  fi
  # The bot's own credential file would override the account, so it goes.
  if [ -f "$DIR/bots/$name.claude.env" ]; then
    rm -f "$DIR/bots/$name.claude.env"
    echo "removed $name's own credential (bots/$name.claude.env)"
  fi
  echo "$name now uses $(claude_source "$name")"
  if docker inspect "lark-bot-$name" >/dev/null 2>&1; then
    bot_compose "$name" up -d --force-recreate >/dev/null 2>&1
    echo "restarted $name"
  fi
}

cmd_add() {
  local name="" app_id="" tenant="lark" mode="personal" access="" account=""
  local secret_stdin=0 yes=0 secret=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --app-id) app_id="${2:-}"; shift 2 ;;
      --tenant) tenant="${2:-}"; shift 2 ;;
      --mode)   mode="${2:-}"; shift 2 ;;
      --access) access="${2:-}"; shift 2 ;;
      --claude-account) account="${2:-}"; shift 2 ;;
      --app-secret-stdin) secret_stdin=1; shift ;;
      --yes)    yes=1; shift ;;
      --json)   JSON=1; shift ;;
      -*) fail "$EXIT_ARGS" "unknown option: $1" ;;
      *)  [ -z "$name" ] || fail "$EXIT_ARGS" "only one bot name expected"; name="$1"; shift ;;
    esac
  done
  JSON_STEP="checking the request"
  check_name "$name"
  [[ "$tenant" =~ ^(lark|feishu)$ ]] || fail "$EXIT_ARGS" "--tenant must be lark or feishu"
  [[ "$mode" =~ ^(personal|team)$ ]] || fail "$EXIT_ARGS" "--mode must be personal or team"
  [ -n "$access" ] || access="$(default_access "$mode")"
  check_access "$mode" "$access"
  [ -z "$account" ] || check_account "$account"
  [ -z "$app_id" ] || [[ "$app_id" =~ ^cli_[A-Za-z0-9]+$ ]] || fail "$EXIT_ARGS" "--app-id must look like cli_xxxxxxxxxxxx"
  [ "$secret_stdin" -eq 0 ] || [ -n "$app_id" ] || fail "$EXIT_ARGS" "--app-secret-stdin needs --app-id"
  if [ "$yes" -eq 1 ]; then
    [ -n "$app_id" ] || fail "$EXIT_ARGS" "--yes needs --app-id: an app from the QR code needs someone to scan it"
    [ "$secret_stdin" -eq 1 ] || fail "$EXIT_ARGS" "--yes needs --app-secret-stdin: nobody is there to type the App Secret"
  fi
  [ ! -e "$DIR/bots/$name.env" ] || fail "$EXIT_IN_USE" "bot '$name' already exists"
  docker volume inspect "lark-bot-$name-home" >/dev/null 2>&1 \
    && fail "$EXIT_IN_USE" "a data volume lark-bot-$name-home is left from an earlier bot; remove it with ./lark-bots.sh remove $name --purge"
  if [ -n "$app_id" ]; then
    # One app connected twice splits its messages between the two bots.
    local n
    for n in $(bot_names); do
      [ "$(bot_app_id "$n")" != "$app_id" ] || fail "$EXIT_IN_USE" "app $app_id already runs as bot '$n'"
    done
  fi
  if [ "$secret_stdin" -eq 1 ]; then
    IFS= read -r secret || true
    secret="$(printf '%s' "$secret" | tr -d '[:space:]')"
    [ -n "$secret" ] || fail "$EXIT_ARGS" "--app-secret-stdin: nothing was piped in"
  fi

  if [ "$mode" = team ] && [ -z "$app_id" ]; then
    warn "a team bot is for a whole department, but an app created from the QR code belongs to the"
    warn "person who scans it and is normally available only to them: other members may not be"
    warn "able to find or message the bot. For a department bot, have the Lark admin create the app"
    warn "with availability set to the department, then run: ./lark-bots.sh add $name --app-id cli_xxx --mode team"
    confirm "Create a team bot from a QR code anyway?" || die "cancelled"
  fi

  ensure_image
  mkdir -p "$DIR/bots"
  { printf 'BOT=%s\n' "$name"
    [ -z "$app_id" ] || printf 'APP_ID=%s\n' "$app_id"
    [ -z "$account" ] || printf 'CLAUDE_ACCOUNT=%s\n' "$account"
  } > "$DIR/bots/$name.env"
  if [ "$yes" -eq 1 ]; then
    CLEANUP_BOT="$name"
  else
    trap 'warn "setup stopped part-way; clean up with: ./lark-bots.sh remove '"$name"' --purge"' ERR
  fi

  step "Checking the container's hostname (the bridge's encryption key depends on it)"
  local host
  host="$(bot_compose "$name" run --rm -T bot hostname | tr -d '\r')"
  [ "$host" = "lark-bot-$name" ] || die "container hostname is '$host', expected lark-bot-$name"
  echo "ok: $host"

  step "Connecting the Lark app"
  if [ -n "$app_id" ] && [ "$secret_stdin" -eq 1 ]; then
    echo "Using app $app_id."
    local out
    if ! out="$(printf '%s\n' "$secret" | bot_compose "$name" run --rm -T bot lark-channel-bridge profile create "$name" \
        --agent claude --workspace /home/bot/workspace --app-id "$app_id" --tenant "$tenant" --app-secret-stdin 2>&1)"; then
      printf '%s\n' "$out" >&2
      grep -q 'app credentials validation failed' <<<"$out" \
        && fail "$EXIT_LARK_APP" "Lark rejected app $app_id with this App Secret"
      die "couldn't connect app $app_id (see the output above)"
    fi
    printf '%s\n' "$out"
    secret=""
  elif [ -n "$app_id" ]; then
    echo "Using app $app_id. Paste its App Secret when asked."
    bot_compose "$name" run --rm bot lark-channel-bridge profile create "$name" --agent claude \
      --workspace /home/bot/workspace --app-id "$app_id" --tenant "$tenant"
  else
    echo "A QR code follows. The person who will own this bot scans it with the Lark app"
    echo "and creates a new app, e.g. \"<Name>'s Assistant\". Don't pick an app that is"
    echo "already running somewhere else."
    bot_compose "$name" run --rm bot lark-channel-bridge profile create "$name" --agent claude \
      --workspace /home/bot/workspace
  fi

  step "Setting mode=$mode, access=$access, one Claude run at a time"
  bot_compose "$name" run --rm -T bot node -e '
    const fs = require("fs");
    const [file, name, mode, access] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const p = cfg.profiles && cfg.profiles[name];
    if (!p) { console.error(`profile ${name} not found in ${file}`); process.exit(1); }
    p.mode = mode;
    // Team bots: each member signs in as themselves (docs/per-user-login.md).
    if (mode === "team") p.team = { ...(p.team || {}), perUserLogin: true };
    p.permissions = { defaultAccess: access, maxAccess: access };
    p.preferences = { ...(p.preferences || {}), maxConcurrentRuns: 1 };
    fs.writeFileSync(file + ".tmp", JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  ' "$CFG" "$name" "$mode" "$access"
  bot_compose "$name" run --rm -T bot sh -c "$WRITE_SETTINGS" < "$DIR/$(settings_file "$access")"
  echo "ok"

  # ok: Claude answered · failed: it didn't · missing: no credential to try
  local claude=ok
  step "Claude sign-in"
  if [ -n "$account" ]; then
    if [ -f "$(account_file "$account")" ]; then
      echo "using Claude account $account"
    else
      warn "no credential saved for Claude account $account yet: the bot can't answer until"
      warn "./lark-bots.sh claude-account set $account"
      claude=missing
    fi
  elif [ -f "$DIR/claude.env" ] || [ -f "$DIR/bots/$name.claude.env" ]; then
    echo "using the saved credential"
  elif [ "$yes" -eq 1 ]; then
    warn "no Claude credential: the bot can't answer until it gets one (claude-account set and use-claude)"
    claude=missing
  else
    echo "No shared credential yet (./lark-bots.sh set-claude). Signing this bot in by itself:"
    echo "type /login, choose your Claude account, open the link, paste the code back, then /exit."
    # Ctrl+C here should end Claude Code only, not the rest of the setup.
    trap ':' INT
    bot_compose "$name" run --rm bot claude || true
    trap - INT
  fi
  if [ "$claude" = ok ]; then
    local reply
    if reply="$(bot_compose "$name" run --rm -T bot timeout 90 claude -p "Reply with the single word OK" 2>&1)"; then
      echo "Claude: $reply"
    else
      claude=failed
      warn "Claude did not answer: $reply"
      warn "fix the sign-in, then: ./lark-bots.sh restart $name"
    fi
  fi

  step "Starting lark-bot-$name"
  bot_compose "$name" up -d
  sleep 10
  docker ps --filter "name=^lark-bot-$name\$" --format '{{.Names}}: {{.Status}}'
  docker logs --tail 15 "lark-bot-$name" 2>&1 || true
  [ "$(docker inspect -f '{{.State.Running}}' "lark-bot-$name" 2>/dev/null)" = true ] \
    || die "lark-bot-$name is not running (see its log above)"
  trap - ERR
  CLEANUP_BOT=""

  local authorized=0
  if [ "$mode" = personal ] && [ "$yes" -eq 0 ]; then
    local answer
    read -rp "Connect the owner's Lark account now (mail, calendar, docs)? [Y/n] " answer
    if [[ ! "$answer" =~ ^[Nn] ]]; then
      cmd_authorize "$name" && authorized=1 || warn "not connected; run ./lark-bots.sh authorize $name later"
    fi
  fi

  echo
  echo "Done: $name"
  if [ "$mode" = team ]; then
    echo "  1. A department member (not the app owner) DMs the bot \"hi\" in Lark: it should reply."
    echo "     No reply? See \"Department members get no reply\" in SETUP.md."
    team_credential_hint "$name"
  else
    echo "  1. The owner DMs the bot \"hi\" in Lark, then \"/status\"."
  fi
  if [ "$mode" = personal ] && [ "$authorized" -eq 0 ]; then
    echo "  2. To connect their own Lark account: ./lark-bots.sh authorize $name"
    echo "     (or they ask the bot something personal in a DM and approve the link it sends)."
  fi

  if [ "$JSON" -eq 1 ]; then
    JSON_DONE=1
    printf '{"ok":true,"bot":"%s","appId":"%s","mode":"%s","access":"%s","claudeAccount":"%s","claude":"%s","running":true}\n' \
      "$name" "$app_id" "$mode" "$access" "$account" "$claude"
  fi
}

# A team bot serves many people. Sharing one Claude credential with every other bot means its
# whole department's use counts against the same limits; nudge towards its own credential.
team_credential_hint() {
  local name="$1"
  [ -f "$DIR/bots/$name.claude.env" ] && return
  [ -n "$(bot_var "$name" CLAUDE_ACCOUNT)" ] && return
  warn "$name has no Claude credential of its own, so its whole department's use counts against"
  warn "the shared one (or a personal sign-in). Give it its own: a subscription seat set aside for"
  warn "the bot, or an API key: ./lark-bots.sh claude-account set <id>, then use-claude $name <id>"
  warn "(see SETUP.md, department bots)"
}

# The bot's mode from its config, read in the running container
profile_mode() {
  local name="$1"
  docker exec "lark-bot-$name" node -e '
    const c = require("/home/bot/.lark-channel/config.json");
    console.log((c.profiles[process.argv[1]] || {}).mode || "personal");' "$name"
}

cmd_set_mode() {
  local name="${1:-}" mode="${2:-}"
  check_name "$name"
  [[ "$mode" =~ ^(personal|team)$ ]] || die "usage: ./lark-bots.sh set-mode <name> <personal|team>"
  [ -e "$DIR/bots/$name.env" ] || die "no bot named $name"
  local c="lark-bot-$name"
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] \
    || die "$c is not running; start it with ./lark-bots.sh restart $name"

  local current owner=""
  current="$(profile_mode "$name")" || die "couldn't read $name's settings"
  [ "$current" != "$mode" ] || { echo "$name is already a $mode bot"; return; }

  step "Switching $name from $current to $mode"
  if [ "$mode" = team ]; then
    owner="$(owner_auth "$name" | cut -f1)" || owner=""
    cat <<EOF
In team mode:
  - Anyone who can reach the bot in Lark can use it. The Lark app's availability decides who
    that is: an app created from the QR code is normally available only to the person who
    scanned it, so department members may still not see the bot.
  - In a DM, each member signs in once as themselves (the bot sends them a sign-in card) and
    the bot acts for them with their own login only. Groups, doc comments and meetings use the
    bot's own identity.
EOF
    [ -z "$owner" ] || cat <<EOF
  - It is connected to $owner's Lark account. That login will be removed, so nobody else can
    ever act through it. Switching back to personal later needs ./lark-bots.sh authorize again.
EOF
    cat <<EOF

For a department bot, a new bot on an app the Lark admin created is cleaner than converting
someone's personal assistant: see "Creating a department bot" in SETUP.md.
EOF
  else
    cat <<EOF
In personal mode the bot answers only the Lark app's owner (shown in the Lark developer
console) and silently ignores everyone else. The owner can then connect their own Lark
account with ./lark-bots.sh authorize $name.
EOF
  fi
  local access
  access="$(default_access "$mode")"
  echo
  echo "Claude Code access becomes '$access' (see ./lark-bots.sh set-access)."
  confirm "Switch $name to $mode?" || die "cancelled"

  apply_profile "$name" "$mode" "$access"

  if [ -n "$owner" ]; then
    bot_lark_cli "$name" auth logout >/dev/null 2>&1 || true
    if owner_auth "$name" >/dev/null 2>&1; then
      warn "couldn't remove $owner's Lark login. A team bot must not hold one: the agent could"
      warn "be talked into using it. Remove this bot (./lark-bots.sh remove $name --purge) and"
      warn "create the department bot fresh, as in SETUP.md \"Creating a department bot\"."
    else
      echo "removed $owner's Lark login"
    fi
  fi

  # The bridge reads the mode at start; in team mode it also switches lark-cli to bot-only.
  bot_compose "$name" up -d --force-recreate >/dev/null 2>&1
  echo "restarted: $name is now a $mode bot"
  if [ "$mode" = team ]; then
    team_credential_hint "$name"
  else
    echo "Next: ./lark-bots.sh authorize $name"
  fi
}

cmd_set_access() {
  local name="${1:-}" access="${2:-}"
  check_name "$name"
  [ -n "$access" ] || die "usage: ./lark-bots.sh set-access <name> <full|workspace|read-only>"
  [ -e "$DIR/bots/$name.env" ] || die "no bot named $name"
  local c="lark-bot-$name"
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] \
    || die "$c is not running; start it with ./lark-bots.sh restart $name"
  local mode
  mode="$(profile_mode "$name")" || die "couldn't read $name's settings"
  check_access "$mode" "$access"

  step "Setting $name ($mode) to access=$access"
  apply_profile "$name" "$mode" "$access"
  bot_compose "$name" up -d --force-recreate >/dev/null 2>&1
  echo "restarted: $name now runs with access=$access"
}

# lark-cli in a bot's container, with the same environment the bridge gives it
bot_lark_cli() {
  local name="$1"; shift
  local home=/home/bot/.lark-channel
  docker exec \
    -e LARK_CHANNEL=1 \
    -e LARK_CHANNEL_PROFILE="$name" \
    -e LARK_CHANNEL_HOME="$home" \
    -e LARK_CHANNEL_CONFIG="$home/profiles/$name/lark-cli-source/config.json" \
    -e LARKSUITE_CLI_CONFIG_DIR="$home/profiles/$name/lark-cli" \
    "lark-bot-$name" lark-cli "$@"
}

cmd_authorize() {
  local name="${1:-}"; shift || true
  check_name "$name"
  local c="lark-bot-$name"
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] \
    || die "$c is not running; start it with ./lark-bots.sh restart $name"
  local scope_args=("$@")

  step "Connecting the owner's Lark account to $name"
  # The bridge links lark-cli to the bot's app when it starts; wait for that.
  local i
  for i in $(seq 1 30); do
    docker exec "$c" test -f "/home/bot/.lark-channel/profiles/$name/lark-cli/lark-channel/config.json" && break
    [ "$i" -lt 30 ] || die "the bot hasn't linked lark-cli yet; check ./lark-bots.sh logs $name"
    sleep 2
  done

  local mode
  mode="$(profile_mode "$name")"
  [ "$mode" != team ] \
    || die "$name is a team bot: it only ever uses its own Lark identity, so it can't act as a person"

  # Until a personal login exists, the bridge keeps lark-cli in strict "bot" mode, which
  # also refuses to start a login. Lift it for the login; on the restart at the end the
  # bridge sees the new login and sets the final policy itself.
  bot_lark_cli "$name" config strict-mode off >/dev/null 2>&1 \
    || warn "couldn't turn off lark-cli strict mode; the login may be refused"

  # Explicit options: one link with exactly those.
  if [ "${#scope_args[@]}" -gt 0 ]; then
    authorize_round "$name" "" "${scope_args[@]}" || return 1
    authorize_finish "$name" ""
    return
  fi

  # Default: request exactly the user permissions enabled on the app, so what the owner
  # approves matches what the app allows. Lark accepts at most $MAX_SCOPES_PER_LINK
  # permissions per link, so a bigger list is split over several links.
  local scopes count
  scopes="$(bot_lark_cli "$name" auth scopes --json 2>/dev/null | docker exec -i "$c" node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const j = JSON.parse(s.slice(s.indexOf("{")));
        const list = Array.isArray(j.userScopes) ? j.userScopes : [];
        if (!list.length) process.exit(1);
        console.log(list.join("\n"));
      } catch { process.exit(1); }
    });')" || die "couldn't read the app's permissions (lark-cli auth scopes); pass --domain ... instead"
  count="$(wc -l <<<"$scopes" | tr -d ' ')"

  local links=$(( (count + MAX_SCOPES_PER_LINK - 1) / MAX_SCOPES_PER_LINK ))
  local per=$(( (count + links - 1) / links ))
  echo "Requesting all $count user permissions enabled on the app$( [ "$links" -gt 1 ] && echo ", over $links links of up to $per (Lark's limit is $MAX_SCOPES_PER_LINK per link)")."
  echo "To request fewer: ./lark-bots.sh authorize $name --domain calendar,mail"

  local k batch
  for (( k = 0; k < links; k++ )); do
    batch="$(sed -n "$(( k * per + 1 )),$(( (k + 1) * per ))p" <<<"$scopes" | tr '\n' ' ')"
    authorize_round "$name" "$( [ "$links" -gt 1 ] && echo "Link $((k + 1)) of $links: " )" --scope "$batch" || return 1
  done
  authorize_finish "$name" "$count"
}

MAX_SCOPES_PER_LINK=250   # measured 2026-10-19: 250 accepted, 260 rejected ("too many scopes")

# One authorization link: start it, show it, wait for the owner to approve.
authorize_round() {
  local name="$1" label="$2"; shift 2
  local c="lark-bot-$name"
  local out parsed url code
  out="$(bot_lark_cli "$name" auth login --no-wait --json "$@" 2>&1)" \
    || die "lark-cli couldn't start the authorization: $out"
  # Parse in the container: the host may not have node.
  parsed="$(printf '%s' "$out" | docker exec -i "$c" node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let j; try { j = JSON.parse(s.slice(s.search(/[[{]/))); } catch { process.exit(1); }
      const pick = (o, keys) => { for (const k of keys) if (o && typeof o[k] === "string" && o[k]) return o[k]; };
      const data = j.data && typeof j.data === "object" ? j.data : j;
      const url = pick(data, ["verification_uri_complete", "verificationUriComplete", "verification_url", "verificationUrl", "verification_uri", "verificationUri", "url"]);
      const code = pick(data, ["device_code", "deviceCode"]);
      if (!url || !code) process.exit(1);
      console.log(url + "\t" + code);
    });')" || die "unexpected output from lark-cli auth login: $out"
  url="${parsed%%$'\t'*}"
  code="${parsed#*$'\t'}"

  echo
  echo "${label}The bot's owner opens this link (or scans the QR code with the Lark app),"
  echo "signs in as themselves and approves. You can also send them the link in Lark."
  echo
  echo "  $url"
  echo
  docker exec "$c" node -e '
    try {
      require("/usr/local/lib/node_modules/lark-channel-bridge/node_modules/qrcode-terminal")
        .generate(process.argv[1], { small: true });
    } catch {}' "$url" || true
  echo "Waiting for approval (up to 10 minutes; Ctrl+C to stop waiting)..."

  local result
  trap ':' INT
  result="$(bot_lark_cli "$name" auth login --device-code "$code" --json 2>&1)" || {
    trap - INT
    warn "authorization not completed: $result"
    return 1
  }
  trap - INT
  echo "Approved."
}

# After the last link: restart so the bridge switches the bot to the owner's identity,
# then report what the owner actually granted.
authorize_finish() {
  local name="$1" expected="$2"
  bot_compose "$name" up -d --force-recreate >/dev/null 2>&1
  sleep 5
  local status granted
  status="$(owner_auth "$name")" || { warn "connected, but couldn't read lark-cli auth status"; return; }
  granted="$(cut -f3 <<<"$status")"
  echo "Connected as $(cut -f1 <<<"$status") (token: $(cut -f2 <<<"$status")), $granted permissions granted."
  if [ -n "$expected" ] && [ "$granted" -lt "$expected" ]; then
    warn "the app enables $expected; Lark kept $granted. If that's about one link's worth, Lark"
    warn "replaced earlier approvals instead of adding to them: remove permissions the bot"
    warn "doesn't need from the app (to $MAX_SCOPES_PER_LINK or fewer) and run authorize again."
  fi
}

# "<user>\t<token status>\t<number of granted permissions>" for the owner's Lark login
owner_auth() {
  local name="$1"
  bot_lark_cli "$name" auth status --json 2>/dev/null | docker exec -i "lark-bot-$name" node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const u = JSON.parse(s.slice(s.indexOf("{"))).identities.user;
        if (!u || !u.userName) process.exit(1);
        const n = typeof u.scope === "string" ? u.scope.split(/\s+/).filter(Boolean).length : 0;
        console.log(u.userName + "\t" + (u.tokenStatus || u.status || "?") + "\t" + n);
      } catch { process.exit(1); }
    });'
}

cmd_status() {
  local name="${1:-}"
  check_name "$name"
  [ -e "$DIR/bots/$name.env" ] || die "no bot named $name"
  local c="lark-bot-$name" state auth
  state="$(docker inspect -f '{{.State.Status}} since {{.State.StartedAt}} · restarts: {{.RestartCount}}' "$c" 2>/dev/null || echo "no container")"
  echo "Container:  $state"
  echo "Claude:     $(claude_source "$name")"
  if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" != true ]; then
    echo "Owner's Lark account: unknown (bot not running; ./lark-bots.sh restart $name)"
    return
  fi
  docker stats --no-stream --format 'Resources:  CPU {{.CPUPerc}} · memory {{.MemUsage}}' "$c"
  if auth="$(owner_auth "$name")"; then
    echo "Owner's Lark account: $(cut -f1 <<<"$auth") · token $(cut -f2 <<<"$auth") · $(cut -f3 <<<"$auth") permissions granted"
  else
    echo "Owner's Lark account: not connected (./lark-bots.sh authorize $name)"
  fi
}

cmd_list() {
  local names=() n
  while IFS= read -r n; do names+=("$n"); done < <(bot_names)
  [ "${#names[@]}" -gt 0 ] || { echo "no bots yet: ./lark-bots.sh add <name>"; return; }
  docker ps -a --filter "name=^lark-bot-" --format 'table {{.Names}}\t{{.Status}}'
  local running
  running="$(docker ps --filter "name=^lark-bot-" --format '{{.Names}}')"
  [ -z "$running" ] || docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' $running
  echo
  printf '%-24s %s\n' BOT CLAUDE
  for n in "${names[@]}"; do printf '%-24s %s\n' "$n" "$(claude_source "$n")"; done
}

cmd_logs() {
  check_name "${1:-}"
  docker logs -f --tail 100 "lark-bot-$1"
}

cmd_restart() {
  local target="${1:-}" n
  [ -n "$target" ] || die "usage: ./lark-bots.sh restart <name|all>"
  if [ "$target" = all ]; then
    for n in $(bot_names); do bot_compose "$n" up -d --force-recreate; done
  else
    check_name "$target"
    [ -e "$DIR/bots/$target.env" ] || die "no bot named $target"
    bot_compose "$target" up -d --force-recreate
  fi
}

cmd_update() {
  cmd_build
  local n
  for n in $(bot_names); do
    step "Restarting $n on the new image"
    bot_compose "$n" up -d
  done
}

cmd_remove() {
  local name="" purge=0 yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge) purge=1; shift ;;
      --yes)   yes=1; shift ;;
      *) name="$1"; shift ;;
    esac
  done
  check_name "$name"
  if [ "$yes" -eq 0 ]; then
    local answer
    read -rp "Type '$name' to remove this bot$( [ $purge -eq 1 ] && echo ' AND delete its data' ): " answer
    [ "$answer" = "$name" ] || die "cancelled"
  fi
  [ -e "$DIR/bots/$name.env" ] || printf 'BOT=%s\n' "$name" > "$DIR/bots/$name.env"
  if [ "$purge" -eq 1 ]; then
    bot_compose "$name" down -v
    rm -f "$DIR/bots/$name.env" "$DIR/bots/$name.claude.env"
    echo "removed $name and its data"
  else
    bot_compose "$name" down
    rm -f "$DIR/bots/$name.env"
    echo "removed $name; its data is kept in volume lark-bot-$name-home"
  fi
  echo "Delete the Lark app in the Lark developer console if it is no longer needed."
}

require_running() {
  check_name "$1"
  [ "$(docker inspect -f '{{.State.Running}}' "lark-bot-$1" 2>/dev/null)" = true ] \
    || die "lark-bot-$1 is not running; start it with ./lark-bots.sh restart $1"
}

cmd_set_instructions() {
  local name="" force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1; shift ;;
      -*) fail "$EXIT_ARGS" "unknown option: $1" ;;
      *) name="$1"; shift ;;
    esac
  done
  require_running "$name"
  if [ "$force" -eq 0 ] && docker exec "lark-bot-$name" test -s /home/bot/workspace/CLAUDE.md; then
    echo "$name already has a CLAUDE.md; kept (use --force to replace it)"
    return
  fi
  docker exec -i "lark-bot-$name" sh -c 'cat > "$HOME/workspace/CLAUDE.md.tmp" && mv "$HOME/workspace/CLAUDE.md.tmp" "$HOME/workspace/CLAUDE.md"'
  echo "wrote $name's CLAUDE.md"
}

# GET only: the provisioner uses it to see what a department bot can read.
cmd_bot_get() {
  local name="${1:-}" path="${2:-}" params="${3:-}"
  require_running "$name"
  [[ "$path" =~ ^/open-apis/[A-Za-z0-9/_.-]+$ ]] || fail "$EXIT_ARGS" "path must look like /open-apis/..."
  if [ -n "$params" ]; then
    bot_lark_cli "$name" api GET "$path" --params "$params" --as bot
  else
    bot_lark_cli "$name" api GET "$path" --as bot
  fi
}

# A text DM from the bot to one person, by email; the text comes on stdin. The provisioner
# uses it for the bot's welcome once the bot can answer.
cmd_bot_message() {
  local name="${1:-}" email="${2:-}" text body home=/home/bot/.lark-channel
  require_running "$name"
  [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] \
    || fail "$EXIT_ARGS" "usage: ./lark-bots.sh bot-message <name> <email>  (message text on stdin)"
  text="$(cat)"
  [ -n "$text" ] || fail "$EXIT_ARGS" "no message text on stdin"
  # JSON is built in the container: the host may not have node.
  body="$(printf '%s' "$text" | docker exec -i "lark-bot-$name" node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => process.stdout.write(JSON.stringify(
      { receive_id: process.argv[1], msg_type: "text", content: JSON.stringify({ text: s }) })));' "$email")"
  printf '%s' "$body" | docker exec -i \
    -e LARK_CHANNEL=1 \
    -e LARK_CHANNEL_PROFILE="$name" \
    -e LARK_CHANNEL_HOME="$home" \
    -e LARK_CHANNEL_CONFIG="$home/profiles/$name/lark-cli-source/config.json" \
    -e LARKSUITE_CLI_CONFIG_DIR="$home/profiles/$name/lark-cli" \
    "lark-bot-$name" lark-cli api POST /open-apis/im/v1/messages --params '{"receive_id_type":"email"}' --data - --as bot
}

# The provisioner runs as this folder's owner with the docker group, so the files it writes
# under bots/ and claude-accounts/ stay ours (provisioner.yaml).
cmd_provisioner() {
  local sub="${1:-}" gid
  [ -f "$DIR/provisioner.env" ] \
    || die "provisioner.env is missing: copy provisioner.env.example to provisioner.env, fill it in, chmod 600"
  gid="$(getent group docker | cut -d: -f3)"
  [ -n "$gid" ] || die "this host has no docker group"
  export HOST_UID; HOST_UID="$(id -u)"
  export DOCKER_GID="$gid" LARK_BOTS_DIR="$DIR"
  case "$sub" in
    start)
      ensure_image
      docker compose -f "$DIR/provisioner.yaml" up -d --build
      sleep 5
      docker logs --tail 20 lark-provisioner 2>&1 || true
      ;;
    check)
      # Reads the Base and the approval group once; with a recipient, sends them a preview card.
      ensure_image
      docker compose -f "$DIR/provisioner.yaml" build -q
      docker compose -f "$DIR/provisioner.yaml" run --rm -T provisioner \
        lark-channel-bridge provisioner --check ${2:+--card-to "$2"}
      ;;
    stop) docker compose -f "$DIR/provisioner.yaml" down ;;
    logs) docker logs -f --tail 100 lark-provisioner ;;
    *) fail "$EXIT_ARGS" "usage: ./lark-bots.sh provisioner <start|check [email]|stop|logs>" ;;
  esac
}

# ─── Main ────────────────────────────────────────────────────────────────────

case "${1:-}" in -h|--help|"") usage 0 ;; esac
command -v docker >/dev/null || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose is not available"

case "${1:-}" in
  build)      shift; cmd_build ;;
  set-claude) shift; cmd_set_claude "$@" ;;
  claude-account) shift; cmd_claude_account "$@" ;;
  use-claude) shift; cmd_use_claude "$@" ;;
  provisioner) shift; cmd_provisioner "$@" ;;
  set-instructions) shift; cmd_set_instructions "$@" ;;
  bot-get)    shift; cmd_bot_get "$@" ;;
  bot-message) shift; cmd_bot_message "$@" ;;
  add)        shift; cmd_add "$@" ;;
  authorize)  shift; cmd_authorize "$@" ;;
  set-mode)   shift; cmd_set_mode "$@" ;;
  set-access) shift; cmd_set_access "$@" ;;
  status)     shift; cmd_status "$@" ;;
  list)       shift; cmd_list ;;
  logs)       shift; cmd_logs "$@" ;;
  restart)    shift; cmd_restart "$@" ;;
  update)     shift; cmd_update ;;
  remove)     shift; cmd_remove "$@" ;;
  -h|--help|"") usage 0 ;;
  *) die "unknown command: $1 (see --help)" ;;
esac
