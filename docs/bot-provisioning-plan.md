# Bot provisioning: from request form to running bot

Status: Phase 1 deployed 2026-10-22; Phases 2–5 built, the provisioner waits for its own Lark app (§7). Base: [AI Agent Requests](https://gdexgroup.sg.larksuite.com/base/Ej2rbuVelaxD7xsLa4EllBP6gph). Builds on [department-agents-plan.md](department-agents-plan.md) (architecture, isolation, billing) and [deploy/docker/SETUP.md](../deploy/docker/SETUP.md) (how a bot is created by hand today).

## 1. Goal

Anyone who wants a Lark agent follows the [request guide](https://gdexgroup.sg.larksuite.com/wiki/NYRWwPSsYirbBokuOhBlAROzghe), fills in one Lark form, and gets a running bot once someone in the AI Team group taps **Approve**. Nobody runs `lark-bots.sh` by hand for a normal request.

| Today | After |
|---|---|
| Requester sends App ID and Secret to a person in chat | Requester submits a form; the request lands in a Base |
| An operator SSHes to the server and answers `lark-bots.sh add` prompts | An approval card in the AI Team group; **Approve** provisions the bot |
| Nobody tracks which bot runs on which Claude account | A Base table of Claude accounts, with seat counts checked before approving |

## 2. Flow

```
Step 0: the agent needs a Claude account (the requester's seat or the department's).
No seat yet → the department raises a Purchase Requisition (PR guide); the AI Team
adds the seat once it is approved. Nobody submits the form without one.
        │
        ▼
Requester follows the guide: creates the agent (bot, events and callbacks come preset),
adds AI subscription as Administrator, publishes, Lark admin approves the version
        │
        ▼
Lark form ──► Base "AI Agent Requests"   Status = Submitted
                    │  provisioner polls every minute
                    ▼
     Approval card in the AI Team group (oc_f803a6d76d71872a15dbba9a5a92fda0)
     Claude: (•) Seat [requester's account from the form ▾]  ( ) API key [▾ / paste]
     [Approve]  [Reject + reason]
                    │ Approve
                    ▼
     Checks: App ID + Secret get a token · app owner = form submitter · seat count
                    │ ok                                  │ secret wrong
                    ▼                                      ▼
     lark-bots.sh add --yes --json               Card: [Open app credentials] (console, as
     smoke test · Status = Ready                  ai@gdexpress.com) + secret input + [Retry]
                    │
                    ├─ seat has no token yet ─► Claude sign-in card to the seat holder:
                    │                           open link · approve · paste code → token saved,
                    │                           bot restarted (again 30 days before expiry)
                    ▼
     Card shows ✅ · the new bot DMs its owner · Base automation tells the requester
```

## 3. Components

### 3.1 Base "AI Agent Requests" and its form

One Base with four tables (Requests, Claude Accounts, Events, Settings), created 2026-10-21 by Joe; ownership can move to `ai@gdexpress.com`. The provisioner reads the default Claude account and "Team seats bought" from **Settings**; the approval group comes from its own config, not the Base, so a Base editor can't redirect the cards.

**Requests** (the form writes here):

| Field | Type | In form | Notes |
|---|---|---|---|
| Bot type | Single select: Personal / Department | Yes | Decides which questions show next (form display conditions) |
| Requester | Created by (system) | Auto | The form only accepts signed-in org members, so this can't be faked |
| Agent name | Text | Yes | The name the requester gave the app, e.g. "Ali's AI Agent" |
| App ID | Text | Yes | Help text: "Developer Console → your app → Credentials & Basic Info. Starts with `cli_`, e.g. `cli_a1b2c3d4e5f6a7b8`" |
| App Secret | Text | Yes | Help text: "Same page, under App ID. 32 characters: click the eye icon, then copy. Paste only here." Hidden from everyone but the provisioner (field permissions); cleared once stored on the server |
| Confirmations | Checkboxes | Yes | "AI subscription added as Administrator" · "My Lark admin approved the app version" · "This agent has a Claude account (the PR is approved)". All three needed; the card flags a request with fewer |
| Claude account email | Text | Yes | The seat the agent will use: the requester's own or the department's (e.g. `hr@gdexpress.com`). Missing → the card blocks Approve |
| Claude account holder | Person | Yes | Who signs in to that seat; the Connect Claude card goes to them (§5.3) |
| Department | Single select | Department only | |
| Purpose | Long text | Department only | What it should answer and do, for whom |
| Who will use it | Person / department | Department only | Must match the app's availability |
| Documents | Long text (one link per line) | Department only | Help text: only content every member may see |
| Wiki pages / spaces | Long text (one link per line) | Department only | |
| Group chats | Long text | Department only | Groups the bot should join |
| Sensitivity confirmation | Checkbox | Department only | "Everything listed may be seen by every member of the department" |
| Status | Single select | No | Submitted · Carded · Approved · Provisioning · Waiting for Claude · Ready · Knowledge setup (department) · Live · Rejected · Failed |
| Claude account | Link → Claude Accounts | No | Chosen on the card at Approve: a seat (default `ai@gdexpress.com`) or an API key (§5.2); editable in the card or here |
| Server bot name | Text | No | `<email prefix>` for personal, `dept-<slug>` for department, suffix if taken |
| Approver, Decided at, Reject reason | Person, date, text | No | |
| Card message ID, Provision log | Text | No | Provisioner bookkeeping |

**Claude Accounts** (§5): one row per Claude login the bots can use.

**Events**: append-only log of every card click and provisioning step (who, when, what), so the Base is the audit trail.

**Base automations** (no code) send the requester's messages from Base's own assistant, which can reach anyone in the company whatever the provisioner app's availability: "request received" on submit, "rejected: <reason>", and "your agent is ready, say hi to it".

### 3.2 Provisioner service (new, in this repo)

A small Node service, built into the same image as the bridge and run as one more container (`lark-provisioner`, `lark-channel-bridge provisioner`, code in `src/provisioner/`) on the bot server. It mounts the Docker socket and the `lark-bots` folder, and does all its work through `lark-bots.sh`, so it only ever touches `lark-bot-*` containers (never gdocr or n8n).

It has its own Lark custom app, "AI Agent Admin": bot enabled, persistent connection, `card.action.trigger` callback, Base read/write, send message, read chat members. It is a member of the AI Team group and a collaborator on the Base.

| Job | How |
|---|---|
| Find new requests | Poll Requests every minute for Status = Submitted. Polling catches up on anything submitted while the service was down; Base change events would need a subscription per file and still need a catch-up pass |
| Post the approval card | Requester, type, agent name, App ID, department answers. Never the secret. User text escaped so it can't inject card markup |
| Who may click | Anyone who is a member of the AI Team group at click time (checked against the chat's member list), and only on the card in that group, so a forwarded card can't approve |
| Approve | Lock the record (Status = Approved), run the checks, provision, update the card at each step. A second click or a second approver sees "already being handled" |
| Reject | Card input for the reason; Status = Rejected; Base automation tells the requester |
| Failed | Card shows the step that failed and **Retry**. For a bad secret, also **Open app credentials** (`https://open.larksuite.com/app/<app_id>/baseinfo`, opened as `ai@gdexpress.com`) and a secret input; the corrected secret goes straight from the card to the provisioner and is never written to Base |

**Checks before creating anything:**

1. App ID and Secret get a tenant token (`validateAppCredentials` already exists).
2. The app's owner (from `application/v6`, as `src/policy/owner.ts` does) is the form submitter. Stops someone from submitting a colleague's App ID.
3. The chosen Claude account has room (§5).
4. No bot with the same App ID already runs (an app connected twice splits its messages between the two).

**Provisioning:** `lark-bots.sh add <name> --app-id … --mode personal|team --claude-account <id> --app-secret-stdin --yes --json` (the secret piped in), then a smoke test (container running, Claude answers, the bridge connected to Lark). The secret is then cleared from Base. The requester is told only once the bot can answer: if its Claude account works, at once; if the seat has no token yet, the request waits as **Waiting for Claude** (the seat's holder gets the Claude sign-in card, §5.3) and is announced when the token is saved. Announcing = Status Ready (the Base automation messages the requester) and a welcome DM from the bot itself (`lark-bots.sh bot-message`). The owner's Lark sign-in happens later in chat, through the sign-in card the bot already sends when it first needs their data.

### 3.3 Changes to `lark-bots.sh` and the bridge

Done in Phase 1 (branch `feat/bot-provisioning`; usage in [deploy/docker/README.md](../deploy/docker/README.md#without-questions-the-provisioner)):

| Change | Why |
|---|---|
| `profile create --app-secret-stdin` (bridge) and `add --app-secret-stdin` | The secret must not appear in a process list, as `--app-secret <secret>` does |
| `add --yes` | `add` stopped for input (team-mode confirm, Claude login, "connect Lark account now?"). With `--yes` it asks nothing and removes a half-made bot when a step fails, so the provisioner can retry |
| `add --json`, exit codes | One JSON line at the end; exit 2 bad arguments, 3 name or app in use, 4 Lark rejected the App ID/Secret, so the failure card can offer the right fix |
| `add` refuses an App ID that already runs as another bot | One app connected twice splits its messages |
| `claude-account set/list/check/remove`, `use-claude`, `add --claude-account` | One credential file per Claude account; bots are assigned to it (§5.4) |
| `remove --yes` | Cleanup without typing the name |

## 4. Department bots

Approve provisions a department bot the same way, in `team` mode with `workspace` access, on the seat or API key the approver chose (§5.2). The container is the easy part; the knowledge is not, so a department request has one more stage before it goes live.

| Automatic | Done by people |
|---|---|
| Container, `team` mode, per-person sign-in on | Deciding what every member may see (plan §7.1) |
| Starter `CLAUDE.md` from the form: purpose, audience, the listed documents and wiki pages, the escalation rule | Doc and wiki owners adding the bot as collaborator or wiki member (a bot can't grant itself access) |
| Access check: the bot tries each listed link; the card shows "4 of 6 readable, missing: …" | Curating the handbook and skills (plan §8) |
| Re-checking access daily and updating the checklist card until all are readable | Availability set to the department, and that version approved |
| Joining the listed group chats once it is a member | A pilot with a member who isn't the app owner, then **Go live** on the card |

Status goes Ready → **Knowledge setup** (a checklist card that updates itself) → **Live**.

## 5. Claude accounts

### 5.1 What Anthropic allows (researched 2026-10-21)

| Fact | Source |
|---|---|
| A Team seat "is assigned to one named individual, and only that person may use it"; reassignment "isn't designed for rotating one seat among several active users" | [Team seats](https://support.claude.com/en/articles/12004354-purchase-and-manage-seats-on-team-plans) |
| Subscription login is "designed to support ordinary use of Claude Code"; customers may not "intermediate Claude usage on their end users' behalf". An API key configured "for use by the customer's own authorized users" is allowed | [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) |
| `claude setup-token` runs the same browser approval as `/login` and prints a **one-year** token for whichever account approves. On a server the browser shows a code to paste back. There is no stdin option; the token is used as `CLAUDE_CODE_OAUTH_TOKEN` | [Authentication](https://code.claude.com/docs/en/authentication) |
| Nobody can approve for someone else: there is no documented way for a Team admin to log in or mint a token for a member | (absence in the Team and auth docs) |
| API keys can be listed, renamed and disabled through the Admin API but **created only in the Console**. Usage and cost can be read per key and per workspace through the Usage & Cost Admin API. Workspace spend limits are set in the Console | [API keys](https://platform.claude.com/docs/en/api/organization/api_keys), [Usage & Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) |
| The Team plan's pooled Console credits (USD 20 per Standard seat, capped at USD 500/month) cover the API, not Claude Code signed in with a seat | [API credits for subscribers](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) |

**Consequence:** only the holder of a seat can approve its sign-in. To put a bot on `abc@gdexpress.com`, abc must approve once; they don't share their mailbox or password, they open one link and paste back one code (§5.3). An API key needs nobody: the operator creates it in the Console.

**Decision (2026-10-21):** GDEX runs every bot under one Claude Team account and uses `ai@gdexpress.com` as the default seat; the AI Team reads this as one company account rather than sharing with outsiders, so it is not being raised with Anthropic. The quotes above stay here for reference if that reading is ever questioned.

### 5.2 Which credential a bot gets

The approver chooses on the approval card, the same way for personal and department bots:

| Choice on the card | What happens |
|---|---|
| **Seat** (default: the Claude account email from the form, else the Settings default `ai@gdexpress.com`; any other seat from the Claude Accounts table) | The card says whether the form's account is already connected (✅), a known seat without a token (☑️), or not in Claude Accounts yet (⚠️: add the seat in the Claude admin console first). If the seat's token is already saved on the server, the bot uses it at once. If not, the Claude sign-in card goes to the form's holder (§5.3) |
| **API key** (an existing key from Claude Accounts, or paste a new one into the card) | Saved on the server and used at once; nobody else is involved |

The choice can also be changed later in Base (Requests → Claude account); the provisioner applies it with `use-claude` and restarts the bot.

**Seat count check:** Claude Accounts records the seats bought (a number the AI Team keeps up to date) and every seat in use. The card shows, for the chosen account, how many bots it already backs, and warns before approving a new seat when none is free.

### 5.3 The Claude sign-in card

Used when the chosen seat has no token on the server yet, and again before a token expires:

1. The provisioner starts the Claude sign-in (`claude setup-token`) in a throwaway container and captures the approval link.
2. A card goes to the seat's holder as a DM from the provisioner app: to the **Holder** set in Claude Accounts, else to the seat's email as a Lark account (`ai@gdexpress.com` too, since its holder may not be in the AI Team group). "Connect Claude: open this link while signed in to claude.ai as `<seat>`, approve, then paste the code it shows here." Lark only delivers the DM if the provisioner app's availability includes that person; if it refuses, the card goes to the AI Team group with a note saying so. (Changed 2026-10-22: the team seat's card used to go to the group.)
3. The holder pastes the code into the card. The provisioner feeds it to the sign-in, saves the token (valid one year) with `claude-account set <seat> --stdin --restart`, which restarts every bot on that seat.
4. The Claude Accounts row records the token's expiry. **30 days before it expires, the same card is sent again.**

Needs a spike first: the docs describe the paste-back code for `/login`, not explicitly for `setup-token`, and the command expects a terminal (driven through a pseudo-terminal). If it can't be driven reliably, the fallback is the bot's own `/login` (`lark-bots.sh set-claude <name>` option 3), with the same link-and-code exchange.

### 5.4 Managing them

| What | How |
|---|---|
| Inventory | Base table **Claude Accounts**: account (email or key name), kind (Standard seat / Premium seat / API key), holder, linked bots, token expiry, last check, server credential id |
| Storage on the server | One file per account, `lark-bots/claude-accounts/<id>.env` (mode 600), written by `lark-bots.sh claude-account set`. Bots point at an account (`use-claude`) instead of holding a copy, so rotating a credential is one file and a restart of its bots. A bot whose account has no credential yet gets none, never the shared one |
| Health | Daily: one tiny `claude -p` call per account; the result goes in "last check". A failure posts to the AI Team group with the affected bots |
| Expiry | 30 days before a seat token expires, the bot sends its owner the sign-in card again |
| Cost | Monthly: the provisioner reads the Usage & Cost Admin API (Admin key, read-only) and writes cost per API key into Claude Accounts. Seat usage isn't reported per token; Premium upgrades are judged from limit errors in the bot logs |
| Offboarding | Removing the person from the Team plan ends their seat; the bot is removed with `lark-bots.sh remove`. API keys are disabled through the Admin API |
| Stays manual | Buying and assigning seats (Team admin console), creating API keys (Console). Both are rare and take a minute |

Later, if static keys become a burden: Workload Identity Federation (short-lived tokens, no stored key) or an internal LLM gateway. Not needed at this size.

## 6. Security

- **The App Secret** is visible only to the provisioner (Base field permissions), cleared after it is stored in the bot's keystore, and never shown in a card or message. Base keeps record history, so the Base itself stays restricted to the AI Team; form submitters can't view records.
- **Approval** comes only from the card in the AI Team group, from a current member. Every click is logged in Events.
- **App ownership** is checked against the submitter, so nobody can request a bot on someone else's app.
- **The provisioner holds Docker access**, which is root-equivalent on the server. It runs only `lark-bots.sh`, accepts nothing from requesters except the form fields (validated: App ID pattern, bot name pattern, links), and never puts user text into a shell command.

## 7. Phases

| # | Work | Estimate |
|---|---|---|
| 1 | `lark-bots.sh` non-interactive `add`, secret on stdin, per-account Claude credentials | **Deployed 2026-10-22.** Server test passed (bad arguments → 2; real App ID with a wrong secret → 4 and the half-made bot removed; account files 700/600; entrypoint keeps an assigned bot off the shared credential). `lark-bot:latest` rebuilt (rollback `lark-bot:pre-provisioning`, backups in `~/lark-bots/backup-20261022/`); `joeee` recreated on it, the other bots pick it up at their next restart |
| 2 | Base (four tables), form with help text, three Base automations (received / rejected / ready messages to the requester) | **Done.** Form display conditions, sharing and the form link in guide Step 5 set 2026-10-22. App Secret column to be hidden from all but the provisioner once its app exists |
| 3 | Provisioner: polling, approval card, approve/reject, checks, provisioning, failure card with credentials link and Retry | **Built and checked on the server** except the live run: its container reaches Docker and runs `lark-bots.sh` (`bot-get` as joeee works); `--check` read the real Base and group and Lark accepted the approval card; the owner check matched a real app owner with the form submitter. **Waiting for its own Lark app** (Gem runs `joeee`, Claude runs the laptop bridge; one app can't hold two connections) |
| 4 | Claude accounts: seat/API-key choice on the card, Claude sign-in card, daily health check, renewal 30 days ahead | **Built.** `claude setup-token` trial on the server: under `script` it prints the approval link and waits for the code. The token step needs a real approval, so it is proved on the first real sign-in. Monthly cost per API key: not built (no API keys in use yet) |
| 5 | Department extras: starter `CLAUDE.md`, access check as the bot, checklist card (Check again, Go live), daily re-check | **Built** (`set-instructions` and `bot-get` in `lark-bots.sh`) |
| 6 | One personal and one department request end to end | Next, once the provisioner's app is in place. A test request `REQ-0002` ("TEST provisioning check (please reject)") is waiting in the Base: its card will be the first one; Reject it |

## 8. Decisions (2026-10-21)

| Question | Decision |
|---|---|
| How the App Secret arrives | In the form, for a hands-off flow. If it is wrong, the failure card links to the app's credentials page (opened as `ai@gdexpress.com`) and takes a corrected secret in the card |
| Who may approve | Everyone in the AI Team group |
| Claude credential, personal and department bots alike | The approver chooses on the card: a **seat** (default `ai@gdexpress.com`, or another seat they assign themselves) or an **API key**. Checked against the seat count before approving; changeable later in the card or in Base. Not raised with Anthropic: one company Claude account (§5.1) |
| Seat sign-in | When the chosen seat has no token on the server, the provisioner starts the sign-in and the seat holder gets a card: open the link, approve, paste the code. The token (one year) is saved and the bot restarted. The same card goes out again 30 days before expiry (§5.3) |
| Bot, events and callbacks setup | Not needed: the guide's "Create" shortcut presets them |
| The provisioner's own Lark app (2026-10-22) | A dedicated app. Lark hands each event of an app to one of its open connections, so sharing Gem (`joeee`) or Claude (laptop bridge) would send about half the clicks and DMs to the wrong process |
| Claude account comes first (2026-10-23) | The requester names the seat and its holder in the form. A team seat belongs to a named person, usually a department email (e.g. `hr@gdexpress.com`). Without a seat they don't submit: the department raises a Purchase Requisition ([PR guide](https://gdexgroup.sg.larksuite.com/wiki/OMHYwW7XAiWkCZkMvy8lLVBzg7S)) or contacts the AI Team, and requests again once the PR is approved and the seat added. PRs aren't tracked here, and nothing is approved ahead of a PR, so the AI Team never holds half-done requests |
| AI Agent Admin DMs (2026-10-23) | Anyone who messages the app gets a fixed card (no agent run): what an agent is, the Claude account step, and buttons for the request guide, PR guide, form and user guide. Links overridable from Base Settings |
