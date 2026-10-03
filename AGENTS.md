# AGENTS.md — SINGLE ENTRY POINT (READ THIS FIRST)

Any AI agent (writer, researcher, QA, operator) working in this repository
**MUST read this file first**, then follow the routing below.

## What this repository is

`lab` is an SEO research lab covering the nationwide Vietnamese motorbike
ecosystem, published as a static GitHub Pages site:

- Public URL: https://thuexemayhanoi.github.io/lab/
- Base path prefix: `/lab/`
- It is NOT the main rental business site. It tests whether low-competition
  local + long-tail queries can rank WITHOUT active backlink building.
- Zero-active-backlink baseline: **YES** (see `config/seo-experiment.json`).

## NORMAL WRITER FLOW (push-driven — the ONLY loop a writer needs)

Standard push = **a TURBO write-ahead queue of 2..20 articles**
(`queue_min`..`queue_max` in `data/state/production-control.json`; the legacy
`chunk_size=2` still caps REPAIR pushes). The factory consumes the queue as
sequential 2-article pairs inside ONE production run. Every writer run pushes
and does NOT stop after one:

```
FETCH FRESH MAIN → RECOVER (if txn/lock pending) → RESUME (finish the open
chunk first — repair pushes BEFORE pushing new queues)
→ PICK QUEUE     2..20 CONSECUTIVE claimable PLANNED rows starting at
                 next_claimable_id (repository/matrix order — no skips)
→ RESEARCH       write data/research/<ID>.json (light packet for evergreen
                 rows; OFFICIAL sources mandatory when requires_official_sources=1)
→ WRITE QUEUE    drafts in _drafts/<ID>.body.html (every queued id)
→ WRAP           node scripts/factory/wrap-drafts.js
→ COMMIT + PUSH  _drafts/<ID>.html + <ID>.body.html + research packets
                 (the whole queue in ONE commit)
→ FACTORY RUNS ITSELF (factory-production.yml): push-selection.js validates
  + sorts the queue ids and splits them into PAIRS → recover → ONE
  prepare-next --ids claim for the whole queue → per PAIR sequentially:
  research → qa fast (PASS ≥ 75 / REVIEW 70–74 → repair) → publish PASS only
  (atomic) → checkpoint → NEXT PAIR. A failed pair stays recoverable and is
  reported; already-published pairs are NEVER rolled back.
→ REPAIR         (only if QA < 75 — fix _drafts/<ID>.body.html, wrap, PUSH
  again; max 3 attempts, then BLOCKED)
→ CI/PAGES       (ONE lightweight content validation runs per push)
→ FETCH FRESH MAIN → NEXT QUEUE → REPEAT
```

FAST = the production default scope. It verifies ONLY the current scope:
transaction/lock sanity, selected ids, research/QA contracts, QA score +
hash-bound evidence, grounding of the published ids, staged consistency,
checkpoint/matrix coherence of the current chunk. It NEVER runs the full
test-suite, capacity-check, editorial audit or soak — those are DEEP/FULL/
Tier-4 gates (see "Validation model" below). Draft boundary: `_drafts/` IS
committed (the loop is push-driven) but Jekyll never serves underscore
directories — Pages never publishes a draft.

A writer does NOT need to read the whole reliability system before every
2-article pair. Deep hardening details live in `docs/CONTENT-FACTORY.md`,
`docs/PROC-PUBLISH.md` and `docs/PROC-RECOVERY.md`.

## QA modes (thresholds NEVER change with scope)

- **FAST** — normal 2-article production (default for prepare-next/research/
  qa/publish): scoped consistency of the current ids only + publish gates.
- **DEEP** — FAST + `node --test tests/test-suite.js` + capacity-check +
  editorial-audit.
- **FULL** — DEEP + full-site grounding + deterministic rebuild (build-site).
- **TIER 4** — soak + liveness watchdog. For engine/workflow/recovery changes
  or scheduled maintenance ONLY — never per article pair.

