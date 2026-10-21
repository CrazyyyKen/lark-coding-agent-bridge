# GDEX Lark Agents Platform — Requirements, Architecture and Implementation Plan

**Status:** Draft v3 for review · **Date:** 2026-10-12 · **Owner:** AI team (ai@gdexpress.com)
**Changes from v2:** records the decisions of 2026-10-12 (§12.1): Sonnet 5.5 is the default model for every bot, executives included; executive assistants never talk to each other; adds a company-wide **HR Help** bot for general HR questions (§4.4); staff personal assistants go to **selected roles first**; the Leadership Agent stays in the plan as low priority pending the executives' confirmation.
**Changes from v1:** adopts the **two-bot model**: a shared Department Agent per department, plus a Personal Assistant per person (executives first, then selected staff), all on one Claude account. Department bots no longer act with anyone's personal login, which removes v1's per-user-identity engineering. Adds the C-level design (§5) and isolation tiers (§6).

---

## 1. Executive summary

We have proven the concept: `lark-channel-bridge` + Claude Code on a teammate's laptop gives that one person a capable Lark assistant. It does not scale: every install needs IT admin rights and hands-on debugging, it only knows one person's context, and it stops when the laptop sleeps.

The plan is to run the same bridge **once, on a GDEX server**, hosting two kinds of bot, all billed to **one Claude account**:

| | **Department Agent** (e.g. "HR Agent") | **Personal Assistant** (e.g. "Teong Assistant") |
|---|---|---|
| Who uses it | Every member of the department | Exactly one person, its owner |
| What it knows | Department handbook, SOPs, templates, and the Lark Wiki/Docs/Base shared with the bot | Whatever **its owner** can see in Lark: their mail, calendar, docs, chats |
| Whose Lark login it uses | **The bot's own app identity, always.** Never a person's login | **Only its owner's** login |
| Typical jobs | Policy Q&A, drafting department documents, department workflows (leave, claims, requests) | Inbox triage, replying to email, meeting prep, personal drafting, meeting summaries |
| Rule of thumb | *What every member of the department may see* | *What this one person may see* |

This split answers the question that blocked v1 (*"how do we stop the HR bot showing Staff A's email to Staff B?"*): department bots never hold anyone's email, so there is nothing to show. Personal data only ever lives in that person's own bot.

Because HR questions concern everyone, HR gets **two** shared bots: the **HR Agent** for the HR team's internal work, and a company-wide **HR Help** bot that answers general questions (public holidays, leave entitlement, claims, forms) from a public subset of HR knowledge and handles everyday requests such as leave applications (§4.4). Other departments can follow the same pattern later if they want.

**For the C-levels** (Mr Teong, Mr Nicholas, Ms Yinn, Ms Caren, Ms Salwa; more to follow): each gets their **own** Personal Assistant, running as a **separate instance under its own Linux user**, so nothing one executive discusses can reach another (§5). One shared C-level bot would also work technically, but it is the weaker design and gains nothing.

**Recommended path:** an on-prem Ubuntu VM (same outbound-only posture as ADR-0048), one Claude Team plan with a linked Console organisation (§10.3), **Sonnet 5.5 as the default model for every bot**, executives first, then HR as the pilot department and the company-wide HR Help bot, then personal assistants for selected staff roles, then Finance and Operations.

**Timeline: ≈20 weeks.** CEO and CFO assistants live in **week 4**; all five executives and the HR Agent in **week 5**; HR Help open to the whole company in **week 11**; personal assistants for the first selected roles from **week 12**; three departments in production by **week 20**.

**Indicative running cost:** VM ≈ free on existing hypervisor capacity. Claude is paid through a **Claude Team plan**: one USD 25/month seat per person who has a personal assistant (plus 2 admins), while shared bots run on the plan's pooled monthly API credits. That comes to ≈ USD 175–235/month at week 5 (7 seats) and ≈ USD 1,075–1,125/month at week 20 (37 seats, including ≈ USD 150–200 of shared-bot usage above the credits). See the seat tracker in §10.3. To be measured in the pilot, not assumed.

### 1.1 Next steps (as of 2026-10-13)

**Start building now.** Nothing technical blocks a start. Run week 1 as two parallel tracks:

**Track A: de-risking spike (task 0.0, 3–5 days, one engineer, any Linux machine or WSL).** Step-by-step: [spike-checklist.md](spike-checklist.md); instance setup: [deploy/README.md](../deploy/README.md). Prove the assumptions the design rests on before the VM arrives (S5, `workspace` permission mode with the template, is in the checklist):

| # | Prove that… | If it fails |
|---|---|---|
| S1 | A Team seat can sign in Claude Code **headlessly** on Linux for a systemd service, and `claude -p` keeps working for 48 h without anyone re-logging in | Personal assistants also run on an API key (pooled credits); seats then only cover interactive use |
| S2 | A shared-bot instance with `ANTHROPIC_API_KEY` from the linked Console org works, and the usage shows against the plan's credits | Check the credit claim and Console linking with Anthropic support |
| S3 | Two bridge instances under two Linux users run side by side; reading the other's folder fails; each has its own `~/.claude` | Fix permissions in `new-instance.sh` |
| S4 | `lark-cli` stores its login on a headless Linux server (no desktop keychain), and the Lark DM authorisation flow works for a personal assistant on our tenant (larksuite.com) | Use lark-cli's file-based credential store inside each instance's home |

The spike also records idle memory per instance (input to §6).

**Track B: week-1 actions that have lead time** (owners in §9 Phase 0):

| Action | Why now |
|---|---|
| Buy the Claude Team plan (7 seats) and link the Console org (0.2) | API credits are claimable only after **7 days** on the plan |
| Raise the VM request with IT (0.4) | Usually the longest lead time |
| One ticket to the Lark admin: HR Agent, HR Help and 5 executive apps, scopes, self-service policy question (0.5, 0.6) | Needed before any executive goes live in week 3 |
| DPO starts the PDPA assessment (0.3) | **Must finish before executives' mail goes to Claude** (week 3) |
| Name the HR knowledge owner; start `handbook/public/` (0.8) | HR Agent v1 in week 5 needs content |
| Book the executive briefing (0.7) | Gate for executive onboarding |

**Gates.** These must be done before the step they block; everything else can run alongside:

| Gate | Blocks | Needed by |
|---|---|---|
| Spike S1–S4 passed | Writing `new-instance.sh` for real | End of week 1 |
| Team plan bought + Console linked | Any bot talking to Claude | Week 2 |
| VM + Lark apps | Executive onboarding | Week 3 |
| PDPA sign-off + executive briefing | Executives' mail and calendar reaching Claude | Week 3 |
| Selected-role list (0.9) | Staff assistants | Week 9 |
| Operations owner named | Handover | Week 19 |

---

## 2. Where we are today

### 2.1 Current deployment

```
 Teammate's laptop (Windows)                         Lark
 ┌─────────────────────────────────────┐             ┌──────────────┐
 │ lark-channel-bridge (Task Scheduler)│◄─WebSocket──┤ PersonalAgent│
 │   profile "claude" (mode: personal) │             │ app (1 user) │
 │     └─ spawns `claude -p` per turn  │             └──────────────┘
 │        cwd = that user's folder     │
 │        lark-cli = that user's OAuth │
 └─────────────────────────────────────┘
```

Each install is a PersonalAgent Lark app bound to one person. The bridge's access policy defaults to "owner only" ([access.ts](../src/policy/access.ts)), and the agent's working directory and `lark-cli` login belong to that person.

### 2.2 Why it does not scale

| Pain | Root cause |
|---|---|
| Needs the IT admin password and on-site debugging for every laptop | Node, Claude Code, lark-cli and a scheduled task are installed per machine |
| Stops when the laptop is off or asleep | The runtime lives on an end-user device |
| Only knows one person's context | Knowledge = that person's folder; identity = that person |
| Can't be shared with colleagues who have no AI licence | Billing and login are tied to the installer's personal subscription, which Anthropic's terms do not permit for shared, unattended use (§10.3) |
| No central view of usage, cost or failures | Logs are local to each laptop |

