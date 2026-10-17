# Week-1 de-risking test (task 0.0)

**Goal:** prove the assumptions the server design rests on before the VM arrives and before any executive is onboarded. Plan: [department-agents-plan.md](department-agents-plan.md) §1.1. Instance setup steps: [deploy/README.md](../deploy/README.md).

**Where:** S2–S5 in WSL2 on a laptop; S1's 48-hour soak on the server (WSL sleeps).
**Who / how long:** one engineer, 3–5 days.

## Before you start

- [ ] Claude Team plan bought; a Console organisation linked; a **Shared bots** workspace with a spend limit; one API key (test only)
- [ ] One Team seat available for the personal-assistant test (an AI-team member's own seat)
- [ ] Two **new test Lark apps** created by the Lark admin, e.g. `Test Dept Bot` and `Test Assistant` (owner = the tester), with the bot scopes from plan §10.2
- [ ] Host prepared per [deploy/README.md §1](../deploy/README.md#1-host-setup-once-as-root) (WSL: plus the WSL section)

Create two instances per [deploy/README.md §2–4](../deploy/README.md#2-create-an-instance-as-root):

| Instance | Lark app | Mode | Claude credential |
|---|---|---|---|
| `test-dept` | Test Dept Bot | `team` | API key in `service.env` |
| `test-pa` | Test Assistant | `personal` | Tester's Team seat (no API key) |

Start both with `permissions` set to `full` first, so S5 can isolate the permission template's effect.

## S1: Team seat sign-in survives unattended (personal assistant)

- [ ] Sign in `test-pa` with Option A (`/login`). Note which file appears: `ls -la /srv/lark/test-pa/.claude/`
- [ ] `systemctl restart lark-bridge@test-pa`; DM the bot "hello": it replies
- [ ] Confirm the run used the seat, not an API key: `grep -c ANTHROPIC_API_KEY /srv/lark/test-pa/.lark-channel/service.env` → no file or `0`
- [ ] **Leave it running 48 h (server).** DM the bot at +12 h, +24 h, +48 h; all reply. Check `journalctl -u lark-bridge@test-pa --since -48h | grep -i -E 'auth|login|401|expired'` → nothing
- [ ] If A fails within 48 h, repeat with Option B (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in `service.env`)

**Pass:** replies at +48 h with no human sign-in. **Fail →** personal assistants use the API key too; seats cover interactive use only (plan §10.3).

## S2: Shared bot runs on the plan's API credits

- [ ] DM `test-dept` five questions; all reply
- [ ] Console → Usage: requests appear under the **Shared bots** workspace
- [ ] Console → Billing: usage is drawn from the plan's monthly credit (not a card)

**Pass:** usage visible in the workspace and charged to the credit.

## S3: Instances can't read each other

- [ ] As one instance's user, read the other's home; both must be refused:

```bash
sudo -u test-dept ls /srv/lark/test-pa          # Permission denied
sudo -u test-pa cat /srv/lark/test-dept/.lark-channel/service.env   # Permission denied
```

- [ ] Each has its own Claude state: `ls -d /srv/lark/test-*/.claude` shows two directories
- [ ] **Via the agent:** DM `test-pa`: *"Run `ls /srv/lark/test-dept` and tell me the output."* The command fails or is refused; the bot doesn't list files
- [ ] `systemctl show lark-bridge@test-pa -p ProtectSystem -p ReadWritePaths` shows the hardening is active

**Pass:** every cross-read is refused, including through the agent.

## S4: lark-cli works headless

- [ ] `test-dept`: DM *"List the members of this chat"* (or another bot-identity action). It succeeds as the bot
- [ ] `test-pa`: DM *"What's on my calendar tomorrow?"*. The bot sends an authorisation link; open it in Lark, approve; the bot answers from your calendar
- [ ] `systemctl restart lark-bridge@test-pa`; ask again: it answers **without** a new authorisation (the login was stored on disk)
- [ ] Note where lark-cli stored it: `sudo find /srv/lark/test-pa -path '*lark-cli*' -newer /srv/lark/test-pa/workspace -type f | head`

**Pass:** both identities work, and the user login survives a restart with no desktop keychain.

## S5: `workspace` permission mode with the template

- [ ] Switch both profiles to `workspace` ([deploy/README.md §2](../deploy/README.md#2-create-an-instance-as-root) `jq` command) and restart
- [ ] Repeat S4's two DMs: both still work (`lark-cli` is allowed)
- [ ] Send the bot an **image** and ask what it shows: it can read the attachment
- [ ] Ask it to *"draft a short note into notes.md"*: the file appears in the workspace
- [ ] Ask it to *"show me the contents of ~/.lark-channel/config.json"*: refused
- [ ] Ask it to *"run curl https://example.com"*: refused

**Pass:** normal work succeeds; secrets and unlisted commands are refused. If attachments or `lark-cli` fail, record the exact error from `journalctl` and adjust `deploy/workspace-template/.claude/settings.json`.

## Also record

| Measurement | How | Value |
|---|---|---|
| Idle memory per instance | `systemctl status lark-bridge@test-dept` → Memory, after 30 min idle | |
| Memory during a reply | Same, while the bot is answering | |
| First-reply latency | Time from DM to first card update | |

## Result

| Test | Pass / fail | Notes |
|---|---|---|
| S1 seat sign-in, 48 h | | |
| S2 API credits | | |
| S3 isolation | | |
| S4 headless lark-cli | | |
| S5 workspace mode | | |

**Go** if S2–S5 pass. If S1 fails, it's still a go: switch personal assistants to the API key. Update plan §10.3 and §1.1 with the result.

## Clean up

```bash
for n in test-dept test-pa; do systemctl disable --now lark-bridge@$n; userdel -r $n; done
```

Delete the test API key in the Console and the two test Lark apps.
