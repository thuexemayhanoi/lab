# CONTENT FACTORY

The factory is a deterministic pipeline that plans, researches, writes, QAs
and publishes articles from a fixed 10,000-row matrix.

## Units

- BATCH = 50 articles
- CHUNK = 10 articles (a writer processes 10 at a time, never 50 in one go)
- 10,000 articles = 200 batches × 50

## Matrix contract

`data/content-matrix.csv` — exactly 10,000 production rows.

Committed as 4 shards (`data/content-matrix.csv.part00..03`); the assembled
CSV is gitignored. All tools auto-assemble on load (byte-identical
concatenation of shards) and rewrite shards on save. Never edit the CSV by
hand — use the factory CLI.

Required fields: article_id, cluster, parent_topic, primary_keyword,
secondary_keywords, search_intent, geo_id, geo_level, province, locality,
poi, brand, model, vehicle_type, part, use_case, duration, requires_research,
requires_official_sources, actual_service_area, cannibalization_group, slug,
output_path, canonical, status, research_status, qa_score, repair_attempts,
published_date.

## Status lifecycle

```
PLANNED → RESEARCH → WRITING → QA → PASS → PUBLISHED
                     QA → REPAIR → QA (max 3) → BLOCKED
REVIEW band: qa_score 80–89 (never publish; repair)
```

## Commands

```
factory.js status            # matrix stats + checkpoint; assembles CSV
factory.js prepare-next [n]  # next n rows PLANNED -> RESEARCH (default chunk 10)
factory.js research <ID>      # mark research done (packet must exist)
factory.js qa <ID>            # QA the draft; scores into matrix
factory.js publish <ID>...    # PASS rows -> PUBLISHED, deploy file to site/, archive, drop draft
factory.js recover            # resume interrupted transaction
factory.js consistency        # invariants: uniques, sitemap match, published files exist
factory.js reports            # regenerate reports/factory/*.json
```

## Roles

- **Writer (external AI)**: research packet → draft body `_drafts/<ID>.body.html`
  → `wrap-drafts.js` → `qa` → `publish`. Never an API key in Actions.
- **Actions**: tests, validation, deterministic generation, publish promotion,
  reports, deploy. Never writes article prose.

## Safety

- Only one writer mutates production (writer lock + transaction marker).
- Bootstrap publication cap: 10 pilot articles (`config/content-factory.json`).
- Never rewrite PUBLISHED rows silently.
- Operator orchestration (see `docs/PROC-PUBLISH.md` "Operator channel"):
  whitelist command contract via `scripts/factory/operator.js`
  (`data/state/operator-command.json`), recover-first, resume-before-claim,
  QA scopes fast/deep/full (thresholds never change), final-tree verify +
  safe push, single coordinator `lab-factory-production`.
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
  `CHUNK` (10). The external AI writer remains the only prose writer; GitHub Actions
  stays deterministic (no API keys, no autonomous writing).