### 2.3 What the codebase already gives us

| Need | Already in the code | Where |
|---|---|---|
| Many bots in one process | `Supervisor` hosts N profiles in one Node process; each has its own Lark app, sessions, workspace and lark-cli folder | [supervisor.ts](../src/runtime/supervisor.ts) |
| Several independent instances on one machine | All state, including the single-supervisor lock, lives under `LARK_CHANNEL_HOME`, so instances with different homes run side by side | [app-paths.ts](../src/config/app-paths.ts) |
| Owner-only personal bot | `mode: personal`; the app owner is detected from Lark every 30 min and is the only permitted user by default | [owner.ts](../src/policy/owner.ts), [access.ts](../src/policy/access.ts) |
| "Anyone can use it" bot with no personal login | `mode: team`: no allowlist, lark-cli forced to the bot's own identity | [profile-schema.ts:112-126](../src/config/profile-schema.ts#L112-L126) |
| Self-service bot creation | QR flow: the person who scans creates their own Lark app and becomes its owner; switches to larksuite.com automatically for international tenants | [qr-register.ts](../src/ui/qr-register.ts), [wizard.ts](../src/bot/wizard.ts) |
| Personal Lark login from chat | Device-flow OAuth (`lark-cli auth login --no-wait` → `--device-code`) | [user-im.ts](../src/lark-cli/user-im.ts) |
| Per-conversation sessions | Session scope = chat ID; topic groups get one session per topic | [scope.ts](../src/bot/scope.ts) |
| Shaping the agent | Bridge system prompt + `CLAUDE.md`, `.claude/skills/`, `.mcp.json` in the workspace | [claude/adapter.ts](../src/agent/claude/adapter.ts) |
| Permission clamp | `permissions.defaultAccess/maxAccess` → Claude permission mode (`full` / `workspace` / `read-only`) | [run-policy.ts](../src/policy/run-policy.ts) |
| Server operations | systemd unit, Linux CI, JSONL logs, optional telemetry adapter, web console | [daemon/systemd.ts](../src/daemon/systemd.ts), [ui/](../src/ui/), [core/telemetry.ts](../src/core/telemetry.ts) |
| Meeting agent | Joins meetings, reads the transcript, answers and summarises | [meeting/](../src/meeting/) |

### 2.4 Gaps the plan must close

| Gap | Fix |
|---|---|
| **G1: Department bots know nothing.** A profile's workspace starts empty | Versioned handbook, skills and Lark sharing (§8) |
| **G2: `team` mode means the whole company** | Lark app availability = the department, plus a bridge department allowlist (§7.1) |
| **G3: All bots in one process share one OS user.** The agent runs in `full` mode by default and can read sibling profiles' folders; the bridge never sets `CLAUDE_CONFIG_DIR`, so all agents share one `~/.claude` (transcripts, memory) | Separate instances under separate Linux users for every bot; a per-run sandbox only if staff assistants later scale beyond ≈60 (§6) |
| **G4: Billing.** One person's subscription can't back a shared bot serving many people | Claude Team plan: a seat per personal-assistant owner; shared bots on the plan's pooled API credits (§10.3) |
| **G5: Operations.** No per-person cost view, no audit of which human triggered which Lark action, no per-person budget | Audit record and budget per profile (Phases 2–3) |
| ~~v1 G3: per-user identity inside shared bots~~ | **Removed by design.** Department bots never hold personal logins |

---

## 3. Requirements

### 3.1 Personas

| Persona | Example | What they need |
|---|---|---|
| **Department staff** (most have no AI licence) | HR executive, Finance clerk, Ops planner | Ask the department bot about policies and processes, get documents drafted, trigger department workflows, all from Lark with nothing to install. Optionally, their own personal assistant |
| **Department knowledge owner** | HR manager | Decide what the department bot knows and may do; update the handbook; see usage |
| **Executive** | Group CEO, CBPO, CFO, COO, CRO | A private, always-on assistant with their own mail, calendar and docs that works from the phone with the laptop off. **No information may pass between executives** |
| **Platform admin** | AI team / IT | Onboard a department or a person in minutes; rotate keys; see cost, errors and audit trail; back up and restore |

### 3.2 Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| F1 | One Department Agent per department (HR, Finance, Ops…), usable by every department member in DMs and department groups | Must |
| F2 | The Department Agent answers from department knowledge and cites the source document | Must |
| F3 | The Department Agent drafts and edits Lark Docx/Sheets/Base and sends messages and cards as the department bot | Must |
| F4 | Shared bots run workflows for the requester (leave, claims, requests), always bound to the requester's real Lark identity, never to a name typed in the message | Should (Phase 4) |
| F5 | **Executive Personal Assistants**, one per executive (Teong, Nicholas, Yinn, Caren, Salwa; more to come), 24×7, each using only its owner's Lark login, with **no information path between executives**. Assistants never message each other | Must |
| F6 | **Staff Personal Assistants** for **selected roles first** (list approved by management), one per person, using only the owner's Lark login; onboarding limited to approved people | Should (Phase 3–4) |
| F7 | Onboarding: a new department = one script + Lark app + knowledge template; a new person = scan a QR code + one authorisation | Must |
| F8 | Knowledge owners update knowledge without engineering (edit Lark Wiki, synced nightly; or a handbook pull request) | Should |
| F9 | Admin console reachable securely by platform admins; `/status` and `/config` in chat for bot admins | Must |
| F10 | Optional **Leadership Agent**: shared by the executives, bot identity only, for material all of them may see (board templates, group KPIs, policies). **Low priority; build only if the executives confirm they want it** | Could |
| F11 | **HR Help**: a company-wide bot answering general HR questions from a public subset of HR knowledge, and filing everyday requests (leave, claims) for the verified sender | Must (questions) / Should (requests, Phase 4) |

### 3.3 Non-functional requirements

| ID | Requirement |
|---|---|
| N1 | **Isolation**: no bot can read another bot's sessions, files, credentials or memory; no executive's assistant can reach another executive's data, even if the agent is manipulated |
| N2 | **Least privilege**: department bots see only what is shared with the bot and only content every department member may see; agents run in `workspace` permission mode with a command allowlist, not `full` |
| N3 | **PDPA**: content sent to the model vendor is covered by a DPA, no-training and retention terms, and an updated s.7 notice (ADR-0050 precedent); personal logins only with that person's explicit OAuth consent |
| N4 | **Availability**: survives reboots (systemd), auto-reconnects to Lark; VM covered by hypervisor snapshots and backups |
| N5 | **Auditability**: every run logs who asked, in which chat, which identity was used, which Lark actions ran, and the cost |
| N6 | **Cost control**: workspace spend caps at Anthropic; per-person monthly budget in the bridge; host-wide concurrency cap |
| N7 | **Reproducibility**: Ansible rebuilds the host from scratch; secrets escrowed |

### 3.4 Out of scope (for now)

Customer-facing bots; replacing n8n workflows; fine-tuning; Lark native AI (§10.5).

---

## 4. Target architecture

### 4.1 One server, one bridge install, one Claude account, several isolated instances