## Core topic clusters

THUÊ XE MÁY (rental — dominant cluster) · CỨU HỘ (rescue) · SỬA CHỮA / BẢO DƯỠNG
(repair) · BẰNG LÁI (licence) · ĐĂNG KÝ / THUẾ / BIỂN SỐ (registration) ·
XE MÁY ĐIỆN (electric) · PHỤ TÙNG (parts).

## Canonical documents (read in this order)

1. `docs/CONTENT-FACTORY.md` — batch/chunk model, commands, roles
2. `docs/ARTICLE-RULES.md` — structure, length, titles, meta
3. `docs/RESEARCH-BEFORE-WRITE.md` — mandatory research packets
4. `docs/SOURCE-POLICY.md` + `config/source-policy.json` — official sources
5. `docs/SEO-OWNERSHIP.md` — who may claim what service where
6. `docs/GEO-LOCAL-SEO.md` — geography & local-intent model
7. `docs/PROC-RESEARCH.md`, `docs/PROC-QA.md`, `docs/PROC-PUBLISH.md`, `docs/PROC-RECOVERY.md`
8. `docs/EXPERIMENT-METRICS.md` — measurement plan
9. `docs/EDITORIAL-SYSTEM.md` — shared editorial design system (writers write
   semantic markup only; presentation lives in `scripts/site/style.css`,
   `scripts/site/menu.js`, `scripts/site/shell.js`)

## Hard rules (violations = QA critical failure)

- NEVER invent addresses, businesses, testing centers, rescue services, prices
  stated as fact, laws, or government authorities.
- Non-Hanoi pages are informational/directory only — no fake local service
  claims, no "chúng tôi" service claims outside the verified Hanoi service area.
- Every article needs a research packet (`data/research/<ID>.json`) BEFORE writing.
- Research depth follows the MATRIX requirement, not habit: low-risk evergreen
  rows need only a light packet; `requires_official_sources=1` rows must cite
  current authoritative sources or be BLOCKED; quantitative claims (VND/%/
  durations) need `claim_evidence` (grounding gate).
- Official-source articles (`requires_official_sources=1`) must cite current
  authoritative sources or be BLOCKED.
- QA pass threshold ≥ 75. REVIEW 70–74 (never publish; repair). Repair ≤ 3
  attempts, then BLOCKED. Critical factual/legal failures FAIL hard at any score.
- Word range 1,600–3,000 Vietnamese words. No filler/keyword stuffing.
- Only PUBLISHED pages may be publicly deployed. Drafts live in `_drafts/`
  (gitignored, never deployed).
- Max publication during bootstrap: 10 pilot articles (config: `content-factory.json`).
- Max publication per operation: `CHUNK` = 10 articles — the engine refuses
  more than 10 ids and never sweeps the whole PASS backlog in one publish.
  The standard production pair is 2 (`prepare-next --count 2`).
- Phase lifecycle: `PILOT` → `PRODUCTION` via `node scripts/factory/factory.js promote-production`
  (canonical transition; bootstrap cap only binds in PILOT). See `docs/CONTENT-FACTORY.md`.
- Autonomous pipeline (the ONLY sanctioned AI-writer path in Actions):
  job `pipeline` in `factory-production.yml` runs
  `scripts/factory/pipeline.js cycle` on the `*/30 * * * *` schedule. It only
  writes when the writer runtime is explicitly configured:
  `WRITER_RUNTIME=http` + `WRITER_ENDPOINT` (GitHub Variables) and optional
  `WRITER_API_KEY` (GitHub Secret). Default `WRITER_RUNTIME=off` =
  IDLE-STOP BEFORE claiming (queue still refills; nothing written,
  nothing published). `WRITER_RUNTIME=mock` requires PIPELINE_ALLOW_MOCK=1
  and is test-only. Secrets live in GitHub Secrets — NEVER committed.
  No other autonomous AI writer, no API keys in the repo tree.
