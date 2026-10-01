# PROC — PUBLISH

Publishing is deterministic and reversible-safe.

## Preconditions

- Matrix row status = PASS (qa_score ≥ 75 recorded).
- Draft `_drafts/<ID>.html` exists (wrapped by `wrap-drafts.js`).
- QA evidence `data/qa/<ID>.json` exists with `result: "PASS"`, `score ≥ 75`,
  and `draft_sha256` equal to the SHA-256 of the CURRENT draft bytes.
  Any edit to the draft after QA changes the hash ⇒ publish REFUSES
  (`QA_EVIDENCE_STALE / DRAFT_CHANGED_AFTER_QA`); the engine never auto-updates
  the hash — re-run `qa` instead. Missing evidence ⇒ `QA_EVIDENCE_MISSING`;
  `result != PASS` ⇒ `QA_EVIDENCE_NOT_PASS`; low score ⇒
  `QA_EVIDENCE_BELOW_THRESHOLD`. An existing archive for a PASS row ⇒
  `AMBIGUOUS` (resolve per docs/PROC-RECOVERY.md, never stage over it).
- Grounding gate: every quantitative claim in the draft (VND amounts, %,
  phút/giờ durations) must be covered by `claim_evidence` entries in
  `data/research/<ID>.json` (see docs/SOURCE-POLICY.md). Ungrounded ⇒ REFUSE.

## Atomic two-phase publish (`factory.js publishStage` → `publishCommit`)

`publish` (bare) = stage + immediate commit (test/sandbox quick path). The
production path is the operator, which commits ONLY after build + verify PASS.

1. `publishStage(ids)` — gate (PASS + qa_score + hash-bound evidence +
   grounding) BEFORE any mutation; then record a pre-state journal
   (`rows_before`, `checkpoint_before` bytes, `files`), open a `phase: STAGED`
   transaction, copy the draft to `data/published/<ID>.html` +
   `site/<output_path>index.html`, flip matrix rows to PUBLISHED, and write the
   checkpoint. Drafts stay INTACT; the ledger is untouched.
2. (operator, Simple Production Mode) `build-site.js` → `reports` →
   `verifyStepsStaged(scope, tx, ids)` — all while the transaction is STAGED.
   FAST staged verify = staged consistency + grounding of the staged ids ONLY:
   `factory.js consistency --staged-tx <TXID> [--staged-ids ...]` accepts
   EXACTLY the in-flight publish transaction (id + operation `publish` +
   phase `STAGED` + journal ⊇ staged ids) and nothing else; `grounding` is
   narrowed to the staged ids. DEEP/FULL staged verify additionally runs
   `capacity-check.js --staged-tx <TXID>` and `editorial-audit` (deep) /
   full-site grounding + deterministic rebuild (full). editorial-audit NEVER
   blocks a normal FAST publish. Every non-staged caller still
   requires transaction inactive + lock free — the production invariant is
   never weakened, and a mismatched transaction inside the window FAILS hard.
   `tests/test-suite.js` runs OUTSIDE the staged window: it is the CI gate on
   the committed tree (post-commit), because its "tx inactive" invariant IS the
   post-commit contract. The staged window never runs the suite against itself.
3. `publishCommit` — only on full PASS: remove the drafts, append the REAL
   ledger event, add the ids to `grounding.required_ids` (audited forever),
   clear the transaction, release the lock.
4. `publishRollback(reason)` — on ANY failure: restore matrix rows and the
   checkpoint bytes from the journal, remove the files the stage created
   (durable archive, staged `site/` copy AND the promoted public root page),
   rebuild the site (deterministic self-heal), clear the transaction, release
   the lock. Never reports success after a rollback.

## PUBLISHED means (all must hold — consistency checks enforce)

- public file exists at the repository root `<output_path>index.html` (promoted from `site/` by `scripts/site/build-site.js`)
- a DE-PUBLISHED row (PUBLISHED → REPAIR/BLOCKED) must VANISH from the public
  root: `build-site.js` writes a deterministic manifest of exactly the
  generated public outputs (`data/state/build-manifest.json`) and prunes every
  previous-build entry no longer in the current build (only generated pages —
  scripts/, config/, data/, tests/, docs/, .github/, reports/ sources and
  AGENTS.md are never touchable by the prune, hard guard). Sitemap, search,
  hub and knowledge index regenerate from the current PUBLISHED set only.
- canonical correct
- matrix row status PUBLISHED
- URL present in the correct sitemap shard
- article listed on its hub page