```
                     GDEX on-prem Ubuntu 24.04 VM  (outbound 443 only, no inbound port)
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ one lark-channel-bridge install · one Claude Code install · one lark-cli install     │
 │                                                                                      │
 │  DEPARTMENT AGENTS: one Linux user + one instance each (mode: team-scoped, bot ID)   │
 │   dept-hr   → HR Agent        /srv/lark/dept-hr    knowledge: HR handbook + HR wiki  │
 │   dept-fin  → Finance Agent   /srv/lark/dept-fin                                     │
 │   dept-ops  → Ops Agent       /srv/lark/dept-ops                                     │
 │   pub-hrhelp→ HR Help (whole company)  knowledge: PUBLIC HR subset only              │
 │   (dept-lead→ Leadership Agent, optional, low priority, bot identity only)           │
 │                                                                                      │
 │  EXECUTIVE ASSISTANTS: one Linux user + one instance each (mode: personal, own login)│
 │   exec-teong → Teong Assistant      exec-nicholas → Nicholas Assistant               │
 │   exec-yinn  → Yinn Assistant       exec-caren    → Caren Assistant                  │
 │   exec-salwa → Salwa Assistant                                                       │
 │                                                                                      │
 │  STAFF ASSISTANTS (selected roles): one Linux user + one instance each, like execs;  │
 │   switch to a shared sandboxed instance only if numbers grow (§6)                    │
 │   staff-ali → Ali Assistant · staff-siti → Siti Assistant · …                        │
 │                                                                                      │
 │  shared services: knowledge-sync timers · audit/OTEL logs → Grafana · admin console  │
 └───────────────┬──────────────────────────────────────────────┬───────────────────────┘
                 │ outbound WebSocket (events, card clicks)      │ outbound HTTPS
                 ▼                                               ▼
          Lark Open Platform                              ONE Claude Team plan, default Sonnet 5.5
          (one app per bot)                               · personal assistants: owner's own seat
                                                          · shared bots: API key from linked Console
                                                            org (pooled monthly credits, spend limit)
```

Nothing inbound is needed: `@larksuite/channel` receives events and card clicks over an **outbound** WebSocket, the same posture ADR-0048 relied on for n8n.

### 4.2 Why "one Claude account" is safe

The Claude API is **stateless**: each request carries its own context and the model keeps nothing between calls. Isolation is decided entirely on our server. A single Claude Team plan can therefore serve every bot. Seats and API keys decide **who pays** and **whose usage limit applies**, not who can see what. Prompt caching is keyed on the exact byte prefix of a request, so a cache hit requires already having the content and cannot surface someone else's data.

### 4.3 Which bot handles what

```
   Any employee
     ├─ "How many days of marriage leave do I get?"      ──► HR Help         (bot identity, PUBLIC HR knowledge)
     ├─ "Is next Monday a public holiday in Penang?"      ──► HR Help
     └─ "Apply 2 days annual leave next Mon–Tue"          ──► HR Help         (bot identity; approval filed
                                                                              with initiator = sender's verified ID)
   HR team member
     ├─ "Draft an offer letter for candidate X"           ──► HR Agent        (bot identity, internal HR handbook
     └─ "How many candidates are at interview stage?"     ──► HR Agent         + templates + recruitment Base)

   Staff member with a personal assistant (selected roles)
     ├─ "Reply to Ali's email about his leave balance"    ──► Own Personal    (own login: own mailbox;
     │                                                        Assistant        reads HR wiki with own access)
     └─ "Prep me for tomorrow's 10am meeting"             ──► Own Personal    (own calendar + own docs)
                                                              Assistant

   Mr Teong ─────────────────────────────────────────────────► Teong Assistant (own instance, own Linux user)
```

If someone asks a shared bot something personal ("summarise my inbox"), it replies: *"I'm a shared assistant and can't access personal mail."* (plus *"Ask your personal assistant"* if the person has one). This rule lives in the shared bot's `CLAUDE.md` and is enforced because the bot has no personal login to use.

### 4.4 HR Help: the company-wide HR bot

| | HR Agent | HR Help |
|---|---|---|
| Audience | HR team only (Lark availability = HR department) | **Every employee** (Lark availability = whole company) |
| Knowledge | Full internal HR handbook, templates, recruitment Base, HR wiki | **Public subset only**: leave and benefits policies, public holidays, claims process, forms, HR contacts, onboarding FAQ |
| Can do | Draft HR documents, query HR Bases, meeting notes | Answer questions; file the sender's own leave and claims (Phase 4); hand over to a human ("contact HR at …") when unsure or the question is about a specific case |
| Identity | Bot identity | Bot identity |
| Instance | `dept-hr` (own Linux user) | `pub-hrhelp` (own Linux user, **cannot read the internal HR handbook**) |

Why a separate bot rather than opening the HR Agent to everyone: the HR Agent holds internal material (candidates, templates, HR-only Bases). Giving everyone access to it would give everyone that material. HR Help is built so that the only things it can read are things every employee may read.

**Public subset:** the HR knowledge owner marks pages as public by keeping them under `handbook/public/` (and a public HR wiki space). Only that folder and that wiki space are synced to HR Help. Each public page is reviewed by HR before it is published.

---

## 5. C-level assistants

### 5.1 Who and what

| Executive | Role | Assistant | Wave |
|---|---|---|---|
| Mr Teong | Group CEO | Teong Assistant | 1 (week 3–4) |
| Ms Yinn | CFO | Yinn Assistant | 1 (week 3–4) |
| Mr Nicholas | Chief Business & Partnership Officer | Nicholas Assistant | 2 (week 5) |
| Ms Caren | COO | Caren Assistant | 2 (week 5) |
| Ms Salwa | CRO – Regulatory Officer | Salwa Assistant | 2 (week 5) |
| Others to come | | `<Name> Assistant` | ≤1 h each, any time after week 5 |

Starter capabilities: inbox triage and summaries, draft replies, meeting prep from calendar and docs, joining meetings and sending the summary to their DM, document drafting, Base/Sheet lookups, all as **themselves**, from phone or laptop, 24×7.

Model: **Sonnet 5.5**, the same default as every other bot (decided 2026-10-12). It can be raised to Opus 5.5 for one executive or one skill later through a profile setting, if quality on their work calls for it.

Executive assistants **never message each other** (decided 2026-10-12). Each assistant answers only its owner and ignores every other sender, including other bots. Coordination between executives stays between the executives.

### 5.2 Why one bot per executive, not one shared C-level bot

A shared C-level bot is **doable**: it would need the per-user login and sandbox work that v1 planned for department bots. It is still the wrong choice for executives:

| | **One assistant per executive** (recommended) | **One shared C-level bot** |
|---|---|---|
| Isolation | **Structural**: different Lark app, folders, Linux user and `~/.claude`; nothing in common to leak | **Built and maintained by us**: identity routing, sandbox mounts, per-user memory must work on every run, through every upgrade |
| Example of a subtle leak | Not possible: each instance has its own Claude Code memory | Claude Code's auto-memory is stored per working folder and loads even with settings disabled. In a shared workspace, something Ms Yinn said could resurface for Mr Teong unless we know to turn it off and keep it off |
| Personal login (mail, calendar) | Each instance holds **only its owner's** token. Works with today's code | Needs new per-user login routing (several weeks of engineering) |
| Blast radius if a malicious email tricks the agent | That executive only | All five executives |
| Ready by | Weeks 4–5 | ≈ week 12–14 |
| Claude cost / account | Same / one | Same / one |
| Setup effort | One Lark app per executive (≈10 min each, once) | One Lark app |
| Executive trust | "Your own assistant, running as its own system user": easy to explain and audit | "Shared bot kept apart by careful engineering": invites doubt whenever something looks odd |

For material executives *should* share (board-pack templates, group KPIs, company policies), there is the optional **Leadership Agent** (F10): a shared bot that uses only its own bot identity and never touches anyone's mail or calendar. **Low priority:** raised at the week-1 executive briefing and built only if they ask for it (≈1 week, any time after week 8).

### 5.3 "One bridge" for all executives: what to share and what not to

| Share safely | Do **not** share |
|---|---|
| The server, the bridge installation, Claude Code and lark-cli binaries | **One bridge process** hosting all five executives. Today all profiles in one process run as one OS user, and the agent (in `full` mode) can read sibling profiles' folders, tokens and histories |
| The Claude Team plan (one account; each executive signs in with their own seat) | **One `~/.claude` folder**. The bridge does not set `CLAUDE_CONFIG_DIR`, so agents in one OS user share transcripts and memory storage |
| Monitoring, backups, the admin console | A Lark app (each executive owns their own) |

