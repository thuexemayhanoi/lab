# CONTENT FACTORY

The factory is a deterministic pipeline that plans, researches, writes, QAs
and publishes articles from a fixed 10,000-row matrix.

## Units

- BATCH = 50 articles
- CHUNK = 10 articles (the ENGINE hard cap: `publish` refuses more than CHUNK ids)
- Standard production pair = 2 articles (the normal loop claims 2 at a time)
- 10,000 articles = 200 batches × 50

## Simple production loop (normal content)

The NORMAL writer flow is a light 2-article pair loop — FAST by default:

```
FETCH → RECOVER/RESUME → PREPARE 2 → RESEARCH per row requirement →
WRITE 2 → WRAP → QA FAST (scoped to the pair) → REPAIR if needed →
PUBLISH (atomic, FAST) → LIGHT VERIFY → COMMIT/PUSH → CI/PAGES → NEXT 2
```

- Standard pair = 2 articles (`factory.js prepare-next --count 2`); CHUNK=10
  stays the engine hard cap.
- FAST checks only what the current pair touches: transaction/lock sanity,
  selected IDs, research/QA contracts, grounding where required, staged
  consistency, checkpoint↔matrix coherence for the pair. FAST NEVER runs the
  full test-suite, capacity-check, editorial audit or soak.
- DEEP = FAST + `node --test tests/test-suite.js` + capacity-check +
  editorial audit.
- FULL = DEEP + full grounding + full deterministic rebuild + full production
  invariants.
- Tier 4 (soak + watchdog) is for engine/workflow/recovery changes or
  scheduled maintenance — never per pair.
- Normal content pushes use ONE lightweight content validation path
  (`ci-validate.yml`); full engine validation runs only when engine files
  change.

## Matrix contract

`data/content-matrix.csv` — exactly 10,000 production rows.

The CANONICAL committed form is the 4 shards
(`data/content-matrix.csv.part00..03`); the assembled CSV is gitignored and
is NOT repository truth. Any tool that needs the matrix must read/assemble
the canonical shards deterministically (byte-identical concatenation,
part00..NN order). Per-tool behavior is precise, NOT interchangeable:
- `factory.js` (read-write engine) assembles the CSV from shards on load and
  rewrites shards on save.
- `scripts/factory/liveness-watchdog.js` (READ-ONLY) never writes the
  assembled CSV: it uses the assembled CSV if it exists AND is valid,
  otherwise assembles IN-MEMORY from the canonical shards; if the canonical
  matrix is missing/malformed or a critical state file
  (checkpoint/transaction/writer-lock/throughput-ledger) is missing/invalid
  it FAILS CLOSED (STATE_MISSING / STATE_INVALID, exit 1) — no silent
  fallback to matrixRows=0 or a fake healthy state. Clean checkout (shards
  only) and writer checkout read the same truth.
Never edit the CSV by hand — use the factory CLI.

Required fields: article_id, cluster, parent_topic, primary_keyword,
secondary_keywords, search_intent, geo_id, geo_level, province, locality,
poi, brand, model, vehicle_type, part, use_case, duration, requires_research,
requires_official_sources, actual_service_area, cannibalization_group, slug,
output_path, canonical, status, research_status, qa_score, repair_attempts,
published_date.

## Status lifecycle

```
PLANNED → RESEARCH → WRITING → QA → PASS → PUBLISHED
                     QA → REPAIR → QA (max 3) → PASS/BLOCKED
                     QA → REVIEW (70–74) → QA (max 3) → PASS/BLOCKED
```

REVIEW (qa_score 70–74) is a **non-terminal** state: never publish a REVIEW
row; repair and re-QA it. A chunk is unfinished while ANY row is
`RESEARCH/WRITING/QA/REVIEW/REPAIR/PASS`; `prepare-next` refuses until every
row of the current chunk reaches `PUBLISHED` or `BLOCKED` (only then may a
new chunk be claimed).

## Commands

```
factory.js status            # matrix stats + checkpoint; assembles CSV
factory.js prepare-next [n]  # next n rows PLANNED -> RESEARCH (default chunk 10)
factory.js research <ID>      # mark research done (packet must exist)
factory.js qa <ID>            # QA the draft; scores into matrix
factory.js publish <ID>...    # atomic two-phase: stage (QA-hash + grounding gate) -> commit (drop draft, ledger)
factory.js grounding          # claim grounding gate: quantitative claims need verified claim_evidence
factory.js qa-repair <ID>     # re-score a PUBLISHED archive; binds fresh evidence to the exact archive bytes
                             #   (hard cap: at most CHUNK=10 per operation; >10 IDs => REFUSE;
                             #    no IDs => at most the current chunk of PASS rows)
factory.js recover            # resume interrupted transaction
factory.js consistency        # invariants: uniques, sitemap match, published files exist
factory.js reports            # regenerate reports/factory/*.json
```

## Roles

- **Writer (external AI)**: research packet → draft body `_drafts/<ID>.body.html`
  → `wrap-drafts.js` → commit + PUSH (`factory-production.yml` runs qa/publish).
  Never an API key in Actions.
