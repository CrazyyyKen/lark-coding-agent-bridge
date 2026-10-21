# Per-person Lark sign-in for team bots

Status: deployed 2026-10-21 and **on for `gdex-ai`** (17:21; config backup `config.json.bak-perUserLogin` in the container). New team bots get it automatically (`lark-bots.sh add --mode team`, `set-mode <name> team`, `new-instance.sh --mode team`). Trial results below are from `lark-bot-gdex-ai` on `10.80.0.29`, 2026-10-20.

## Why

On 2026-10-20 the team bot `gdex-ai` held one person's Lark token (Goh Ken How's) in its shared login folder, set to act as that user. The agent had signed him in and switched the identity policy itself, following its built-in OAuth instructions. From then on, every member who chatted with the bot read and wrote Lark **as Ken How**. The logs show another member asking for Ken How's and other colleagues' calendars. lark-cli also keeps one user per login folder, so each new sign-in replaced the previous person's. That is why members kept getting sign-in links.

## What changed

Each layer is listed with where it lives.

| Layer | What it does | Code |
|---|---|---|
| Per-person folders | With `team.perUserLogin` on, each person who DMs the bot gets their own lark-cli login folder (`<profile>/users/<open_id>/lark-cli`), working folder (`<workspace>/.lark-users/<open_id>`), attachment cache and therefore session history. The bridge picks them from the message's sender; the agent never chooses. `/cd` doesn't apply to these runs. | [per-user-login.ts](../src/lark-cli/per-user-login.ts), [channel.ts](../src/bot/channel.ts) |
| Bridge-owned sign-in | First DM: a welcome with a sign-in link asking for every user permission enabled on the app (`--domain all`), sent once. `/login`, `/logout`, `/whoami` in DMs. The bridge waits for approval in the background and keeps the token **only if the Lark account that approved is the sender**; a forwarded link opened by someone else is discarded. | [per-user-login.ts](../src/lark-cli/per-user-login.ts), [user-login.ts](../src/commands/user-login.ts) |
| Per-run block list | Every team-mode run gets a Claude Code `--settings` file. A person's run can't read or edit the bridge home (`~/.lark-channel`: every login folder, logs, shared media, config), lark-cli's credential store (`~/.local/share/lark-cli`), any session history (`~/.claude/projects`), or anyone else's working folder. Group/comment/meeting runs can't reach personal folders, session histories, logs or the credential store. No run may run `lark-cli auth login/logout`, `lark-cli config …`, `--profile`, `env` or `export`. | [identity-settings.ts](../src/agent/claude/identity-settings.ts) |
| Agent instructions | Team-mode runs get team rules instead of the OAuth section: never sign anyone in or switch identity; act only for the sender; **show a draft and wait for explicit confirmation before sending messages, mail, approvals, invites or sharing as the user**. | [bridge-system-prompt.ts](../src/agent/bridge-system-prompt.ts) |
| Bot-only elsewhere | Group chats, doc-comment replies and meetings always use the bot's own identity. | [comments.ts](../src/bot/comments.ts), [orchestrator.ts](../src/meeting/orchestrator.ts) |
| Shared folder kept clean | A team bot logs any personal token out of its shared login folder at start-up. | [preflight.ts](../src/cli/preflight.ts) |
| Access ceiling | Team bots are capped at `workspace` access; `full` would give every member an unrestricted shell. | [run-policy.ts](../src/policy/run-policy.ts) |
| `/resume` | Lists only the sender's own sessions. On a team bot without per-person folders it is admin-only (it used to list, and let anyone resume, every member's DM sessions). | [commands/index.ts](../src/commands/index.ts) |
| Credential store | `~/.local/share/lark-cli` added to the deny list in both workspace settings templates, so personal bots are covered too. | [workspace-settings.json](../deploy/docker/workspace-settings.json) |

Concurrency is unchanged: several people can be signed in at once and their runs can overlap, limited only by `maxConcurrentRuns`, container memory and the Claude account's rate limit.

## Turning it on