So each executive runs as **its own instance under its own Linux user** (`exec-teong`, `exec-yinn`, …, home folders `0700`). If an agent is ever manipulated into reading another executive's folder, the operating system refuses. This needs **no code change**, only an onboarding script (`new-instance.sh exec <name>`).

### 5.4 Executive isolation stack

| Layer | Mechanism |
|---|---|
| Lark | Own app; availability = that executive only; executive is app owner, so the bridge treats them as the sole user (`mode: personal`). Other people, and other executives' bots, get no reply |
| Bridge | Own instance (`LARK_CHANNEL_HOME=/srv/lark/exec-<name>`): sessions, workspace, attachments, logs, `secrets.enc`, lark-cli login |
| Operating system | Own Linux user and systemd service; home `0700` |
| Claude Code | Own `~/.claude` inside that home (transcripts, memory); permission mode `workspace` + command allowlist |
| Model vendor | Stateless API; the executive's **own** Team seat (no shared Claude login); Commercial Terms, no training on inputs by default; 30-day retention |
| Audit | Each executive's run log stays in their own folder |
| **Residual trust point** | Server administrators (root) can read every folder. No hosting option removes this, including the cloud. Limit root to named people, log their access, and say so plainly in the week-1 briefing |

### 5.5 Executive onboarding flow

```
 Lark admin                 Platform admin                    Executive (≈10 minutes)
 ──────────                 ──────────────                    ─────────────────────────
 create app "<Name>         new-instance.sh exec <name> <app-id>
 Assistant", owner =  ───►   • Linux user exec-<name>
 executive, availability     • instance + systemd service
 = executive only            • workspace + CLAUDE.md
                             • assign a Team seat (tracker §10.3)
                             • isolation checks (§7.3)   ───►  1. sign in to Claude with own Team seat
                                                                  (one-time link, method from spike S1)
                                                               2. DM the bot "hi"
                                                               → tap Lark authorisation link (mail,
                                                                 calendar, docs) → done
                                                               → bot switches to user identity
```

---

## 6. Isolation tiers: how each kind of bot is kept apart

| Tier | Bots | How isolated | New code needed | Why this tier |
|---|---|---|---|---|
| **A. Own instance, own Linux user** | Department Agents, HR Help, Executive Assistants, **staff assistants for selected roles** | Separate process, folders, `~/.claude`, OS user | None (scripts only) | Highest assurance, no engineering, affordable while bots number in the tens |
| **B. Shared instance, sandboxed runs** | Staff Personal Assistants, **only if rollout later grows to many people** | One process hosts many profiles; **every agent run** executes in a bubblewrap sandbox that mounts only that profile's folders and its own `CLAUDE_CONFIG_DIR` | Per-run sandbox launcher, per-profile Claude config folder | Avoids one long-running process per person at large scale |

**Decision point at week 8:** because staff assistants go to **selected roles first** (decided 2026-10-12), the expected number is small. The default is therefore **tier A for everyone**, which skips the sandbox engineering. Measure the idle memory of one instance in Phase 1 and confirm at week 8 that the selected-role count × idle memory fits the VM (e.g. 30 people × ≈150 MB ≈ 4.5 GB). Build tier B only when a later rollout would push past roughly 60 personal assistants.

Tier B sandbox mounts (per run, if ever built):

| Mount | Mode | Content |
|---|---|---|
| `profiles/<person>/workspace` | read-write | That person's working files |
| `profiles/<person>/lark-cli` | read-write | That person's Lark login only |
| `profiles/<person>/claude-config` | read-write | That person's Claude Code transcripts and memory |
| `profiles/<person>/media/<run>` | read-only | Attachments from this message |
| everything else | not mounted | Other people's folders don't exist inside the sandbox |

---

## 7. Access control and safety

### 7.1 Department Agents

1. **Who can talk to it.** Lark app availability = the department, so others can't open a chat with it. Defence in depth: `access.allowedDepartments` in the bridge, with membership synced from the Lark contact API.
2. **What it can see.** Only Lark content explicitly shared with the bot (wiki space membership, folder/Base collaborator, group membership). **Share only content every member of the department may see.** Restricted material, such as payroll tables or disciplinary files, is *not* shared with the department bot. People with access reach it through their **personal** assistant, where Lark's own permissions apply to them individually.
3. **Whose identity.** Bot identity only, permanently. The profile runs in `team`-style bot-only mode, which the bridge enforces at startup ([preflight.ts](../src/cli/preflight.ts)).
4. **Workflows for the requester.** Requests like "apply leave for me" are filed by the bot with **initiator = the sender's open_id taken from the Lark event**, which the bridge receives from Lark and the user cannot forge by typing a name. A Claude Code `PreToolUse` hook rejects any workflow command whose subject differs from the sender, so Staff A cannot file for Staff B.
5. **What it can run.** `workspace` permission mode; Bash allowlisted to `lark-cli` plus a few safe utilities; every command written to the audit log.

**HR Help (company-wide) adds three rules:**

1. **Public content only.** HR Help is shared only with the public HR wiki space and synced only from `handbook/public/`. No Bases, no internal folders, no HR groups. Its instance runs as a different Linux user from the HR Agent, so it cannot read the internal handbook on the server either.
2. **Case-specific questions go to a human.** Questions about a specific person's case (disciplinary matters, salary, medical) get a polite handover to HR contacts, never a guess.
3. **Requests only for the sender.** Leave and claims are filed for the verified sender only (rule 4 above), and the bot confirms the details back to them before submitting.

### 7.2 Personal Assistants (executives and staff)

1. **Who can talk to it.** Only the owner (`mode: personal`, owner detected from Lark). Messages from anyone else, including other bots, are silently ignored.
2. **What it can see.** Exactly what the owner can see in Lark, through the owner's own OAuth login, granted by the owner and revocable by them at any time.
3. **Groups.** If the owner @mentions their assistant in a group, it answers in that group. Its replies are visible to the group like any message the owner sends. The assistant's system prompt tells it not to quote private mail or calendar content in group chats unless the owner explicitly asks.
4. **Isolation.** Tier A (executives) or tier B (staff), §6.

### 7.3 Resulting guarantees

| Scenario | Outcome |
|---|---|
| Finance clerk DMs the HR Agent | No chat possible (app availability), or ignored by the allowlist |
| Finance clerk asks HR Help about the leave policy | Answered from public HR knowledge, with a citation |
| Anyone asks HR Help "what is Ali's salary?" or for a candidate's details | HR Help has no access to that data; hands over to HR contacts |
| HR staff asks the HR Agent for the recruitment pipeline | Answered from the recruitment Base |
| Staff A asks a shared bot to "summarise my inbox" | Declines; the bot has no personal login |
| Staff A asks HR Help to apply leave "for Staff B" | Hook blocks it; initiator must equal the verified sender |
| A non-selected staff member opens the personal-assistant onboarding page | Refused; onboarding checks the approved list |
| Mr Teong's assistant receives a message from Ms Caren's assistant | Ignored; assistants answer only their owner |
| Staff A asks their own assistant to reply to an email | Runs with A's login, in A's instance or sandbox; nobody else's token exists there |
| Malicious email tells Ms Yinn's assistant to read `/srv/lark/exec-teong` | OS denies (different Linux user); command allowlist blocks; event logged |
| Mr Teong's and Ms Caren's assistants are both in a board group | Each answers only its own owner |
| An executive or staff member leaves | Lark account disabled → their token stops working; offboarding script archives and removes the instance or profile |

---

## 8. Knowledge layer: making the HR Agent *know HR*

### 8.1 Department handbook (versioned, in the workspace)