- No backlink campaigns. Do not create external links to manipulate rankings.

## Data contracts

- `data/content-matrix.csv` — EXACTLY 10,000 production rows.
  The CANONICAL committed form is the 4 shards
  `data/content-matrix.csv.part00..03`; the assembled CSV is gitignored and
  is NOT repository truth. Per-tool behavior (precise — tools are NOT
  interchangeable):
  - `factory.js` (read-write engine) assembles the CSV from shards on load
    and rewrites shards on save.
  - `scripts/factory/liveness-watchdog.js` (READ-ONLY) NEVER writes the
    assembled CSV: it uses the assembled CSV if it exists AND is valid,
    otherwise assembles IN-MEMORY from the canonical shards (deterministic
    part00..NN order). If the canonical matrix or any critical state file
    (checkpoint/transaction/writer-lock/throughput-ledger) is missing or
    malformed it FAILS CLOSED — STATE_MISSING / STATE_INVALID, exit 1 —
    never silently falls back to matrixRows=0 or a fake healthy state.
    Clean checkout (shards only) and writer checkout read the same truth.
- `data/geography/*.json` — verified geography only (34 current provinces,
  63 legacy names, localities, hubs, POIs). Never invent places.
- `data/research/<ID>.json` — research packets.
- `data/state/` — checkpoint, writer lock, transaction marker.

## Factory commands

```
node scripts/factory/factory.js status
node scripts/factory/factory.js prepare-next [n]
node scripts/factory/factory.js research <ID>
node scripts/factory/factory.js qa <ID>
node scripts/factory/factory.js publish <ID> [<ID>...]
node scripts/factory/factory.js recover
node scripts/factory/factory.js consistency [--ids A,B | --chunk]
node scripts/factory/factory.js reports
node scripts/factory/wrap-drafts.js        # wrap _drafts/<ID>.body.html -> <ID>.html
node scripts/site/build-site.js           # rebuild site/ from published pages
node scripts/factory/capacity-check.js     # READ-ONLY capacity + state invariants
```

## Factory operator (push-driven production — golden orchestration port)

`scripts/factory/operator.js` is the whitelist command-contract operator
(patterned on the /blog golden factory). There is ONE production loop and
ONE CLI — the old command-file channel is retired:

- **Push-driven production** (`.github/workflows/factory-production.yml`,
  triggered by `_drafts/**` pushes): the writer commits a WRITE-AHEAD QUEUE
  (`_drafts/<ID>.html` + `<ID>.body.html` + `data/research/<ID>.json` for
  2..20 consecutive PLANNED ids in ONE commit) and pushes.
  `scripts/factory/push-selection.js` derives the EXACT ids from the push,
  sorts them by repository/matrix order and splits them into 2-article PAIRS
  (REFUSES unknown/PUBLISHED/BLOCKED ids, mixed new+repair, < `queue_min` 2 or
  > `queue_max` 20 ids, a skip against matrix order (the queue must start at
  the first PLANNED row and leave no unclaimed PLANNED row inside its span),
  body-only, missing research packets — exit 3, nothing executed, nothing
  mutated). The workflow then runs recover-first, claims the whole queue with
  ONE `prepare-next --ids`, and processes the pairs sequentially — per pair:
  research RESEARCH rows, QA, publish PASS rows only (atomic), checkpoint —
  a failed pair stays recoverable and never rolls back published pairs — and
  commits under a final-tree-verify + safe-push (fetch/rebase, never force)
  discipline.
- **Writer direct CLI** (same tooling, for local/maintenance runs):
  `node scripts/factory/operator.js <op> [--ids A00001,A00002] [--count N] [--scope fast|deep|full]`
  The full whitelist `status, prepare-next, research, qa, publish, recover,
  consistency, reports, verify` is available; the production loop calls this
  same CLI, so behavior can never diverge between environments.

