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
    "matrix_rows": 10000, "published_count": 13, "last_batch": ["A00002"],
    "last_completed_id": "A09401", "next_claimable_id": "A00005",
    "active_chunk": [], "notes": "..." }
  ```
  `published_count`, `last_completed_id`, `next_claimable_id` and
  `active_chunk` are DERIVED from matrix truth; `recover` re-syncs them.

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
  - `publish` — per article in `articles`:
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

## Interrupted run procedure

1. `node scripts/factory/factory.js recover` (or
   `node scripts/factory/operator.js recover`)
2. `node scripts/factory/factory.js consistency` — verify invariants
3. Resume the interrupted batch/chunk from the checkpoint (do not re-plan).
