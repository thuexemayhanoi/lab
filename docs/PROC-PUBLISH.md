# PROC — PUBLISH

Publishing is deterministic and reversible-safe.

## Preconditions

- Matrix row status = PASS (qa_score ≥ 90 recorded).
- Draft `_drafts/<ID>.html` exists (wrapped by `wrap-drafts.js`).
- QA evidence `data/qa/<ID>.json` exists with `result: "PASS"`, `score ≥ 90`,
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
2. (operator) `build-site.js` → `editorial-audit --out` → `reports` →
   `verifySteps(scope)` — all while the transaction is STAGED.
3. `publishCommit` — only on full PASS: remove the drafts, append the REAL
   ledger event, add the ids to `grounding.required_ids` (audited forever),
   clear the transaction, release the lock.
4. `publishRollback(reason)` — on ANY failure: restore matrix rows and the
   checkpoint bytes from the journal, remove the files the stage created,
   rebuild the site (deterministic self-heal), clear the transaction, release
   the lock. Never reports success after a rollback.

## PUBLISHED means (all must hold — consistency checks enforce)

- public file exists at the repository root `<output_path>index.html` (promoted from `site/` by `scripts/site/build-site.js`)
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

## Operator channel (golden orchestration)

`scripts/factory/operator.js` wraps every canonical publish-flow step behind a
whitelist command contract, so a coordinator drives the factory without shell
access. Channel: `data/state/operator-command.json`
(`{op, ids, count, scope, command_id, coordinator}`), consumed by
`.github/workflows/factory-operator.yml`, or the equivalent direct CLI
(`operator.js publish --ids A00002,A00003 --scope deep`).

- Ops: `status, prepare-next, research, qa, publish, recover, consistency,
  reports, verify`. Validation: op whitelist, `ids` match `A#####`, `count`
  1..10, `scope` ∈ {fast, deep, full}; unknown fields are rejected. No shell
  interpolation, no eval of user input.
- RECOVER FIRST: every mutating op re-reads repository truth, refuses while a
  transaction is active or a live writer lock is held. Unclear lock ownership
  or an unsafe transaction ⇒ STOP (never force-clear).
- RESUME BEFORE CLAIM: `prepare-next` refuses while an unfinished chunk
  (RESEARCH/WRITING/QA/REVIEW/REPAIR/PASS rows) exists.
- QA scopes (thresholds NEVER change): `fast` = consistency + tests
  (production default for prepare-next/qa/publish); `deep` = + capacity-check
  + editorial-audit; `full` = + site build (engine/workflow changes, final
  verification). The scope abstraction lives in canonical tooling
  (`operator.js verify --scope`), never in YAML.
- DRAFT BOUNDARY (/lab): Pages serves the repo ROOT, so `_drafts/` is
  gitignored FOREVER and never committed; `qa`/`publish` run in the writer
  environment via this same CLI (a bare Actions checkout stops safely with
  NO_DRAFT, mutating nothing).
- FINAL-TREE VERIFY + SAFE PUSH (workflow): stage canonical outputs →
  `git write-tree` (verified tree hash) → run canonical verify on exactly the
  tree to be committed → commit only if the tree is unchanged; push is
  fast-forward only, with fetch→rebase on race (conflict ⇒ STOP; a successful
  rebase REQUIRES re-verify). Never force push.
- Single coordinator: concurrency group `lab-factory-production`,
  `cancel-in-progress: false`; an unconsumed command file is never overwritten
  by a newer one.
