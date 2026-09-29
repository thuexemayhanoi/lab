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
                     QA → REPAIR → QA (max 3) → PASS/BLOCKED
                     QA → REVIEW (80–89) → QA (max 3) → PASS/BLOCKED
```

REVIEW (qa_score 80–89) is a **non-terminal** state: never publish a REVIEW
row; repair and re-QA it. A chunk is unfinished while ANY row is
`RESEARCH/WRITING/QA/REVIEW/REPAIR/PASS`; `prepare-next` refuses until every
row of the current chunk reaches `PUBLISHED` or `BLOCKED` (only then may a
new chunk be claimed).

## Commands

```
factory.js status            # matrix stats + checkpoint; assembles CSV
factory.js prepare-next [n]  # next n rows PLANNED -> RESEARCH (default chunk 10)
factory.js research <ID>      # mark research done (packet must exist)
factory.js qa <ID>            # QA the draft; scores into matrix
factory.js publish <ID>...    # atomic two-phase: stage (QA-hash + grounding gate) -> commit (drop draft, ledger)
factory.js grounding          # claim grounding gate: quantitative claims need verified claim_evidence
factory.js qa-repair <ID>     # re-score a PUBLISHED archive; binds fresh evidence to the exact archive bytes
                             #   (hard cap: at most CHUNK=10 per operation; >10 IDs => REFUSE;
                             #    no IDs => at most the current chunk of PASS rows)
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
- Build manifest: `data/state/build-manifest.json` records EXACTLY the
  generated public outputs promoted to the repo root; every build prunes
  previous-build entries that are no longer generated (de-published pages
  vanish; source trees are hard-guarded, never prunable). Deterministic,
  sorted, committed alongside the tree it describes.
- `capacity-check.js --staged-tx <TXID>`: staged-aware mode used ONLY inside
  the atomic publish window — accepts exactly the in-flight STAGED publish
  transaction holding the publish lock; every other state FAILS as usual.
- `prep-pilot.js` is a LEGACY BOOTSTRAP-ONLY tool: it REFUSES unless
  `config.phase === 'PILOT'` AND `checkpoint.published_count === 0`, before
  touching any file. Production never runs it (`prepare-next` is the path).
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
  `CHUNK` (10) — enforced by the canonical engine: `publish` refuses more than
  `CHUNK` ids and, without ids, takes at most the current chunk of PASS rows.
  The external AI writer remains the only prose writer; GitHub Actions
  stays deterministic (no API keys, no autonomous writing).