Whitelist ops: `status, prepare-next, research, qa, publish, recover,
consistency, reports, verify`. No arbitrary shell; ids must match `A#####`;
count 1..10; scope `fast` (production default: scoped consistency of the
current chunk only — never a full test-suite per micro-op), `deep` (+ test
suite + capacity-check + editorial-audit) or `full` (+ full-site grounding +
deterministic rebuild). Inside an atomic (STAGED) publish the operator runs
the STAGED-AWARE verify contract instead — consistency/capacity-check accept
EXACTLY the in-flight publish transaction (`--staged-tx`), grounding is
narrowed to the staged ids, and the test suite stays a CI gate on the
committed tree (its tx-inactive invariant is never weakened). editorial-audit
joins only at deep/full — it NEVER blocks a normal FAST publish.
`prep-pilot.js` is a LEGACY bootstrap-only tool
(PILOT phase + zero published articles, else it REFUSES); production uses
`prepare-next` only.
Thresholds NEVER change with scope. Mutating ops refuse while a transaction
is active or a live writer lock is held (run `recover` first). Single
coordinator: workflow concurrency group `lab-factory-production`, never
cancel-in-progress; the publish commit deletes the drafts (a D-only diff), so
the loop never re-triggers itself.

DRAFT BOUNDARY (push-driven): `_drafts/` IS committed — the push-driven loop
needs drafts on Actions — but GitHub Pages runs Jekyll, and Jekyll NEVER
publishes underscore directories, so drafts are never served publicly. The
engine enforces the contract (`.nojekyll` must be ABSENT and `_drafts/` must
NOT be gitignored — factory.js consistency + capacity-check.js).


## Validation model (4 tiers — MANDATORY)

"CI green" is only valid when every tier that applies to the scope of the
change is PASS. Never claim production-safe from unit tests alone.

- **Tier 1 — Unit**: `node --test tests/test-suite.js`
  deterministic unit/regression contracts (gates, whitelists, rollback,
  push-selection contract, concurrency contract, watchdog states).
- **Tier 2 — Integration**: operator sandbox E2E + deterministic build
  (sandbox copies prove the real pipeline runs end to end without drift).
- **Tier 3 — Production invariant**: consistency + grounding +
  capacity-check + state preservation + no-drift (checkpoint ↔ matrix ↔
  sitemap ↔ archive ↔ public tree; exactly-once ledger; contiguous prefix).
- **Tier 4 — Long-run / Failure recovery / Liveness**: multi-chunk soak
  (`node --test tests/soak/factory-soak.js`) + fault injection + recover +
  liveness watchdog (`scripts/factory/liveness-watchdog.js`) + pipeline
  suite (`node --test tests/pipeline-suite.js` — coordinator contracts:
  refill, grants, exactly-once publish, crash/resume, stale hygiene).

Rules:
- Engine/workflow/recovery changes REQUIRE Tier 4 (soak + watchdog), not
  just Tier 1. Tier 4 is ENFORCED on CI: `factory-soak.yml` runs on both
  `pull_request` and `push` to `main` (path-filtered to reliability-relevant
  files) — a direct push of engine/workflow/recovery changes to main cannot
  land without Tier 4. CI green is NOT liveness green if Tier 4 has not run
  for the change.
- Tier 4 exists because CI/invariants can be green while the factory is
  stalled (unfinished work standing, stale committed-draft lint, expired lock,
  over-age transaction). The watchdog closes that blind spot; it is
  READ-ONLY (never force-clears, claims or publishes; user resting is
  never a failure: HEALTHY IDLE = PASS) and FAILS CLOSED on missing/corrupt
  canonical truth (STATE_MISSING / STATE_INVALID) — see the liveness
  watchdog contract in `docs/PROC-RECOVERY.md`.
- Failing a tier means: do NOT merge, do NOT lower thresholds or delete
  tests, do NOT mutate production truth to make tests green; fix the root
  cause and re-run the affected tier AND every tier above it.
