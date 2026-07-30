# Supervising a Grok Build instance from a phone

**Goal:** run the VSS Mapping Toolkit build on a host PC under Grok Build, and supervise it from a mobile device with roughly the fidelity `/remote-control` gives in Claude Code — cheaply, with no cloud infrastructure.

**Companion document:** [`vss-mapping-toolkit-design.md`](./vss-mapping-toolkit-design.md). That document's §0.7 (definition of done) and per-unit acceptance criteria *are* the supervision checklist used here. This runbook is the delivery mechanism for it.

---

## 1. The principle: supervise by gate, not by gaze

The instinctive setup is SSH into tmux and watch the TUI. That works and you should have it — but it is the wrong *primary* channel, for three reasons:

- A TUI on a 6-inch screen is unreadable at the density Grok Build renders at.
- Watching is unbounded attention. A 9-unit build is days of wall-clock time.
- Attention spent watching produces nothing durable. Attention spent defining a gate produces a check that runs forever.

So: the agent does not report to you, **the repository does**. Every claim the agent makes about progress is either machine-verified or it isn't a claim. Your phone consumes three things only — a red/green signal, a one-screen status file, and blocking questions. You open a terminal only when one of those says to.

This is also the cheap answer in tokens. The agent isn't narrating, re-summarising, or waiting; it works until a gate flips.

### Three channels, three jobs

| Channel | Job | On the phone | Cost |
|---|---|---|---|
| **Alert** — ntfy | Tells you *when* to look | ntfy app push | free |
| **Signal** — git + CI + `STATUS.md` | Tells you *what* the state is | GitHub app | free tier |
| **Control** — Tailscale + SSH + tmux | Lets you *intervene* | Termius / Termux | free |

Alert and Signal are read-only and cover ~90 % of touchpoints. Control is for the other 10 %.

---

## 2. One-time setup (~30 minutes)

### 2.1 Reachability

```bash
# Host PC
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4                     # note this address
```

Install Tailscale on the phone, sign in to the same tailnet. The free plan covers 3 users / 100 devices — ample. No port forwarding, no public exposure, works from cellular.

Keep the host awake — this is the single most common cause of a dead overnight run:

```bash
# Linux
systemd-inhibit --what=sleep:idle --why="grok build" sleep infinity &
# macOS
caffeinate -dims &
# Windows: Settings > Power > Sleep = Never (and disable USB selective suspend)
```

SSH keys, not passwords. On the phone: **Termius** (free tier is enough) or **Blink** on iOS, **Termux** on Android.

### 2.2 The session

Always run Grok Build inside tmux so a dropped cellular connection never kills the build:

```bash
tmux new -As build
grok
# detach with ctrl-b d — the agent keeps working
```

In `~/.tmux.conf`:

```
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",*256col*:Tc"
set -g allow-passthrough on
set -g set-clipboard on
set -g history-limit 50000
set -g mouse on
```

Grok Build ships `grok wrap ssh …` for better remote PTY behaviour and terminal restore on disconnect — use it for the SSH hop rather than raw `ssh` when attaching from the phone.

### 2.3 Alerts

Pick an unguessable topic name (ntfy topics are public-by-name on the free instance — treat the name as a secret, and never send code or signal names through it):

```bash
echo 'export NTFY_TOPIC=vssbuild-8f3a91c2e7' >> ~/.profile
```

`scripts/notify.sh`:

```sh
#!/bin/sh
# usage: notify.sh <title> <message> [priority]
: "${NTFY_TOPIC:?set NTFY_TOPIC}"
curl -sS --max-time 10 \
  -H "Title: $1" -H "Priority: ${3:-default}" -H "Tags: robot" \
  -d "$2" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null || true
```

Install the ntfy app on the phone, subscribe to the topic. Self-host later if the topic-name-as-secret model bothers you; the protocol is identical.

### 2.4 The gate

This is the load-bearing piece. `Makefile`:

