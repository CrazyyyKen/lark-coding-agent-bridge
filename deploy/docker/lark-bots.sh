#!/usr/bin/env bash
# Run Lark bots in containers, one container per bot, without changing the host.
# Needs only Docker with Compose and membership of the docker group.
#
#   ./lark-bots.sh build                 Build the bot image (once, and after updates)
#   ./lark-bots.sh set-claude            Save the shared Claude credential ("sign in once")
#   ./lark-bots.sh add <name> [options]  Create a bot: QR code or --app-id, settings, start
#   ./lark-bots.sh authorize <name> [lark-cli auth login options]
#                                        Show the link (and QR code) the owner opens to let
#                                        the bot act as them. Default: every user permission
#                                        enabled on the app; narrow with e.g. --domain calendar,mail
#   ./lark-bots.sh status <name>         One bot: container state, resources, owner's Lark account
#   ./lark-bots.sh list                  Show every bot, its state and memory use
#   ./lark-bots.sh logs <name>           Follow a bot's log
#   ./lark-bots.sh restart <name|all>    Restart one bot or all of them
#   ./lark-bots.sh update                Rebuild the image and restart every bot on it
#   ./lark-bots.sh remove <name> [--purge]
#                                        Stop and delete a bot; --purge also deletes its data
#
# Options for add:
#   --app-id <cli_xxx>       Use an existing Lark app (asks for its App Secret).
#                            Without it a QR code is shown; whoever scans it owns the new app.
#   --tenant <lark|feishu>   Tenant for --app-id. Default: lark
#   --mode <personal|team>   personal: answers only the app owner, may use the owner's Lark
#                            login. team: anyone may use it, bot identity only. Default: personal
#   --access <workspace|read-only|full>
#                            Claude Code permission level. Default: workspace

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="lark-bot:latest"
CFG=/home/bot/.lark-channel/config.json

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

check_name() {
  [[ "${1:-}" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || die "bot name must be 2-31 characters: lowercase letters, digits and '-', starting with a letter"
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

# ─── Commands ────────────────────────────────────────────────────────────────

cmd_build() {
  step "Building $IMAGE"
  docker build --pull -t "$IMAGE" "$DIR"
  docker image ls "$IMAGE"
}

cmd_set_claude() {
  step "Shared Claude credential"
  cat <<'EOF'
Every bot without its own sign-in uses this credential.

  1  Claude subscription token: run `claude setup-token` once (on your laptop, or here with
     `docker run --rm -it lark-bot:latest claude setup-token`) and paste the token it prints.
  2  Anthropic API key from the Claude Console.
EOF
  local choice var value
  read -rp "Choose 1 or 2: " choice
  case "$choice" in
    1) var=CLAUDE_CODE_OAUTH_TOKEN ;;
    2) var=ANTHROPIC_API_KEY ;;
    *) die "cancelled" ;;
  esac
  read -rsp "Paste it (input hidden): " value; echo
  [ -n "$value" ] || die "nothing entered"
  (umask 077; printf '%s=%s\n' "$var" "$value" > "$DIR/claude.env")
  echo "saved $DIR/claude.env (mode 600). Restart running bots to use it: ./lark-bots.sh restart all"
}