- Reading Actions in the push-driven model: every push runs the LIGHT
  battery (`ci-validate.yml`); the deep batteries (factory-validate,
  capacity, soak) are PATH-FILTERED to engine/workflow/doc files, so a
  draft push only runs `factory-production.yml`. Two red-looking results
  are BY DESIGN, not engine failures: (a) a REFUSED draft push —
  `push-selection.js` exits 3 and the production job goes RED while
  NOTHING is mutated (fix the draft contract on the writer side, push
  again); (b) a pure-delete/retire commit (D-only diff, e.g. removing a
  retired workflow) matches no path filter, so the deep batteries stay
  pinned to the PREVIOUS commit — when the head tree itself must be
  demonstrated green, re-dispatch the affected battery manually (all
  three accept `workflow_dispatch`). (c) the `pipeline` job of
  `factory-production.yml` runs ONLY on the `*/30 * * * *` schedule or
  `workflow_dispatch` action `pipeline|selftest` (the `publish` job is
  disabled for those events) and is serialized with the publish loop by
  the same global concurrency group — infrastructure edits can never
  accidentally start a production cycle except through that schedule.

## Scope → gates (Simple Production Mode)

- **Content-only change (the normal 2-article pair)** → FAST only: scoped QA
  per article (PASS ≥ 75, no critical), publish gate (QA evidence + grounding
  + atomic transaction), scoped consistency, ONE lightweight content
  validation workflow (`ci-validate.yml`) on push. NO full-site audit, NO
  soak, NO test-suite per pair.
- **Engine/workflow/recovery/config-contract change** → full gates BEFORE
  merge: Tier 1 (`node --test tests/test-suite.js`) + Tier 2 + Tier 3 +
  Tier 4 (soak + watchdog), plus the path-filtered deep CI batteries
  (`factory-validate.yml`, `factory-capacity-validate.yml`, `factory-soak.yml`).
- **Normal content runtime state updates** (matrix shards, `data/state/**`,
  published archives, qa evidence, `config/content-factory.json` grounding
  ids) are PRODUCTION DATA, not engine changes — they do NOT trigger Tier 4
  or the deep batteries.
- Do NOT run a full audit after every 2-article pair. DEEP/FULL verification
  is for engine changes and periodic maintenance, not the content loop.

## Status lifecycle

PLANNED → RESEARCH → WRITING → QA → PASS → PUBLISHED
Failure: QA → REPAIR → QA (max 3 repairs) → BLOCKED.
QA 70–74 ⇒ REVIEW: never publish; repair and re-QA. REVIEW is a non-terminal
state — `prepare-next` refuses while any RESEARCH/WRITING/QA/REVIEW/REPAIR/
PASS row exists (a chunk is claimable only after every row reaches
PUBLISHED or BLOCKED).

Only ONE writer mutates production at a time (writer lock + transaction
marker; see `docs/PROC-RECOVERY.md`).

## Roles

- **External AI writer** (you, typically): research → write draft body →
  wrap → commit + PUSH (the factory runs QA/publish itself).
- **Pipeline coordinator** (`scripts/factory/pipeline.js`, job `pipeline`,
  cron `*/30 * * * *`): the ONLY autonomous writer orchestration — owns
  queue refill (~300 PLANNED, no duplicates/published/in-flight), grants
  12–18 articles/cycle split evenly across 3 parallel writers, QA/repair
  loops, chunked atomic publish, checkpoint/resume exactly-once, and
  lock TTL `pipeline/lock.json` against double coordinators. Writers run
  in isolated gitignored workspaces (`pipeline/writer-<n>/`) and never
  touch global state, merge, push or publish (docs/PIPELINE.md).
- **GitHub Actions**: tests, validation, deterministic generation, publish
  promotion, site build, deployment. The `pipeline` job coordinates the
  autonomous loop; it never bypasses QA or the publish gates.