```make
.PHONY: gate lint types layers test conformance bench
gate: lint types layers test conformance
	@echo GATE PASS

lint:        ; ruff check vss_mapping tests
types:       ; mypy --strict vss_mapping
layers:      ; lint-imports                    # §0.2 dependency rule
test:        ; pytest tests/unit -q --cov=vss_mapping --cov-fail-under=90
conformance: ; pytest tests/conformance -q     # §0.6 replaceability suites
bench:       ; python -m tests.gold.bench --min-top5 0.80 --min-top1 0.55
```

`make gate` returning 0 is the entire definition of "the agent's work is acceptable so far". Everything in design §0.7 is in there. `bench` is separate because it is slow and only gates Unit 4.

### 2.5 CI as your mobile dashboard

`.github/workflows/gate.yml`:

```yaml
name: gate
on: [push, pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -e ".[dev]"
      - run: make gate
```

The GitHub mobile app then gives you, for free, the dashboard nobody built for Grok Build: per-commit green/red, per-branch history, log tails, and push notifications on failure. A green check on a branch is a stronger statement than anything the agent could tell you in prose.

> **If the source data is confidential** (design §0.8 — customer DBCs usually are): keep the repo private, and if even that is unacceptable, drop CI and let `make gate` run locally with `notify.sh` as the only signal. You lose the dashboard, not the gate.

### 2.6 Heartbeat and watchdog — zero tokens

Do *not* use the agent's `/loop` for status heartbeats; that spends model calls on something a cron job does for free. Host crontab:

```cron
# every 20 min: if no commit for 45 min while a session is live, warn
*/20 * * * * cd ~/vss-mapping && ~/scripts/watchdog.sh
```

`scripts/watchdog.sh`:

```sh
#!/bin/sh
cd "$(dirname "$0")/.." || exit 0
tmux has-session -t build 2>/dev/null || exit 0
last=$(git log -1 --format=%ct)
now=$(date +%s)
idle=$(( (now - last) / 60 ))
[ "$idle" -lt 45 ] && exit 0
scripts/notify.sh "Build idle ${idle}m" "$(tail -c 400 STATUS.md)" high
```

That single script catches the two silent failure modes — agent stuck in a retry loop, and agent finished but waiting on a TUI prompt — which are otherwise invisible until morning.

---

## 3. What the agent must honour (paste this into the session)

The following is the supervision contract. It costs the agent very little and is what makes the phone side work. Put it in `AGENTS.md` / `GROK.md` at the repo root so it survives session restarts and `/resume`.

```markdown
# Supervision contract

## Branching
- One branch per unit: `unit-1-core`, `unit-2-ingest`, … Never commit to `main`.
- Open a PR when a unit's gate is green. Do not merge your own PR; merging is the
  human's approval step.

## Every commit
- Update `STATUS.md` (format below) in the same commit. A commit that does not
  move STATUS.md forward is not a reportable unit of progress.
- Commit message first line: `unit-N: <what changed>`.

## Gates
- Run `make gate` before every push. Never push red knowingly; if red is
  unavoidable, push it with `WIP RED:` prefixed on the commit subject and say why
  in STATUS.md.
- Unit 4 additionally requires `make bench` to meet its thresholds.

## Blocking questions
- Never sit idle waiting on a human. When a decision is needed:
  1. Append a numbered entry to `QUESTIONS.md` with the options and your
     recommended default.
  2. Proceed on that default, and on everything that does not depend on it.
  3. Run `scripts/notify.sh "Q<n> open" "<one-line question>"`.
- The human answers by appending to `ANSWERS.md`. Re-read it at the start of every
  session and before each unit boundary. If an answer contradicts what you built,
  say so and correct it.

## Notifications (use sparingly — these reach a phone)
- unit gate green: `notify.sh "unit-N green" "<PR url>"`
- unit gate red after two repair attempts: `notify.sh "unit-N RED" "<failing check>" high`
- question opened: as above
- Nothing else. Do not notify on ordinary progress.

## Never
- Never send source signal names, descriptions, or file contents to a hosted model
  unless `allow_llm` is explicitly enabled for that run (design §0.8).
- Never commit a real DBC/ARXML file. Fixtures are synthetic only.
- Never edit `tests/conformance/` to make an implementation pass (design §0.6).
- Never widen a unit's public interface without updating the design doc in the
  same PR.
```