## Draft safety

Unpublished drafts live in `_drafts/` (gitignored, never deployed).
`build-site.js` restores published articles only from `data/published/`.
A "public draft leak" is a critical QA failure.

## last_completed_id contract

`last_completed_id` = the last id of the CONTIGUOUS COMPLETED PREFIX in matrix
order (rows from the top while status = PUBLISHED). It is NEVER the max id of
all PUBLISHED rows: pilot articles published at far-away ids (e.g. A09401)
must never push the pointer past the real production prefix. With
A00001..A00014 published: `last_completed_id = A00014`,
`next_claimable_id = A00015`.

## Chunk invariant (hard, canonical engine)

- `factory.js publish` publishes AT MOST `CHUNK` (10) articles per operation
  — enforced in the engine, not just the operator.
- More than 10 explicit IDs ⇒ the engine REFUSES (exit 1); it never silently
  publishes 10 and drops the rest. Split the ids into chunks of ≤ 10.
- Without explicit IDs, publish takes at most the current chunk of PASS rows —
  never the whole PASS backlog.
- The operator command contract caps `ids`/`count` at 10 as well
  (`scripts/factory/operator.js`).

## Bootstrap cap

At most 10 pilot articles may be published during bootstrap
(`config/content-factory.json: max_publication_in_bootstrap`). The publish
command refuses to exceed it. Mass publishing waits for pilot learnings.

## Push-driven production (golden orchestration — factory-production.yml)

`scripts/factory/operator.js` wraps every canonical publish-flow step behind a
whitelist command contract. The production loop is PUSH-DRIVEN (the
/vanchinh + /blog model): the writer commits a TURBO WRITE-AHEAD QUEUE into
`_drafts/` (2..20 consecutive PLANNED ids — `A#####.html` wrapped +
`A#####.body.html` + `data/research/<ID>.json` each, all in ONE commit) and
pushes; `.github/workflows/factory-production.yml` does the rest — the old
command-file channel is retired.

- **Push contract**: `scripts/factory/push-selection.js` derives the EXACT
  article ids from the `_drafts/` diff of the push, validates them (no
  duplicate, no PUBLISHED/BLOCKED row, no skip against matrix order — the
  queue must start at the first PLANNED row and be contiguous), sorts them by
  repository/matrix order and splits them into sequential 2-article PAIRS.
  PLANNED rows → new claims (the queue, 2..20 ids); RESEARCH/WRITING/QA/
  REVIEW/REPAIR/PASS rows → repair (QA only, no new claims, ≤ `chunk_size`).
  REFUSED (exit 3, nothing executed, nothing mutated): unknown id,
  PUBLISHED/BLOCKED row, mixed new+repair, fewer than `queue_min` (2) or more
  than `queue_max` (20) ids (`data/state/production-control.json`), a hole
  inside the queue span, body-only push, missing research packet. No drafts in
  the push → skip (the publish commit deletes drafts — a D-only diff — so the
  loop never re-triggers itself).
  production-control `enabled=false` → clean stop BEFORE claiming (paused).
- **Pair consumption**: the workflow recovers, claims the WHOLE queue with ONE
  `prepare-next --ids`, then processes the pairs sequentially inside the SAME
  production run: research → QA fast (PASS ≥ 75 / REVIEW 70–74 → repair) →
  publish PASS rows only (atomic stage → build → staged verify) → checkpoint
  → next pair. A FAILED pair is kept recoverable (draft intact, open row,
  reported with its exact ids) and NEVER rolls back pairs already published;
  the run continues with the remaining pairs and the final commit still
  pushes every successfully published pair. QA thresholds are unchanged.
- **Writer direct CLI** (same tooling, local/maintenance):
  `operator.js publish --ids A00002,A00003 --scope deep` — the FULL whitelist
  including `qa`/`publish`; the workflow calls the same CLI.

- Ops: `status, prepare-next, research, qa, publish, recover, consistency,
  reports, verify`. Validation: op whitelist, `ids` match `A#####`, `count`
  1..10, `scope` ∈ {fast, deep, full}; unknown fields are rejected. No shell
  interpolation, no eval of user input.
- RECOVER FIRST: every mutating op re-reads repository truth, refuses while a
  transaction is active or a live writer lock is held. Unclear lock ownership
  or an unsafe transaction ⇒ STOP (never force-clear).
- RESUME BEFORE CLAIM: `prepare-next` refuses while an unfinished chunk
  (RESEARCH/WRITING/QA/REVIEW/REPAIR/PASS rows) exists.