The Docker image installs the bridge packed from this repo ([Packing the bridge](../deploy/docker/README.md#packing-the-bridge)), so pack and rebuild after changes.

Bots created or switched to team mode with the scripts have it on already. For a team bot made before that (Claude agent only):

```bash
docker exec lark-bot-<name> node -e '
  const fs = require("fs"), f = "/home/bot/.lark-channel/config.json";
  const c = JSON.parse(fs.readFileSync(f, "utf8")), p = c.profiles[process.argv[1]];
  p.team = { ...(p.team || {}), perUserLogin: true };
  fs.writeFileSync(f + ".tmp", JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(f + ".tmp", f);' <name>
./lark-bots.sh restart <name>
```

Optional `team` settings: `loginDomains` (default `["all"]`) narrows what the sign-in link asks for; `loginExclude` drops specific scopes.

## Trial results (2026-10-20, `gdex-ai`, Claude Code 2.1.303, lark-cli 1.0.98)

All checks ran in throwaway `/tmp` folders inside the container, which were deleted afterwards. No real user data was read.

| Check | Result |
|---|---|
| A fresh per-person folder can use the app's stored secret | **Yes.** `config bind --source lark-channel --identity user-default` in an empty folder succeeded and the bot identity was ready. The folder holds only `config.json` and `update-state.json`; the app secret is a reference (`keychain`, `appsecret:cli_…`). |
| Where credentials live | In lark-cli's file-backed keychain, `~/.local/share/lark-cli`, shared by every login folder on the machine. It was **not** on any deny list before this change; it is now. That user tokens are stored there too is inferred, not yet observed; confirm on the first real sign-in. |
| Block list stops file reads | **Yes.** The Read tool on a blocked folder was denied; `cat` was denied (Bash allows only `lark-cli` and `date`). This Claude Code build has no Grep tool. |
| A setting in front of the command gets past the `lark-cli`-only rule | **No.** `LARKSUITE_CLI_CONFIG_DIR=/x lark-cli …` needed approval, which `-p` mode refuses; `env …` was denied by rule. `lark-cli config`, `auth login`, `--profile` were denied. |
| Project settings in a new folder | **Ignored.** Claude Code didn't apply `Bash(lark-cli:*)` from the project settings of a folder it hadn't trusted, so `lark-cli` was refused. Fixed: per-person runs carry the shared workspace's allow/deny rules in `--settings`; re-tested, `lark-cli` and `date` allowed, bypasses still denied. |

## Still to check

1. **Bot's own permissions and data range (developer console).** lark-cli only lists *user* scopes. In the developer console, review the app's **tenant** scopes and data range. Any company-wide read permission (mail, calendar, contacts, Drive) lets anyone pull anyone's data through the bot identity, with no personal sign-in at all. Trim to what is safe for every member.
2. **How long a sign-in lasts.** The app has `offline_access`, so lark-cli can refresh tokens, but the refresh lifetime is unmeasured. Sign in once, then check `/whoami` daily to see when it lapses.
3. **First real sign-in end to end.** On the trial bot, DM it from two accounts: welcome link → approve → `/whoami`; check that the token lands in `~/.local/share/lark-cli` and that each person sees only their own calendar.
4. **The old token on `gdex-ai`.** Ken How's token is still in the shared folder. Deploying this logs it out on start-up. Until then, remove it by hand (a restart alone only resets the policy, and the current agent can flip it back):

   ```bash
   docker exec -e LARK_CHANNEL=1 -e LARK_CHANNEL_PROFILE=gdex-ai \
     -e LARK_CHANNEL_HOME=/home/bot/.lark-channel \
     -e LARK_CHANNEL_CONFIG=/home/bot/.lark-channel/profiles/gdex-ai/lark-cli-source/config.json \
     -e LARKSUITE_CLI_CONFIG_DIR=/home/bot/.lark-channel/profiles/gdex-ai/lark-cli \
     lark-bot-gdex-ai lark-cli auth logout
   ./lark-bots.sh restart gdex-ai
   ```

## Known limits

- **A fence, not a wall.** The block list is Claude Code permission rules. It holds against the agent's own tools (tested above), but every run is still the same Linux user in one container. The stronger option is running each person's runs in their own sandbox (separate Linux user or container holding only their folders). Do that before handling especially sensitive data.
- **Confirm-before-send is an instruction**, not enforced by code. Hidden instructions in a document someone shares can still try to make the agent act with the reader's token; the instruction and the deny list reduce this but don't eliminate it.
- **Claude only.** Codex bots don't get per-person sign-in or the block list (Codex has no per-path deny rules); a team Codex bot stays bot-only by preflight alone.
- **Server admins** (anyone with Docker access on the server) can use any stored token. Say so in the welcome policy.
