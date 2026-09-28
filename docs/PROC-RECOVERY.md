# PROC — RECOVERY (transaction, lock, checkpoint)

Deterministic safeguards so an interrupted run never corrupts production.

## Mechanisms (data/state/)

- `writer-lock.json` — `{ "holder": "<id>|null", "acquired": ts }`.
  Only ONE writer mutates production at a time.
- `transaction.json` — marker of an in-flight publish operation:
  `{ "active": bool, "operation": "publish", "ids": [...], "started": ts }`.
- `checkpoint.json` — last completed state (phase, matrix rows, published
  count, last batch, notes).

## Rules

- Every mutating command acquires the lock; if held by another live writer,
  it refuses.
- Publish wraps its file writes in a transaction: matrix save happens last;
  published archives are written before public files; draft deletion happens
  only after both succeed.
- `factory.js recover` — inspects the transaction marker:
  - active transaction with incomplete files → finish or roll back the exact
    affected rows, clear marker.
  - stale lock (process gone) → free the lock.
  Then: RECOVER → RESUME. **Never restart the matrix. Never silently rewrite
    PUBLISHED rows.**

## Interrupted run procedure

1. `node scripts/factory/factory.js recover`
2. `node scripts/factory/factory.js consistency` — verify invariants
3. Resume the interrupted batch/chunk from the checkpoint (do not re-plan).