`STATUS.md`, rewritten each commit — one phone screen, no scrolling:

```markdown
# Build status
updated: 2026-07-30T14:02Z · commit 36f925e · branch unit-4-suggest

UNIT:    4/9 SuggestionEngine — EmbeddingSuggester
GATE:    PASS  (units 0–3 merged)
BENCH:   top1 0.58 · top5 0.83 · MRR 0.71 · abstain 0.60   [gate: top1≥0.55 top5≥0.80]
NEXT:    HybridSuggester merge, then calibration buckets
BLOCKED: none
OPEN Q:  Q3 (embedding model — proceeding on local bge-m3)
```

---

## 4. Your loop, from the phone

Steady state is **four taps, twice a day**:

1. ntfy push arrives → read the title. No push, no action needed.
2. GitHub app → the branch's check mark. Green means the gate passed; that is the whole verdict.
3. Tap `STATUS.md` → one screen of state.
4. If a unit is complete: review the PR **contract-first, not diff-first** (§5), then merge. Merging is your approval.

You open a terminal only for: a red gate the agent couldn't repair, answering a question that can't wait, or redirecting the plan. Then:

```bash
ssh host -t 'tmux attach -t build'
```

Answering a question without attaching is often easier — GitHub's mobile web editor can append to `ANSWERS.md` directly, and the agent picks it up at the next unit boundary.

---

## 5. Reviewing a unit on a phone

Do not read the diff. On a phone you cannot review 800 lines of Python meaningfully, and pretending otherwise is how rubber-stamping starts. Review the *contract*, which is five short checks and fits the screen:

1. **Interface match.** Does the PR body quote the unit's public interface, and does it match the design doc — or did the PR update the doc in the same commit? (Silent interface drift is the failure this catches.)
2. **Gate green**, including `lint-imports`. Layering violations are the cheapest architectural damage to catch and the most expensive to undo later.
3. **Conformance suite exists and was not edited.** Check the PR's file list for changes under `tests/conformance/`. Any change there needs a stated reason.
4. **Unit-specific acceptance criteria** from the design doc, each with a named test. The PR body should list them; spot-check one.
5. **`STATUS.md` and the numbers.** For Unit 4, the bench line against its thresholds; elsewhere, coverage.

If all five hold, merge. If (1) or (3) fails, that's a request-changes regardless of how green everything else is.

The nine gates, mapped to the design doc's build order:

| Gate | Unit | The one thing that matters most here |
|---|---|---|
| 0 | Gold set + metrics harness | ≥100 labelled signals incl. ~10 with no valid target — built *before* Unit 4 |
| 1 | CoreSignalModel | zero intra-package imports; `signal_id` stable across processes; expression AST rejects all five escapes |
| 2 | SourceIngester | synthetic DBC covers extended ids, endianness, signed, float, multiplex, `VAL_` |
| 3 | VSSKnowledgeBase | offline cold start works; `UnitRegistry` offset case (°C↔K) exact |
| 4 | SuggestionEngine | `make bench` thresholds **and** the calibration bucket check |
| 5 | MappingStore | export→import round-trip; stale-revision lock raises |
| 6 | ValidationEngine | every issue code has a positive *and* negative test |
| 7 | ArtifactGenerator | real `vss-tools` validates the overlay in CI, not a regex |
| 8 | MappingOrchestrator | end-to-end on the synthetic DBC with every unit faked |
| 9 | CLI | touches only the orchestrator |

Nine merge decisions across the whole build. That is the entire supervision budget.

---

## 6. Grok-Build-specific notes

**Plan Mode is a desk tool, not a phone tool.** `/plan` blocks on interactive approval in the TUI, which is exactly the pattern that strands an overnight run. Use it deliberately: run Plan Mode at a *desk* when starting a unit, approve there, then let the unit run unattended. For unattended stretches, have the agent write its plan to `docs/plans/unit-N.md` and proceed under stated assumptions rather than blocking — the branch-plus-gate structure means a wrong plan costs you one branch, not a broken `main`.

