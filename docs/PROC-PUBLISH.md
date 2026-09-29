# PROC — PUBLISH

Publishing is deterministic and reversible-safe.

## Preconditions

- Matrix row status = PASS (qa_score ≥ 90 recorded).
- Draft `_drafts/<ID>.html` exists (wrapped by `wrap-drafts.js`).
- Transaction + writer lock active (single writer).

## Steps (`factory.js publish <ID> [<ID>...]`)

1. Verify row PASS; else refuse.
2. Copy the wrapped draft HTML to `site/<output_path>index.html`.
3. Archive a copy to `data/published/<ID>.html` (restore source for rebuilds).
4. Delete the draft files from `_drafts/`.
5. Update matrix row: status=PUBLISHED, published_date=today; save shards.
6. Rebuild hubs/sitemap/search index: `node scripts/site/build-site.js`.

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
