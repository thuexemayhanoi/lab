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

## Bootstrap cap

At most 10 pilot articles may be published during bootstrap
(`config/content-factory.json: max_publication_in_bootstrap`). The publish
command refuses to exceed it. Mass publishing waits for pilot learnings.