cmd_add() {
  local name="" app_id="" tenant="lark" mode="personal" access="workspace"
  while [ $# -gt 0 ]; do
    case "$1" in
      --app-id) app_id="${2:-}"; shift 2 ;;
      --tenant) tenant="${2:-}"; shift 2 ;;
      --mode)   mode="${2:-}"; shift 2 ;;
      --access) access="${2:-}"; shift 2 ;;
      -*) die "unknown option: $1" ;;
      *)  [ -z "$name" ] || die "only one bot name expected"; name="$1"; shift ;;
    esac
  done
  check_name "$name"
  [[ "$tenant" =~ ^(lark|feishu)$ ]] || die "--tenant must be lark or feishu"
  [[ "$mode" =~ ^(personal|team)$ ]] || die "--mode must be personal or team"
  [[ "$access" =~ ^(workspace|read-only|full)$ ]] || die "--access must be workspace, read-only or full"
  [ ! -e "$DIR/bots/$name.env" ] || die "bot '$name' already exists"
  docker volume inspect "lark-bot-$name-home" >/dev/null 2>&1 \
    && die "a data volume lark-bot-$name-home is left from an earlier bot; remove it with ./lark-bots.sh remove $name --purge"

  ensure_image
  mkdir -p "$DIR/bots"
  printf 'BOT=%s\n' "$name" > "$DIR/bots/$name.env"
  trap 'warn "setup stopped part-way; clean up with: ./lark-bots.sh remove '"$name"' --purge"' ERR

  step "Checking the container's hostname (the bridge's encryption key depends on it)"
  local host
  host="$(bot_compose "$name" run --rm -T bot hostname | tr -d '\r')"
  [ "$host" = "lark-bot-$name" ] || die "container hostname is '$host', expected lark-bot-$name"
  echo "ok: $host"

  step "Connecting the Lark app"
  if [ -n "$app_id" ]; then
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
    p.permissions = { defaultAccess: access, maxAccess: access };
    p.preferences = { ...(p.preferences || {}), maxConcurrentRuns: 1 };
    fs.writeFileSync(file + ".tmp", JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  ' "$CFG" "$name" "$mode" "$access"
  echo "ok"

  step "Claude sign-in"
  if [ -f "$DIR/claude.env" ] || [ -f "$DIR/bots/$name.claude.env" ]; then
    echo "using the saved credential"
  else
    echo "No shared credential yet (./lark-bots.sh set-claude). Signing this bot in by itself:"
    echo "type /login, choose your Claude account, open the link, paste the code back, then /exit."
    # Ctrl+C here should end Claude Code only, not the rest of the setup.
    trap ':' INT
    bot_compose "$name" run --rm bot claude || true
    trap - INT
  fi
  local reply
  if reply="$(bot_compose "$name" run --rm -T bot timeout 90 claude -p "Reply with the single word OK" 2>&1)"; then
    echo "Claude: $reply"
  else
    warn "Claude did not answer: $reply"
    warn "fix the sign-in, then: ./lark-bots.sh restart $name"
  fi

  step "Starting lark-bot-$name"
  bot_compose "$name" up -d
  sleep 10
  docker ps --filter "name=^lark-bot-$name\$" --format '{{.Names}}: {{.Status}}'
  docker logs --tail 15 "lark-bot-$name" 2>&1 || true
  trap - ERR

  local authorized=0
  if [ "$mode" = personal ]; then
    local answer
    read -rp "Connect the owner's Lark account now (mail, calendar, docs)? [Y/n] " answer
    if [[ ! "$answer" =~ ^[Nn] ]]; then
      cmd_authorize "$name" && authorized=1 || warn "not connected; run ./lark-bots.sh authorize $name later"
    fi
  fi

  echo
  echo "Done: $name"
  echo "  1. The owner DMs the bot \"hi\" in Lark, then \"/status\"."
  if [ "$mode" = personal ] && [ "$authorized" -eq 0 ]; then
    echo "  2. To connect their own Lark account: ./lark-bots.sh authorize $name"
    echo "     (or they ask the bot something personal in a DM and approve the link it sends)."
  fi
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
  local name="" purge=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge) purge=1; shift ;;
      *) name="$1"; shift ;;
    esac
  done
  check_name "$name"
  local answer
  read -rp "Type '$name' to remove this bot$( [ $purge -eq 1 ] && echo ' AND delete its data' ): " answer
  [ "$answer" = "$name" ] || die "cancelled"
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

# ─── Main ────────────────────────────────────────────────────────────────────

case "${1:-}" in -h|--help|"") usage 0 ;; esac
command -v docker >/dev/null || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "docker compose is not available"

case "${1:-}" in
  build)      shift; cmd_build ;;
  set-claude) shift; cmd_set_claude ;;
  add)        shift; cmd_add "$@" ;;
  authorize)  shift; cmd_authorize "$@" ;;
  status)     shift; cmd_status "$@" ;;
  list)       shift; cmd_list ;;
  logs)       shift; cmd_logs "$@" ;;
  restart)    shift; cmd_restart "$@" ;;
  update)     shift; cmd_update ;;
  remove)     shift; cmd_remove "$@" ;;
  -h|--help|"") usage 0 ;;
  *) die "unknown command: $1 (see --help)" ;;
esac