```
/srv/lark/dept-hr/workspace/
├── CLAUDE.md                 # persona, scope, tone, escalation, "never do", personal-data redirect rule
├── handbook/                 # curated markdown: policies, SOPs, FAQs, org chart, glossary
│   ├── 00-index.md           # one-line summary per file (keeps context small)
│   ├── public/               # HR-approved pages every employee may read → also deployed to HR Help
│   │   ├── leave-policy.md
│   │   ├── public-holidays-2026.md
│   │   └── claims-process.md
│   ├── recruitment-process.md   # internal; can be generated from recruitment-workflow-automation docs
│   └── wiki-cache/           # nightly export of key Lark wiki pages
├── templates/                # letter and document templates
├── .claude/
│   ├── settings.json         # hooks: command allowlist, requester guard, audit
│   └── skills/               # department skills (§8.4)
└── .mcp.json                 # optional: n8n / internal tools (Phase 4)
```

Kept in a Git repo (`gdex-agent-knowledge`) so changes are reviewed and reversible, and deployed to the VM on merge. The deploy copies `handbook/public/` (and only that) into HR Help's workspace; a check in the deploy fails if anything outside `public/` would be copied.

### 8.2 Live Lark content (bot identity)

The bot is added to the HR wiki space, shared folders and Bases, and reads them at question time with the existing `lark-wiki`, `lark-doc`, `lark-drive` and `lark-base` skills, so answers reflect the current document. A nightly `knowledge-sync` job exports the most-asked pages to `handbook/wiki-cache/` for speed and stable citations.

### 8.3 Optional vector index (Phase 5)

Only if Lark search proves too shallow: Postgres + pgvector on the VM, self-hosted embeddings, exposed as an MCP tool. Decide from pilot answer quality.

### 8.4 Skills

**HR Agent (bot identity):**

| Skill | What it does |
|---|---|
| `hr-policy-qa` | Answer from handbook and wiki, always cite |
| `hr-draft-letter` | Draft offer, confirmation and warning letters from `templates/` into the HR drafts folder |
| `hr-recruitment-status` | Query the recruitment Base (pipeline, KPIs) |
| `hr-meeting-notes` | Join a meeting and post the summary to the HR group |

**HR Help (bot identity, public knowledge):**

| Skill | What it does |
|---|---|
| `hrhelp-faq` | Answer from public HR knowledge, always cite; hand over to HR contacts when unsure or case-specific |
| `hrhelp-leave-request` | File a leave approval for the verified sender, after confirming dates back to them (Phase 4) |
| `hrhelp-claim-request` | Start a claim for the verified sender (Phase 4) |

