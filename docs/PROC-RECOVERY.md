# PROC — RECOVERY (transaction, lock, checkpoint)

Deterministic safeguards so an interrupted run never corrupts production.
Canonical implementation: `scripts/factory/factory.js recover` (the operator
`recover` op calls the same engine). This document mirrors that
implementation exactly — if code and doc ever disagree, the code is the
truth.

## State files (data/state/) — real schemas

- `writer-lock.json` — single-writer gate:
  ```json
  { "locked": false, "holder": null, "acquired_at": null, "expires_at": null }
  ```
  While held: `locked: true`, `holder: "<command>"`, `acquired_at` and
  `expires_at` are ISO-8601 timestamps (TTL 1 hour). A lock is **live** only
  while `locked` is true AND `expires_at` is in the future; an expired lock is
  stale, not live.
- `transaction.json` — in-flight mutation marker:
  ```json
  { "active": false, "id": null, "started_at": null, "operation": null, "articles": [], "notes": "Committed." }
  ```
  In flight: `active: true`, `id: "TX-<epoch-ms>"`, `started_at` ISO,
  `operation: "publish" | "prepare-next" | "promote-production"`,
  `articles: ["A00001", ...]` (the article IDs touched by the operation).
- `checkpoint.json` — progress pointers derived from the matrix:
  ```json
  { "last_run": "2026-09-29T04:24:56.507Z", "phase": "PRODUCTION",
    "matrix_rows": 10000, "published_count": 23, "last_batch": ["A00014"],
    "last_completed_id": "A00014", "next_claimable_id": "A00015",
    "active_chunk": [], "notes": "..." }
  ```
  `published_count`, `last_completed_id`, `next_claimable_id` and
  `active_chunk` are DERIVED from matrix truth; `recover` re-syncs them.
  `last_completed_id` = last id of the CONTIGUOUS COMPLETED PREFIX in matrix
  order — never the lexicographic max of PUBLISHED ids (a pilot at A09401 must
  not move the pointer).

## Locking rules (factory.js)

- Every mutating engine command acquires the lock first; a LIVE lock held by
  another writer ⇒ refuse with exit code 2.
- Lock writes go through `acquireLock`/`releaseLock`; there is no manual
  force-clear path.

## Recovery rules — exactly what `factory.js recover` does

- No active transaction + no live lock ⇒ idempotent success: sync the
  checkpoint pointers from the matrix, exit 0.
- No active transaction + LIVE lock ⇒ **STOP (exit 1)**: ownership unclear,
  the lock is NOT force-unlocked. Wait for the holder to finish or the lock
  to expire.
- No active transaction + stale lock (expired) ⇒ clear the stale lock, close
  the marker, sync the checkpoint, exit 0.
- Active transaction + LIVE lock ⇒ **STOP (exit 1)**: a writer may still be
  running; nothing is cleared.
- Active transaction + no live lock ⇒ resolve **from repository truth**:
  - `publish` with `phase: STAGED` (two-phase publish interrupted anywhere
    between beginTx and commit — after archive/site write, before/after matrix
    save, before checkpoint, before commit): DETERMINISTIC ROLLBACK from the
    pre-state journal (`rows_before`, `checkpoint_before`, `files`). Matrix
    rows, checkpoint bytes and staged files are restored, the site is rebuilt
    (self-heal of hub/sitemap/search index), drafts were never removed, and
    the ledger was never touched. A STAGED transaction WITHOUT a journal is
    ambiguous ⇒ **RECOVER STOP (exit 1)** — resolve manually, never force-clear.
  - `publish` (legacy/committed phase) — per article in `articles`:
    - matrix PUBLISHED **and** archive `data/published/<ID>.html` **and**
      public file present ⇒ completed (roll forward);
    - draft `_drafts/<ID>.html` still present (matrix not PUBLISHED) ⇒ rolled
      back — safe to re-publish later;
    - anything else ⇒ **RECOVER STOP (exit 1)** — the state is ambiguous and
      must be resolved manually; it is never force-cleared.
  - `prepare-next` — the claim is resumable: claimed rows stay in RESEARCH,
    no data loss; close the marker.
  - `promote-production` — config and checkpoint both PRODUCTION ⇒
    completed; both PILOT ⇒ rolled back cleanly; any mismatch ⇒ STOP.
  - any other operation ⇒ STOP (unknown transaction).
- `recover` NEVER rewrites the matrix, NEVER restarts the matrix, NEVER
  rewrites PUBLISHED rows, and NEVER force-clears an ambiguous transaction or
  a live lock.

## Liveness watchdog contract (READ-ONLY, FAIL CLOSED)

`scripts/factory/liveness-watchdog.js` detects "workflows green but the
factory is NOT moving" and is the liveness half of Tier 4. Contract:

- READ-ONLY absolute: never writes, never commits, never pushes, never
  force-clears a lock/transaction, never claims or publishes. On a clean
  checkout it assembles the matrix IN-MEMORY from the canonical shards
  (`data/content-matrix.csv.part00..03`; the assembled CSV is gitignored) —
  direct CLI and GitHub Actions read the same truth, and the workflow
  proves read-only by asserting a clean tree before AND after, plus
  sha256-identical production truth before/after.
- FAIL CLOSED on critical truth: missing file ⇒ `STATE_MISSING`; invalid
  JSON or wrong minimal schema ⇒ `STATE_INVALID` — for the matrix AND for
  `checkpoint.json`, `transaction.json`, `writer-lock.json`,
  `throughput-ledger.json`. It NEVER falls back to `matrixRows=0`,
  `{active:false}` or any fake healthy state: a fatal means FAIL (exit 1),
  even if everything else looks fine. `_drafts/` is OPTIONAL (no drafts is
  normal), but a committed draft whose row is PUBLISHED/BLOCKED or whose id
  is not in the matrix is lint → STALE_DRAFTS (WARN — the watchdog never
  deletes; the publish path must have removed published drafts).
- Detections: HEALTHY IDLE (exit 0 — user resting is never a failure),
  HEALTHY ACTIVE (exit 0), STALE_DRAFTS (exit 2 — committed-draft lint),
  STALLED active
  chunk incl. RESEARCH/WRITING/QA/REVIEW/REPAIR/PASS rows (exit 1),
  EXPIRED_LOCK_UNFINISHED_WORK (exit 1; expired lock while idle is WARN —
  hygiene via recover, never force-cleared by the watchdog),
  ACTIVE_TX_TOO_OLD (exit 1).
- Recovery actions stay with the operator: run `recover` through the
  standard channel. The watchdog only reports.

Tier 4 enforcement: engine/workflow/recovery changes REQUIRE the soak
suite + watchdog, and `factory-soak.yml` runs on both `pull_request` and
`push` to `main` (path-filtered) — direct pushes to main cannot skip
Tier 4. CI green is NOT liveness green until Tier 4 has run.

## Interrupted run procedure

1. `node scripts/factory/factory.js recover` (or
   `node scripts/factory/operator.js recover`)
2. `node scripts/factory/factory.js consistency` — verify invariants
3. Resume the interrupted batch/chunk from the checkpoint (do not re-plan).