- **Actions**: tests, validation, deterministic generation, publish promotion,
  reports, deploy. Never writes article prose.

## Safety

- Only one writer mutates production (writer lock + transaction marker).
- Bootstrap publication cap: 10 pilot articles (`config/content-factory.json`).
- Never rewrite PUBLISHED rows silently.
- Push-driven production (see `docs/PROC-PUBLISH.md` "Push-driven
  production"): the writer commits `_drafts/` drafts + research packets and
  pushes; `factory-production.yml` derives the EXACT ids via
  `scripts/factory/push-selection.js` (refuses unknown/PUBLISHED/BLOCKED/mixed/
  >chunk_size ids) and drives the whitelist CLI `scripts/factory/operator.js`
  — recover-first, `prepare-next --ids` (resume-before-claim, EXACT rows),
  QA scopes fast/deep/full (thresholds never change), atomic publish,
  final-tree verify + safe push, single coordinator
  `lab-factory-production`. `_drafts/` is committed but Jekyll never serves
  underscore directories — drafts are never public.
- Build manifest: `data/state/build-manifest.json` records EXACTLY the
  generated public outputs promoted to the repo root; every build prunes
  previous-build entries that are no longer generated (de-published pages
  vanish; source trees are hard-guarded, never prunable). Deterministic,
  sorted, committed alongside the tree it describes.
- `capacity-check.js --staged-tx <TXID>`: staged-aware mode used ONLY inside
  the atomic publish window — accepts exactly the in-flight STAGED publish
  transaction holding the publish lock; every other state FAILS as usual.
- `prep-pilot.js` is a LEGACY BOOTSTRAP-ONLY tool: it REFUSES unless
  `config.phase === 'PILOT'` AND `checkpoint.published_count === 0`, before
  touching any file. Production never runs it (`prepare-next` is the path).
- Throughput ledger: `data/state/throughput-ledger.json` records REAL measured
  events only (prepare/research/qa/publish, appended by the canonical ops).
  `factory.js reports` derives `reports/factory/throughput.json` from it —
  no backfill, no estimates; `effective_articles_per_hour` stays null until
  ≥2 real publish events span a measurable window.

## Phase lifecycle: PILOT → PRODUCTION

- `config/content-factory.json` carries `"phase"` (`PILOT` | `PRODUCTION`).
- In `PILOT`, `publish` and `prepare-next` honor `max_publication_in_bootstrap` (10 pilot articles).
- Once the pilot is complete (all pilot articles PUBLISHED, QA ≥ 90, archives present,
  no active transaction), the **canonical transition** is:

  ```
  node scripts/factory/factory.js promote-production
  ```

  It refuses to run twice, refuses an incomplete/unhealthy pilot, uses the writer
  lock + transaction marker, and only flips `phase` (config + checkpoint).
  Matrix, article IDs, published set and QA evidence are untouched.
- In `PRODUCTION`, the bootstrap cap no longer binds; the normal chunk size remains
  `CHUNK` (10) — enforced by the canonical engine: `publish` refuses more than
  `CHUNK` ids and, without ids, takes at most the current chunk of PASS rows.
  The external AI writer remains the only prose writer; GitHub Actions
  stays deterministic (no API keys, no autonomous writing).

## Validation model (4 tiers — MANDATORY)

"CI green" is only valid when every tier that applies to the scope of the
change is PASS. Never claim production-safe from unit tests alone.

- **Tier 1 — Unit**: `node --test tests/test-suite.js`
  (deterministic unit/regression contracts).
- **Tier 2 — Integration**: operator sandbox E2E + deterministic build.
- **Tier 3 — Production invariant**: consistency + grounding + capacity-check
  + state preservation + no-drift.
- **Tier 4 — Long-run / Failure recovery / Liveness**: multi-chunk soak
  (`node --test tests/soak/factory-soak.js`) with fault injection +
  deterministic recover + liveness watchdog
  (`scripts/factory/liveness-watchdog.js`, READ-ONLY: HEALTHY IDLE is PASS —
  user resting is never a failure; stale command, stalled active chunk,
  expired lock + unfinished work and over-age transactions are detected).

Engine/workflow/recovery changes REQUIRE Tier 4 — and CI ENFORCES it:
`factory-soak.yml` runs on both `pull_request` and `push` to `main`
(path-filtered to reliability-relevant files: `scripts/factory/**`,
`.github/workflows/**`, `tests/soak/**`, `tests/test-suite.js`, recovery
config/contracts). Normal content runtime updates (matrix status, `data/state/**`,
research packets, drafts, `config/content-factory.json` grounding ids) are
deliberately OUTSIDE that path filter — publishing a pair must NOT trigger
Tier 4, and engine changes must not be able to skip it. A direct push of
engine/workflow/recovery changes to main cannot land without Tier 4. CI
green is NOT liveness green if Tier 4 has not run for the change. The
liveness watchdog reads canonical truth and FAILS CLOSED
(STATE_MISSING / STATE_INVALID) when that truth is missing or corrupt.
A failing tier means: do NOT
merge, do NOT lower thresholds or delete tests, do NOT mutate production truth
to make tests green; fix the root cause and re-run the affected tier and every
tier above it.