**Personal Assistants (owner's identity):** `inbox-triage`, `mail-draft-reply`, `meeting-prep`, `meeting-summary`, `doc-draft`, `my-leave-balance`. Executives get a per-person `CLAUDE.md` with their preferences; their skills live only in their own workspace.

Finance and Ops get department sets later (e.g. `fin-invoice-lookup`, `fin-month-end-checklist`, `ops-shipment-exception-triage`).

---

## 9. Implementation plan

### Phase 0: Decisions and provisioning (weeks 1–2)

| # | Task | Owner |
|---|---|---|
| 0.1 | Approve this plan and the two-bot model | Management + AI team |
| 0.0 | **De-risking spike** (week 1, on any Linux machine or WSL; doesn't wait for the VM): see §1.1 | AI team engineer |
| 0.2 | **Buy the Claude Team plan** (7 Standard seats: 2 admins + 5 executives; monthly or annual), link a Claude Console organisation, create a *Shared bots* workspace with a spend limit and an API key; claim the monthly API credits after the 7-day wait. Keep the seat tracker (§10.3) up to date | AI team + Finance |
| 0.3 | PDPA assessment: DPA, retention terms, s.7 notice update (ADR-0050 pattern); consent wording for personal assistants | DPO |
| 0.4 | IT provisions the VM: Ubuntu 24.04, 8 vCPU / 32 GB RAM / 200 GB, outbound 443 only, in the backup/snapshot schedule | IT |
| 0.5 | Lark admin creates apps: **HR Agent** (availability = HR), **HR Help** (availability = whole company) and **Teong / Yinn / Nicholas / Caren / Salwa Assistant** (owner and availability = that executive); scopes per §10.2 | Lark admin |
| 0.6 | **Confirm with the Lark admin:** may employees create their own apps through the QR flow, does each app need admin review, and is there a tenant limit on app count? With selected roles only, the fallback (admin creates the apps in a batch) is fine either way | Lark admin |
| 0.7 | 30-minute executive briefing: capabilities, limits, isolation stack (§5.4), the root-access trust point, the one-time authorisation, assistants never talk to each other; **ask whether they want the Leadership Agent** (F10) | AI team |
| 0.8 | Create the `gdex-agent-knowledge` repo from §8.1; HR knowledge owner starts the handbook, marking public pages under `handbook/public/` | HR + AI team |
| 0.9 | Management names the **first selected roles** for staff personal assistants (suggested starting point: department heads and managers, plus heavy-email roles such as executive assistants, and finance and HR leads), with a target headcount | Management |

### Phase 1: Server foundation, executives, HR Agent v1 (weeks 3–5)

| # | Task | Notes |
|---|---|---|
| 1.1 | Ansible playbook: Node 22, bridge, Claude Code, lark-cli, bubblewrap, log rotation, Grafana agent | Written during the build, not after (ADR-0048 lesson) |
| 1.2 | `new-instance.sh <kind> <name> <app-id>`: creates the Linux user, `LARK_CHANNEL_HOME`, profile, systemd service, workspace skeleton; sets `permissions: workspace`. **Shared bots:** writes `ANTHROPIC_API_KEY` into the service's environment file. **Personal assistants:** leaves it unset and runs the owner's Claude sign-in (method confirmed in the spike) | Scripts only; no bridge code change (the agent inherits the service environment) |
| 1.3 | **Executive wave 1: Mr Teong, Ms Yinn** (weeks 3–4). Run the script; each executive signs in to Claude once with their Team seat, then DMs their bot and completes the Lark authorisation; profile switches to user identity | Existing flow |
| 1.4 | **Executive wave 2: Mr Nicholas, Ms Caren, Ms Salwa** (week 5). ≤1 hour each. Confirm with Ms Salwa whether a read-only-leaning clamp suits regulatory work | Existing flow |
| 1.5 | **Isolation checklist** before every handover: as `exec-teong`, reading `/srv/lark/exec-yinn` fails; a non-owner DM is ignored; `~/.claude` is inside the executive's home; command allowlist active | Checklist |
| 1.6 | **HR Agent v1**: instance `dept-hr`, bot-only identity; bot added to HR wiki, folders and Bases; handbook v1; smoke test with 3 HR volunteers | |
| 1.7 | Measure idle memory per instance (input to the week-8 decision, §6) | |
| 1.8 | Admin console on `127.0.0.1` via SSH tunnel (later behind a reverse proxy with Lark SSO) | [ui/server.ts](../src/ui/server.ts) |
| **Exit** | All five executives use their assistants daily with laptops off; isolation checklist passed; HR volunteers get correct, cited answers | |

### Phase 2: HR Agent pilot, operability, executive skills (weeks 6–8)

| # | Task | Code touched |
|---|---|---|
| 2.1 | Department allowlist (`access.allowedDepartments` + membership sync) | [profile-schema.ts](../src/config/profile-schema.ts), [access.ts](../src/policy/access.ts), new `policy/department-sync.ts` |
| 2.2 | Persona injection: optional `persona.systemPromptFile` appended to the bridge system prompt | [bridge-system-prompt.ts](../src/agent/bridge-system-prompt.ts), [claude/adapter.ts](../src/agent/claude/adapter.ts) |
| 2.3 | Knowledge-sync job on a systemd timer | knowledge repo |
| 2.4 | Audit record per run: sender, chat, identity used, Lark commands run, tokens, cost (Claude Code reports cost per run) → Grafana | [observability/events.ts](../src/observability/events.ts), [core/telemetry.ts](../src/core/telemetry.ts), hooks |
| 2.5 | Per-profile monthly budget: warn at 80 %, pause at 100 % with a message to the owner/admin; host-wide concurrency cap | [process-pool.ts](../src/bot/process-pool.ts), run flow |
| 2.6 | Open the HR Agent to all of HR (≈30 people); 3-week pilot; weekly review of wrong or missing answers | |
| 2.7 | Executive skills round 1 from their feedback (§8.4) | per-executive workspace |
| 2.8 | **Week-8 confirmation**: selected-role headcount × measured idle memory fits the VM → staff assistants use tier A (expected); tier B only if numbers exceed ≈60 (§6) | |
| 2.9 | HR reviews and approves the first set of `handbook/public/` pages for HR Help | HR |
| **Exit** | ≥80 % of pilot questions answered correctly with a citation; drafts accepted with minor edits; cost per person per day known | |

### Phase 3: HR Help and staff assistants for selected roles (weeks 9–13)

| # | Task | Code touched |
|---|---|---|
| 3.1 | **HR Help instance** `pub-hrhelp` (own Linux user): workspace from `handbook/public/` only, deploy check that nothing else is copied; bot added only to the public HR wiki space; `hrhelp-faq` skill with handover to HR contacts | scripts + knowledge repo |
| 3.2 | HR Help pilot with two non-HR departments (week 10); HR reviews every wrong or missing answer | |
| 3.3 | **HR Help opens to the whole company** (week 11); announcement in the all-staff group with examples of what to ask | |
| 3.4 | **Onboarding for selected roles**: an approved-people list (from task 0.9); the onboarding page (reusing the QR app-creation flow) or an admin batch run creates "<Name> Assistant" with the person as owner, as its own tier-A instance; the person DMs the bot once to authorise. Page behind Lark SSO; people not on the list are refused | [qr-register.ts](../src/ui/qr-register.ts), [onboard.ts](../src/ui/onboard.ts), [ui/server.ts](../src/ui/server.ts), `new-instance.sh` |
| 3.5 | Personal-assistant template: `CLAUDE.md`, starter skills (§8.4), group-chat privacy rule | template |
| 3.6 | Offboarding: nightly job archives instances of deactivated Lark accounts | new timer |
| 3.7 | **Security review**: cross-instance read attempts from inside a run; prompt-injection test set (malicious email, malicious doc, HR Help asked for internal data); command allowlist and audit coverage | |
| 3.8 | First selected roles onboarded (weeks 12–13) | |
| **Exit** | HR Help answers the whole company with ≥80 % correct, cited answers; red team finds no cross-person or public-to-internal access path; selected staff onboard in under 10 minutes | |

The per-run sandbox (tier B) is **not built** in this phase because selected roles keep the numbers small (§6). It moves to Phase 5 and is built only if a wider rollout is approved.

### Phase 4: Workflows, rollout, Finance and Ops (weeks 14–20)

| # | Task | Week |
|---|---|---|
| 4.1 | HR Help workflows: `hrhelp-leave-request` and `hrhelp-claim-request` with the requester guard hook (sender ID exported to the run, §7.1) and confirm-before-submit; HR Agent workflows (approvals, calendar, tasks); n8n triggers as a localhost MCP server with per-bot tool allowlists | 14–16 |
| 4.2 | Next batch of selected roles onboarded, if management extends the list | 14+ |
| 4.3 | **Finance Agent**: app, instance, handbook workshops, sharing; selected Finance roles get personal assistants | 15–17 |
| 4.4 | **Ops Agent**: same; selected Ops roles get personal assistants | 17–19 |
| 4.5 | **Leadership Agent** (F10), low priority: only if the executives confirm they want it | any time after week 8 |
| 4.6 | Department admins trained on `/config`, `/invite` and handbook pull requests; runbook; restore drill | 19–20 |
| 4.7 | Cost review against §10.3; Opus vs Sonnet per skill; adjust caps | 20 |
| **Exit** | Three Department Agents, HR Help with workflows, five Executive Assistants and selected-role staff assistants in production; named operational owner | |

### Phase 5 (optional, after week 20)

Wider staff-assistant rollout if approved (build the tier-B sandbox first if it would exceed ≈60 people); public "Help" bots for other departments (e.g. Finance Help for claims questions) on the HR Help pattern; vector retrieval if needed; more departments (≈1 week each); evaluate Anthropic Managed Agents with self-hosted sandboxes.

---

## 10. What it takes: tools and tech stack

### 10.1 Software

| Layer | Choice | Why |
|---|---|---|
| Runtime | `lark-channel-bridge` 0.7.x (GDEX fork) + Node 22 LTS | Already proven; multi-profile; MIT |
| Agent | Claude Code CLI (`claude -p`, stream-json) | What the bridge drives today; skills, hooks, MCP; model per profile |
| Lark access | `lark-cli` + `@larksuite/channel` | Bot and personal identities, device-flow OAuth, outbound long connection |
| Isolation | Linux users + systemd (tier A); bubblewrap per run (tier B) | Standard, auditable, no extra infrastructure |
| Knowledge | Git repo + nightly lark-cli sync; optional pgvector | Reviewable, reversible |
| Operations | Ansible, systemd, JSONL/OTEL → Loki/Grafana (or the existing GDEX stack) | Matches ADR-0048 |
| Secrets | Bridge `secrets.enc` per instance + OS permissions; shared-bot API key in each shared instance's systemd environment file (`0600`); personal-assistant Claude sign-in inside each owner's instance home | No plaintext in `config.json` |

### 10.2 Lark configuration

| | Department Agent / HR Help app | Personal Assistant app |
|---|---|---|
| Created by | Lark admin | Lark admin (executives, or staff in a batch) or the approved person via the QR onboarding page |
| Owner | Platform admin account | **The person** (the bridge treats the owner as the sole user) |
| Availability | The department; **HR Help: whole company** | That person only |
| Bot scopes | `im:message`, `im:chat`, `im:resource`, `contact:department.member:readonly`, `contact:user.base:readonly`, `docx:document`, `wiki:wiki`, `drive:drive`, `bitable:app`; Phase 4: `approval:approval`, `calendar:calendar`; optional `vc:meeting.bot.join:write` | `im:message`, `im:chat`, `im:resource`; optional meeting scope |
| User scopes (via the owner's OAuth) | **None, ever** | `mail:*` (read, send, draft), `calendar:calendar`, `drive:drive`, `docx:document`, `wiki:wiki`, `approval:approval`, `attendance:task:readonly`, requested minimally |
| Event delivery | Long connection | Long connection |

### 10.3 Claude billing: Claude Team plan (subscription seats)

GDEX will pay for Claude through a **Claude Team plan**: Standard seats at **USD 25 per seat per month** (USD 20 with annual billing). Premium seats, with 5× the usage, cost USD 125 (USD 100 annual). Every Team seat includes Claude Code. One Team plan is the **one Claude account** for the whole platform.

**Two ways a bot uses the Team plan.** Which one applies depends on whether a bot serves one person or many:

| | **Personal assistants** (executives, selected staff) | **Shared bots** (HR Agent, HR Help, Finance, Ops, Leadership) |
|---|---|---|
| Signs in to Claude with | **The owner's own Team seat.** The owner signs in once during onboarding | **An API key** from the Claude Console organisation linked to the Team plan |
| Usage drawn from | That seat's own subscription limits | The Team plan's **monthly API credits**: USD 20 per Standard seat (USD 100 per Premium seat), pooled across the plan, **capped at USD 500/month** |
| Above that | The owner hits their seat limit, so upgrade that person to Premium | Pay-as-you-go: purchased credits or auto-reload at API rates. Without them, shared bots stop until next month's credits arrive |
| Why this way | A personal assistant is its owner's own use of their own seat | A seat belongs to one person. Logging a bot that serves 30 people, or the whole company, into one person's seat would be account sharing, and one seat's limits would run out by midday for everyone. The plan's API credits exist for this kind of programmatic use, so we have already paid for them |

Technical notes: shared-bot instances get `ANTHROPIC_API_KEY` in their systemd environment file. Personal-assistant instances must **not** have it set, because an API key overrides the subscription login. The monthly API credits do not apply to Claude Code signed in with a seat, and they expire at the end of each billing cycle. The plan must be active for **7 days** before its credits can be claimed, so buy it in week 1.

#### Claude seat tracker (USD 25 per seat per month)

| Who | Seats | From | Signs in with |
|---|---|---|---|
| AI team / platform admins (plan owners; build and maintain the platform) | 2 | Week 1 | Own seat (interactive use) |
| Executives: Mr Teong, Ms Yinn | 2 | Week 3 | Own seat → their assistant |
| Executives: Mr Nicholas, Ms Caren, Ms Salwa | 3 | Week 5 | Own seat → their assistant |
| Selected staff, wave 1 (roles from task 0.9) | *TBD, planning figure 10* | Week 12 | Own seat → their assistant |
| Selected staff, later waves | *TBD, planning figure +20* | Week 14+ | Own seat → their assistant |
| Executives added later | +1 each | When named | Own seat → their assistant |
| HR Agent, HR Help, Finance Agent, Ops Agent, Leadership Agent | **0** (API key), or **1 each** if run on a dedicated seat | — | API key (pooled credits), or a seat set aside for that bot |

**Rule: one seat per human who has a personal assistant (plus admins). Shared bots default to the API key (zero seats).**

**Shared bots on a subscription seat (option, added 2026-10-21).** A shared bot can instead run on a Team seat **set aside for that bot alone**: never a person's own seat, and never one seat shared by several bots. The containers support both per bot (`lark-bots.sh set-claude <name>`, see [deploy/docker/SETUP.md](../deploy/docker/SETUP.md#creating-a-department-bot)). The trade-off:

| | Dedicated seat | API key |
|---|---|---|
| Cost per bot | Fixed USD 25 (Standard) or USD 125 (Premium, 5× usage) | Usage-based, ≈ USD 50–200/month per bot (estimates above), mostly covered by the pooled credits |
| When usage runs out | The bot returns a usage-limit error to **everyone** until the seat's limit resets (hours; weekly cap too) | Only if credits and auto-reload run out |
| Fits | Small department, light use (start here, watch for limit errors) | Busy department, HR Help (whole company) |
| Open point | Team seats are licensed to named members. **Confirm with Anthropic that a seat may be assigned to a shared internal bot** before production | — |

Each seat also adds USD 20 to the pooled API credits, so a seat for a bot isn't entirely lost even if the bot later moves to the API key.

#### Monthly cost by milestone (Sonnet 5.5 default; usage estimates to be validated in the pilot)

| Milestone | Seats | Seat cost (monthly billing) | Pooled API credit | Shared-bot usage | Pay-as-you-go above credit | **Total / month** |
|---|---|---|---|---|---|---|
| Weeks 3–10: 5 executives + HR Agent | 7 | $175 | $140 | HR Agent ≈ $100–200 | ≈ $0–60 | **≈ $175–235** |
| Week 11–13: + HR Help + 10 staff | 17 | $425 | $340 | HR Agent + HR Help ≈ $150–300 | $0 | **≈ $425** |
| Week 20: 3 departments + HR Help + 5 executives + 30 staff | 37 | $925 | $740 → **capped at $500** | ≈ $650–700 | ≈ $150–200 | **≈ $1,075–1,125** |
| Same, with annual billing ($20/seat) | 37 | $740 | $500 | ≈ $650–700 | ≈ $150–200 | **≈ $890–940** |

Add a contingency of ≈ $100–200/month for one or two people moved to Premium seats if their assistant hits Standard limits. Watch for this from week 4 with the executives.

Every seat holder also gets interactive Claude (claude.ai, Claude Code, Cowork) on their laptop and phone, beyond their Lark assistant.

**List prices (per million tokens in/out), used for shared-bot usage:** Sonnet 5.5 $2 / $10; Opus 5.5 $4 / $20; Haiku 5.5 $0.10 / $0.50. **Default model for every bot, executives included: Sonnet 5.5** (decided 2026-10-12).

**Indicative shared-bot usage (what the pooled credits must cover):**

| Bot | Assumption | Sonnet 5.5 |
|---|---|---|
| Department Agent | 30 staff × 4 turns/day × 22 days; Q&A ≈ $0.03/turn, drafting ≈ $0.24 | ≈ $200 per department → **$600** for three |
| HR Help (whole company) | Short Q&A with cached public knowledge, ≈ $0.02–0.03 per question; 2,000–3,000 questions/month | ≈ **$50–100** |

Set a Console spend limit on the shared-bot workspace at about 2× the estimate during the pilot. The per-profile budget (task 2.5) stops any single bot from running away with the bill.

**Data handling:** the Team plan and the Console API are under Anthropic's Commercial Terms: inputs are not used for training by default; standard retention is 30 days. Record this in task 0.3.

**Alternatives kept on file:** pure API billing with no seats (cheaper only if nobody wants interactive Claude); Claude on Microsoft Foundry (billed through GDEX's Azure; shared bots could move there by configuration change).

### 10.4 Hardware

Anthropic's guidance is about 1 GiB RAM and 1 CPU per concurrently running agent as a floor. Idle bots cost far less: an idle bot is a WebSocket, while a running turn is a Claude Code process.

| Stage | Expected peak concurrent runs | VM |
|---|---|---|
| Weeks 3–10: execs + HR Agent | ≈ 8–12 | 8 vCPU / 32 GB / 200 GB |
| Week 11+: + HR Help company-wide + ≈30 selected staff, each its own instance (≈150 MB idle each) | ≈ 15–25 | Grow to 16 vCPU / 64 GB when monitoring shows sustained queueing or memory above 70 % |
| Wider staff rollout (Phase 5) | ≈ 30+ | Second VM for staff assistants, or tier-B sandboxed shared instance (§6) |

The host-wide concurrency cap (task 2.5) queues runs instead of exhausting memory.

### 10.5 Alternatives considered

| Alternative | Verdict |
|---|---|
| One shared C-level bot | Doable, but weaker isolation and later delivery for no saving (§5.2). Not chosen |
| Opening the HR Agent to the whole company | Would expose internal HR material to everyone. Replaced by the separate HR Help bot (§4.4) |
| Department bots that act with each member's personal login (v1 design) | Doable, but every department bot would hold many people's tokens and need per-user routing and sandboxing. Replaced by the two-bot model |
| Anthropic Managed Agents | Could replace our sandbox code later, but needs the bridge rewritten against its API and moves more data flow outside GDEX. Re-evaluate in Phase 5 |
| Lark native AI (Aily / Base AI) | Fine for simple FAQ bots but cannot run lark-cli, hooks, MCP or n8n; availability and licensing unclear for GDEX's tenant. Not chosen |
| More per-laptop installs | Rejected (§2.2) |
| Azure-hosted | Pays off at ≥5 tenants with public ingress (ADR-0048); this system needs no ingress |

---

## 11. Timeline

```
Week   1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20
P0     ██ ██                                                        decisions, VM, Lark apps, exec briefing, selected roles named
Exec         ██ ██ ██ ░░ ░░ ░░                                      wk3–4 Teong+Yinn · wk5 Nicholas+Caren+Salwa · wk6–8 skills r1
HR Agent     ██ ██ ██ ██ ██ ██                                      wk3–5 v1 with volunteers · wk6–8 all of HR
HR Help                        ██ ██ ██                             wk9 build · wk10 pilot (2 depts) · wk11 whole company
Staff PA                       ██ ██ ██ ██ ██                       wk9–11 onboarding + template + security review · wk12–13 first selected roles
P4                                            ██ ██ ██ ██ ██ ██ ██  HR Help leave/claims (wk14–16) · Finance (wk15–17) · Ops (wk17–19)
Leadership                           ░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░ ░░  optional, ≈1 week, only if executives confirm
Milestones  ▲wk2 decisions+apps  ▲wk4 CEO & CFO live  ▲wk5 all 5 execs + HR Agent v1  ▲wk8 HR pilot done
            ▲wk11 HR Help company-wide  ▲wk13 first selected staff live  ▲wk16 leave via HR Help  ▲wk20 3 departments in production
```

**Critical path:** billing decision (0.2) and Lark apps (0.5) gate the executives, the HR Agent and HR Help. HR's approval of public pages (2.9) gates HR Help. The selected-role list (0.9) and the security review (3.7) gate staff assistants.

**Executives are not on the critical path of any engineering.** Their assistants run on today's code and only need scripts and Lark apps.

**Staffing:** 1 engineer full-time; ≈0.3 IT (VM, Ansible, backups); DPO in weeks 1–2 and 12–13; each department knowledge owner ≈3 h/week during onboarding, ≈1 h/week after.

---

## 12. Risks and open questions

| Risk | Mitigation |
|---|---|
| Team seats can't sign in headlessly on the server, or the session expires | Spike S1 in week 1; fallback: personal assistants also use the API key (pooled credits plus pay-as-you-go), and seats cover interactive use only |
| An executive's assistant hits the Standard seat's usage limit | Watch from week 4; move that person to a Premium seat (USD 125); contingency in §10.3 |
| Shared bots exhaust the pooled USD 500 credit mid-month and stop | Turn on auto-reload or buy credits up front; Console spend limit at 2× estimate; alert at 80 % |
| Anthropic changes plan credits or limits again (changed June and October 2026) | Seat tracker and costs reviewed monthly; the shared bots' billing can move to pure API or Foundry by configuration change |
| PDPA: employee mail and documents processed by a US vendor | DPA and retention terms before personal assistants go live; s.7 notice; personal logins only by the person's own OAuth consent |
| Lark tenant policy blocks employee-created apps | Ask in week 1 (0.6); fallback: Lark admin creates staff apps in batches, with the person as owner (manageable with selected roles) |
| Internal HR content ends up in HR Help | Separate instance and Linux user; deploy copies only `handbook/public/`; bot shared only with the public wiki space; red-team case in 3.7 |
| HR Help gives a confident wrong answer to the whole company | HR approves every public page; citations always on; handover to HR when unsure; weekly review of HR Help answers for the first month |
| Staff outside the selected roles feel left out | HR Help is available to everyone from week 11; communicate the selected-role rollout as a first wave with criteria for the next |
| Department bot shared with restricted content by mistake | Sharing rule (§7.1) in the knowledge-owner checklist; quarterly review of what each bot can see |
| Prompt injection through email or documents | Command allowlist, per-person isolation, bot-only identity for department bots, audit log, red team (3.7) |
| Executives distrust "admins can see everything" | Separate Linux users, named root holders with logged access, optional zero-data-retention; disclosed in the week-1 briefing |
| Staff assistant costs grow with adoption | Per-person budget cap, Staff workspace cap, monthly review |
| Knowledge goes stale and wrong answers erode trust | Named knowledge owner, weekly pilot review, citations always on, "I don't know, ask HR at …" fallback |
| Single VM is a single failure domain | Hypervisor HA and snapshots; Ansible rebuild; nightly backup of `/srv/lark` |
| Upstream bridge changes | Keep GDEX changes in a fork as small, upstreamable PRs |

### 12.1 Decisions (2026-10-12)

| # | Question | Decision | Effect on the plan |
|---|---|---|---|
| 1 | Model for executives | **Sonnet 5.5**, same default as every bot | One default everywhere; Opus 5.5 available per skill or person later (§10.3) |
| 2 | May executives' assistants message each other? | **No.** Each assistant answers only its owner | Owner-only behaviour as built; no allowlist work (§5.1) |
| 3 | Leadership Agent | **In the plan, low priority**; confirm with the executives | Asked at the week-1 briefing (0.7); built only on request (4.5) |
| 4 | Staff personal assistants | **Selected roles first** | Management names roles (0.9); tier A for all; sandbox engineering deferred to Phase 5 (§6) |
| 5 | Department bots for other departments' questions | **Yes, through a public HR bot** | New **HR Help** bot for the whole company with public HR knowledge only (§4.4, Phase 3) |

### 12.2 Still open

1. **Who owns operations after week 20: the AI team or IT?** *Pending discussion.* Needs a named owner before the week-19 handover (4.6).
2. **Which roles are in the first wave of staff assistants, and how many people?** Task 0.9, management.
3. **Do the executives want the Leadership Agent?** Ask at the week-1 briefing.

---

## 13. Appendix

### A. Files most affected

| Area | Files |
|---|---|
| Access and scoping | `src/policy/access.ts`, `src/config/profile-schema.ts`, new `src/policy/department-sync.ts` |
| Prompting | `src/agent/bridge-system-prompt.ts`, `src/agent/claude/adapter.ts` |
| Runtime env (API key per workspace, sender ID per run) | `src/runtime/agent-runtime.ts`, `src/agent/types.ts`, `src/agent/claude/adapter.ts` |
| Sandbox (tier B, Phase 5 only if needed) | `src/platform/spawn.ts`, new `src/platform/sandbox.ts` |
| Budgets and concurrency | `src/bot/process-pool.ts`, `src/bot/run-flow.ts` |
| Self-service onboarding | `src/ui/qr-register.ts`, `src/ui/onboard.ts`, `src/ui/server.ts` |
| Observability | `src/observability/events.ts`, `src/core/telemetry.ts` |
| Deployment (done 2026-10-18) | `deploy/systemd/lark-bridge@.service` (hardened per-instance system unit), `deploy/workspace-template/.claude/settings.json` (workspace-mode permissions), `deploy/README.md`; optional `EnvironmentFile=<home>/service.env` in the built-in user unit (`src/daemon/systemd.ts`) |
| Scripts (new) | `deploy/new-instance.sh` (automates deploy/README.md §2–4), `scripts/knowledge-sync.ts`, `scripts/offboard.sh`, `deploy/ansible/` |

### B. Sources

- Claude Code / Agent SDK hosting and multi-tenant isolation: https://code.claude.com/docs/en/agent-sdk/hosting
- Anthropic subscription vs programmatic usage (June 2026): https://www.theregister.com/ai-ml/2026/05/14/anthropic-tosses-agents-into-the-api-billing-pool/5240748 ; https://autonomee.ai/blog/claude-code-terms-of-service-explained/ ; https://www.morphllm.com/claude-code-subscription
- Claude plans and pricing: https://claude.com/pricing
- Monthly API credits for Max and Team plans (USD 20/Standard seat, pooled, USD 500 cap, linked Console org): https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans
- Agent SDK and `claude -p` with a Claude plan: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Claude Code with Team or Enterprise plans (included with every Team seat): https://support.claude.com/en/articles/11845131-use-claude-code-with-your-team-or-enterprise-plan
- Server authentication for Claude Code: https://autonomee.ai/blog/claude-code-server-vps-authentication-guide/
- Claude Managed Agents and self-hosted sandboxes: https://www.analyticsvidhya.com/blog/2026/06/claude-managed-agents/ ; https://pasqualepillitteri.it/en/news/2854/claude-managed-agents-self-hosted-sandboxes-mcp-tunnels
- lark-cli (identities, device flow, skills): https://github.com/larksuite/cli
- Multi-tenant isolation for Agent SDK hosting: https://agentpatterns.ai/security/multi-tenant-isolation-knobs-agent-sdk/
- GDEX precedents: `recruitment-workflow-automation/docs/decisions/0048-on-premise-ubuntu-hosting.md`, `0050-ai-vendor-cross-border-transfer.md`, `0022-azure-interim-multiteam-n8n-platform.md`
