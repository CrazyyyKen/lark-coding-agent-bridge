# Handover: GDEX Lark Agents Platform

**As of:** 2026-10-18 · **From:** AI team (ai@gdexpress.com) · **Status:** planning done, server deployment files written; the **week-1 test (spike) has not been run yet**. That is your first job.

Read this first, then [department-agents-plan.md](department-agents-plan.md) for the full reasoning. You don't need the plan to start the next step; this page is enough.

---

## 1. What we're building, in one paragraph

Today a few teammates run `lark-channel-bridge` (this repo) on their own laptops, which needs IT admin rights per laptop and stops when the laptop sleeps. We're moving it to **one on-prem Ubuntu server** that runs every bot as its **own instance under its own Linux user**:

- **Department Agents** (HR Agent, later Finance and Ops) are shared by a department and use only the bot's own Lark identity.
- **HR Help** is a company-wide bot answering general HR questions from a public subset of HR knowledge.
- **Personal Assistants** use their owner's own Lark login: first for the five executives, then for selected staff roles.

All of them use **Sonnet 5.5** and one **Claude Team plan**.

## 2. Decisions already made (don't reopen without the owner)

| Date | Decision |
|---|---|
| 2026-10-09 | Host on an **on-prem Ubuntu VM**, outbound-only (same posture as the recruitment project's ADR-0048) |
| 2026-10-09 | **Two-bot model:** shared bots never hold anyone's personal Lark login; personal data only lives in that person's own assistant |
| 2026-10-09 | Executives (Mr Teong, Mr Nicholas, Ms Yinn, Ms Caren, Ms Salwa) get **one assistant each**, never one shared C-level bot. Their #1 concern is that nothing passes between them |
| 2026-10-09 | Every bot runs as a **separate instance under a separate Linux user**, not several bots in one bridge process. One process means one OS user, so a manipulated agent could read sibling folders, and all agents would share one `~/.claude` |
| 2026-10-12 | **Sonnet 5.5** is the default model for all bots, executives included |
| 2026-10-12 | Executives' assistants **never message each other** |
| 2026-10-12 | **HR Help** for the whole company, with public HR knowledge only, as a separate bot from the internal HR Agent |
| 2026-10-12 | Staff personal assistants go to **selected roles first**, so the number stays small and every one gets its own instance. The per-run sandbox ("tier B") is deferred |
| 2026-10-12 | **Leadership Agent** (shared by executives, bot identity only) stays in the plan as low priority, built only if the executives ask |
| 2026-10-13 | Claude billing: **Claude Team plan**, Standard seats at USD 25/month. Personal assistants sign in with **their owner's own seat**. Shared bots use an **API key** from the Console org linked to the plan, paid by the plan's pooled monthly API credits (USD 20 per seat, capped at USD 500/month). Seat tracker: plan §10.3 |

## 3. Still open (not blocking the next step)

| Question | Needed by | Who decides |
|---|---|---|
| Who owns operations after week 20: AI team or IT | Week 19 | Management (pending discussion) |
| Which staff roles get personal assistants first, and how many people | Week 9 | Management (plan task 0.9) |
| Do the executives want the Leadership Agent | Any time | Executives, asked at their briefing |

## 4. What's done

**Documents**

| File | What it is |
|---|---|
| [docs/department-agents-plan.md](department-agents-plan.md) | Full plan v3: requirements, architecture, C-level design, isolation, knowledge layer, phases, costs, seat tracker, risks. §1.1 has the week-1 next steps and gates |
| [docs/spike-checklist.md](spike-checklist.md) | Step-by-step week-1 test (S1–S5) with commands and pass/fail criteria |
| [deploy/README.md](../deploy/README.md) | How to set up the host and create a bot instance, on a server or in WSL2 |
| docs/HANDOVER.md | This page |

**Code and deployment files**

| File | Change | Verified? |
|---|---|---|
| [src/daemon/systemd.ts](../src/daemon/systemd.ts) | The built-in user service now reads an optional `<LARK_CHANNEL_HOME>/service.env` (e.g. for `ANTHROPIC_API_KEY`) | ✅ unit test added and passing; typecheck clean |
| [tests/unit/daemon/profile-args.test.ts](../tests/unit/daemon/profile-args.test.ts) | Asserts the new `EnvironmentFile=` line | ✅ |
| [deploy/systemd/lark-bridge@.service](../deploy/systemd/lark-bridge@.service) | Hardened **system** template unit: one instance per Linux user, home `/srv/lark/<name>`, writes only inside its own home, Claude auto-update off | ⚠️ not yet run on Linux; spike S3/S4 test it |
| [deploy/workspace-template/.claude/settings.json](../deploy/workspace-template/.claude/settings.json) | Claude Code permissions for `workspace` mode: allows `lark-cli` and reading attachments, blocks reading bridge secrets and logins | ⚠️ not yet run against a live bot; spike S5 tests it |

**Test status:** on Windows, `npx vitest run tests/unit/daemon` shows 3 failures in `launchd-autostart.test.ts`. They are **pre-existing and unrelated**: they fail identically without these changes. They're macOS-only tests, and CI runs them on macOS. Everything else passes.

## 5. Your next steps

### Step 1: commit and push (day 1)

The changes above are uncommitted on `main`. Put them on a branch and open a PR:

```bash
git checkout -b feat/server-deploy
git add docs/ deploy/ src/daemon/systemd.ts tests/unit/daemon/profile-args.test.ts
git commit -m "feat: server deployment templates, spike checklist and platform plan"
git push -u origin feat/server-deploy
```

### Step 2: week-1 actions with lead time (start day 1, in parallel)

These are owned by other people. Your job is to raise them and chase them. Details are in plan §1.1, Track B.

- [ ] **Buy the Claude Team plan** (7 Standard seats: 2 admins + 5 executives) and link a Claude Console org. *The API credits can only be claimed after the plan has been active 7 days.*
- [ ] **IT:** request the VM: Ubuntu 24.04, 8 vCPU / 32 GB / 200 GB, outbound 443 only, in the backup schedule
- [ ] **Lark admin:** one ticket for the HR Agent, HR Help and five executive apps, plus **two test apps for the spike**; scopes in plan §10.2; also ask whether employees may create their own apps (plan task 0.6)
- [ ] **DPO:** start the PDPA assessment. It must be signed off **before executives' email reaches Claude in week 3**
- [ ] **HR:** name the HR knowledge owner; start the handbook, with public pages under `handbook/public/`
- [ ] Book the 30-minute **executive briefing** (plan task 0.7)

### Step 3: run the spike (days 2–5)

Follow [docs/spike-checklist.md](spike-checklist.md). In short:

| Test | Proves | Where |
|---|---|---|
| S1 | A Team seat sign-in keeps working unattended for 48 h | Server (WSL sleeps) |
| S2 | A shared bot's API key draws from the plan's credits | WSL OK |
| S3 | Two instances can't read each other's files, even through the agent | WSL OK |
| S4 | lark-cli works headless (bot identity, and a user's login that survives a restart) | WSL OK |
| S5 | `workspace` mode plus the permission template: normal work succeeds, secrets are refused | WSL OK |

WSL setup: set `systemd=true` and `appendWindowsPath=false` in `/etc/wsl.conf` (see [deploy/README.md](../deploy/README.md)). **Use the test Lark apps, not a teammate's live bot.** If two machines connect the same app, Lark splits the messages between them.

**When done:** fill in the results table at the bottom of the checklist, then update plan §1.1 and §10.3. If S1 fails, personal assistants switch to the API key, and seats cover only people's own interactive use.

### Step 4: after the spike (weeks 2–5, plan Phase 1)

1. Write `scripts/new-instance.sh` to automate [deploy/README.md](../deploy/README.md) §2–4, adjusted for whatever the spike found.
2. Write the Ansible playbook for the host setup (deploy/README.md §1). Write it during the build, not after.
3. Onboard **Mr Teong and Ms Yinn** (week 3–4), then **Mr Nicholas, Ms Caren and Ms Salwa** (week 5). Run the isolation checklist (plan task 1.5) before each handover.
4. **HR Agent v1** with 3 HR volunteers (week 5).

The full phase plan is in plan §9; the timeline is in §11.

## 6. Things that will bite you

- **An API key overrides the seat sign-in.** Never put `ANTHROPIC_API_KEY` in a personal assistant's `service.env`, or it will bill the shared credits instead of the owner's seat.
- **Never copy an instance's folder between machines or Linux users.** The bridge encrypts its secrets with a key derived from the hostname and username ([keystore.ts](../src/config/keystore.ts)). Create every instance fresh, and don't rename the server after setup.
- **The first run must be in the foreground** (`sudo -u <name> -H lark-channel-bridge run`). The bridge only sets up lark-cli when it has a terminal; as a service it skips that step.
- **Don't use `lark-channel-bridge start` on the server.** It installs a per-user unit (`systemctl --user`), which needs lingering and a user session per account. Use the `lark-bridge@<name>` template instead.
- **`workspace` mode without the template breaks the bot.** No one can approve a command in a chat bot, so every `lark-cli` call is refused. Copy `deploy/workspace-template/.claude` into each bot's workspace.
- **Shared bots stop if the pooled credit runs out mid-month.** Set auto-reload or buy credits, and alert at 80 % (plan §12).

## 7. Where things are

| Need | Look at |
|---|---|
| Why a decision was made | Plan §5 (executives), §6 (isolation), §7 (access rules), §10.3 (billing) |
| Seat count and costs | Plan §10.3, the seat tracker. Update it when people or bots change |
| Week-by-week schedule | Plan §11 |
| Risks | Plan §12 |
| GDEX precedents (hosting, PDPA) | `recruitment-workflow-automation/docs/decisions/0048-…`, `0050-…` |
| Bridge internals | [README.md](../README.md); access rules in [src/policy/access.ts](../src/policy/access.ts); profile config in [src/config/profile-schema.ts](../src/config/profile-schema.ts) |
