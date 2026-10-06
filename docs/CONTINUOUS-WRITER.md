# Continuous Writer Contract — /lab

This document is the canonical run contract for an **external writer** (Vibe,
Mistral, ChatGPT or another agent) producing articles for `/lab`.

The goal is simple: **one user command starts a continuous production run**. The
writer does not stop after each 2-article pair or each queue.

## 1. Canonical production model

- Repository truth: `main` + content matrix shards + checkpoint/state files.
- Factory QA/publish unit: **PAIR = 2 articles**.
- Writer unit: **WRITE-AHEAD QUEUE = 2..10 consecutive claimable PLANNED IDs**.
- Default queue target for a healthy run: **10 articles**. Use a smaller queue
  only when runtime is constrained, a repair is pending, or source quality
  requires it. Never exceed `queue_max` in `data/state/production-control.json`.
- External writer writes prose/research and pushes drafts. GitHub Actions does
  deterministic recover → exact-id claim → research gate → QA → publish PASS →
  checkpoint → Pages.
- The **external push-driven writer is the only normal production path**.
  The old internal pipeline code remains only as a recovery/manual test component;
  it is no longer scheduled by `factory-production.yml`.
- For NEW content, run only one external writer at a time unless a future repo
  contract adds an explicit lease registry. This avoids duplicate claims.

## 2. The loop — do not ask the user again

```
FETCH FRESH MAIN
→ READ AGENTS.md + this contract
→ RECOVER if transaction/lock requires it
→ RESUME first: repair/QA any open current IDs before new claims
→ READ checkpoint + matrix truth
→ PICK next 2..10 consecutive PLANNED IDs starting at next_claimable_id
   (default target = 10)
→ RESEARCH every ID; official/quantitative claims follow source policy
→ WRITE _drafts/<ID>.body.html for the full queue
   (internal links may target only pages already PUBLISHED on fresh main;
    never link to an unpublished sibling in the same queue)
→ WRAP with scripts/factory/wrap-drafts.js
→ LOCAL SCOPED FAST QA for only this queue
→ COMMIT + PUSH the whole queue once
→ WAIT Factory production for that SHA
→ VERIFY: queue consumed/recoverable truth, no active txn/lock, Pages GREEN
→ FETCH FRESH MAIN
→ NEXT QUEUE
→ REPEAT IMMEDIATELY
```

The user should not have to say “continue” after each pair or queue.

## 3. Do not stop because

- two articles were published;
- a queue was published;
- a workflow turned GREEN;
- Pages deployed;
- checkpoint/progress was updated;
- a topic/model/location cluster changed;
- one repair completed successfully.

Those are checkpoints, not end conditions.

## 4. Stop only when

1. all matrix rows are terminal under repository rules; or
2. the runtime/session/tool limit forces a stop at a safe checkpoint
   (fresh main, no held writer lock, no active transaction); or
3. a real blocker requires human credentials/permissions/decision.

A temporary connector error, transient Git race, or repairable QA failure is not
a reason to abandon the run. Retry/recover according to repo rules.

## 5. RED / repair behavior

If Factory production is RED or a pair is recoverable:

1. fetch fresh main;
2. identify the exact failed/recoverable IDs;
3. fix only their research/body content or the specific deterministic defect;
4. wrap again;
5. run scoped FAST QA;
6. push the repair (respect repair chunk limits);
7. wait for GREEN and verify state;
8. resume the next new queue automatically.

Never skip a failed earlier ID to keep writing later IDs. Never rewrite already
PUBLISHED articles merely to advance the counter.

## 6. Hot-loop performance rules

A normal content queue must stay light:

- no full-site audit per queue;
- no full test suite per queue;
- no Tier-4 soak per queue;
- no workflow redesign during a content run;
- no repeated reading of the entire repository after each pair.

Use scoped FAST gates for content. Deep/FULL/Tier-4 are for engine/workflow/
recovery changes or scheduled reliability maintenance.

## 7. Safe state rules

Before every new queue, verify:

- checkpoint and matrix agree on the next claimable ID;
- transaction is inactive;
- writer lock is free (or belongs to the current valid operation);
- no earlier recoverable/repair IDs remain;
- selected IDs are consecutive in repository/matrix order;
- every selected ID has its research packet before push.

If state is stale, derive truth from the matrix/checkpoint contracts and repair
state before writing more content. Do not reset published count and do not claim
already-PUBLISHED IDs.

## 8. One-command interpretation

These user messages all mean the same thing unless explicitly limited:

- “chạy /lab”
- “viết tiếp /lab”
- “tiếp tục production”
- “làm tiếp bài”
- “chạy factory”

Interpret them as: **start/resume the continuous writer loop and keep producing
queues until a legitimate stop condition occurs.**