**Permissions vs. unattended running.** Unattended work means the agent runs commands without per-call approval, which is precisely when you can't watch. Contain it structurally instead of trusting it: work in a per-unit branch or worktree, never `main`; scope the agent's working directory to the project; keep credentials out of the environment it runs in; and let `make gate` plus your merge be the only path into `main`. Broad auto-approval inside a disposable branch is a sane trade; broad auto-approval on `main` is not.

**Subagents and worktrees** suit units 2/3 and 5/6, which are mutually independent in the build order — two units can progress in parallel branches. Do not parallelise across a dependency edge; a subagent building Unit 4 against an unfinished Unit 3 will invent its own interface.

**Headless mode is the right tool for the gate, not for supervision.** `grok -p "…" --output-format streaming-json` is useful for scripted repair attempts (e.g. a wrapper that reruns the agent once on a red gate before notifying you). Keep the interactive session for the build itself.

**ACP wrappers** (`grok-remote` and similar, over Tailscale) give a genuinely nicer mobile PWA than SSH, and Grok Build supports ACP officially. Worth adding *after* the above works — they improve the Control channel, which is the one you'll use least. Unofficial tools in the path that carry your prompts and code deserve the same scrutiny as any dependency; the ntfy + GitHub combination has no such exposure.

**Session persistence.** `/sessions` and `/resume` recover a killed session, but the durable state is the repo — `AGENTS.md`, `STATUS.md`, `QUESTIONS.md`, `ANSWERS.md`, and the branch. Assume the session context will be lost at least once and make sure that costs nothing but a `/resume`.

---

## 7. Cost

| Item | Plan | Cost |
|---|---|---|
| Tailscale | free (3 users / 100 devices) | $0 |
| ntfy.sh | free public instance | $0 |
| GitHub Actions | free tier (public unlimited; 2 000 min/mo private) | $0 |
| Termius / Termux | free tier | $0 |
| GitHub + ntfy mobile apps | free | $0 |
| Host PC | your existing machine, kept awake | electricity |
| Model usage | Grok Build subscription; unaffected by this setup — and reduced, since the agent narrates less and cron handles heartbeats | — |

No VM, no tunnel service, no dashboard hosting, no per-seat tooling.

---

## 8. Failure modes and recovery

| Symptom | Cause | Recovery |
|---|---|---|
| Silence, no pushes, watchdog fired | host slept | fix power settings; `tmux attach` and `/resume` |
| ntfy silent but git also silent | agent waiting on a TUI prompt | attach, answer, and tighten the contract so it writes to `QUESTIONS.md` instead |
| Gate red overnight, many commits | agent looping on the same failure | attach, read the last gate output, fix or reduce scope by hand; cap repair attempts at two in the contract |
| Gate green but PR obviously wrong | gate too weak for that unit | add the missing check to `make gate` — never fix it by watching harder |
| Conformance suite edited | agent made the test fit the code | revert, re-run, treat as a request-changes; this is the one violation worth being strict about |
| Phone can't reach host | Tailscale logged out / key expiry | re-auth; consider disabling key expiry for the host node |
| Interfaces drifted from the design doc | doc not updated in the same PR | enforce check (1) in §5; drift compounds across units |

---

## 9. Setup checklist

- [ ] Tailscale on host + phone; host sleep disabled
- [ ] SSH keys; Termius/Termux configured with a saved host
- [ ] `tmux new -As build`, `~/.tmux.conf` as above
- [ ] `NTFY_TOPIC` exported; `scripts/notify.sh`; ntfy app subscribed
- [ ] `Makefile` with `gate` + `bench`; `ruff`, `mypy`, `import-linter`, `pytest` in dev deps
- [ ] `.github/workflows/gate.yml`; repo private if source data is confidential
- [ ] `scripts/watchdog.sh` + crontab entry
- [ ] `AGENTS.md` containing §3's supervision contract
- [ ] `STATUS.md`, `QUESTIONS.md`, `ANSWERS.md` seeded
- [ ] `main` protected: no direct pushes, gate required to merge
- [ ] End-to-end smoke test: break something on purpose, confirm red CI + ntfy push land on the phone **before** starting the real build