- QA scopes (thresholds NEVER change — Simple Production Mode):
  `fast` = production default for prepare-next/research/qa/publish =
  scoped consistency of the CURRENT ids only (`factory.js consistency --ids`
  / `--chunk`: tx/lock sanity, matrix uniques, checkpoint↔matrix coherence,
  selected-id invariants) — for publish: staged consistency + selected-ID
  grounding. FAST never runs the full test-suite, capacity-check,
  editorial-audit or a whole-site audit; the normal 2-article pair pays only
  for its own scope. `deep` = fast + `node --test tests/test-suite.js` +
  capacity-check + editorial-audit. `full` = deep + full-site grounding +
  deterministic rebuild (build-site). The scope abstraction lives in
  canonical tooling (`operator.js verify --scope`), never in YAML.
- DRAFT BOUNDARY (push-driven): `_drafts/` IS committed (the push-driven loop
  needs drafts on Actions) but GitHub Pages runs Jekyll, and Jekyll NEVER
  publishes underscore directories — drafts are never served publicly. The
  engine enforces the contract: `.nojekyll` must be ABSENT and `_drafts/` must
  NOT be gitignored (factory.js consistency + capacity-check.js).
- FINAL-TREE VERIFY + SAFE PUSH (workflow): stage canonical outputs →
  `git write-tree` (verified tree hash) → run canonical verify on exactly the
  tree to be committed → commit only if the tree is unchanged; push is
  fast-forward only, with fetch→rebase on race (conflict ⇒ STOP; a successful
  rebase REQUIRES re-verify). Never force push.
- Single coordinator: concurrency group `lab-factory-production`,
  `cancel-in-progress: false`; the publish commit deletes the drafts (a
  D-only diff), so the loop never re-triggers itself.

## Validation model (4 tiers — MANDATORY)

"CI green" is only valid when every tier that applies to the scope of the
change is PASS. Never claim production-safe from unit tests alone.

- **Tier 1 — Unit**: `node --test tests/test-suite.js`
  (deterministic unit/regression contracts: gates, whitelists, rollback,
  push-selection contract, concurrency contract, watchdog states).
- **Tier 2 — Integration**: operator sandbox E2E + deterministic build.
- **Tier 3 — Production invariant**: consistency + grounding + capacity-check
  + state preservation + no-drift.
- **Tier 4 — Long-run / Failure recovery / Liveness**: multi-chunk soak
  (`node --test tests/soak/factory-soak.js`) with fault injection
  (crash-after-beginTx, crash-after-publishStage, build/audit/verify failure,
  stale lock) + deterministic recover + liveness watchdog
  (`scripts/factory/liveness-watchdog.js`, READ-ONLY).

Engine/workflow/recovery changes REQUIRE Tier 4 — and CI ENFORCES it:
`.github/workflows/factory-soak.yml` runs the soak suite on both
`pull_request` and `push` to `main` (path-filtered to reliability-relevant
files: engine, site builder, soak suite, static regression suite, all
reliability workflows, static engine-contract configs, docs contract files).
A direct push of engine/workflow/recovery changes to main therefore cannot
land without Tier 4. Normal content runtime state updates (matrix shards,
`data/state/**`, published archives, qa evidence, runtime
`config/content-factory.json` grounding ids) are production DATA, not engine
changes — they do NOT trigger the soak. A prose-only article change does NOT
trigger the soak; its push runs exactly ONE lightweight content validation
(`ci-validate.yml`: scoped consistency + grounding of the changed ids +
deterministic build + draft-leak guard). The deep batteries
(`factory-validate.yml`, `factory-capacity-validate.yml`) are path-filtered
to the same reliability contract and never run on a content-only push.

CI/invariants can be green while the factory is stalled (unfinished work
standing, command hanging, expired lock, over-age transaction) — Tier 4 +
the liveness watchdog close that blind spot. CI green is NOT liveness green
until Tier 4 has actually run for the change. The watchdog is READ-ONLY and
FAILS CLOSED (STATE_MISSING / STATE_INVALID, exit 1) when canonical truth
(matrix shards or checkpoint/transaction/writer-lock/throughput-ledger) is
missing or corrupt — it never silently reports a fake healthy state
(see `docs/PROC-RECOVERY.md`).

A failing tier means: do NOT merge, do NOT lower thresholds or delete tests,
do NOT mutate production truth; fix the root cause and re-run the affected
tier and every tier above it.
