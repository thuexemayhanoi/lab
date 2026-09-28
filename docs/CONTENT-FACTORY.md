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
