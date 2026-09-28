# EXPERIMENT METRICS

Machine contract: `config/seo-experiment.json`
(baseline: zero-active-backlink-building, started 2026-09-28).

## Baseline report

`reports/experiments/baseline.md` records: repo HEAD, date, each pilot page
(topic, keyword, geo, QA score, word count, canonical, official-source flag),
zero-backlink baseline = YES.

## GSC measurement checkpoints (do not fabricate GSC data)

7 / 14 / 30 / 60 / 90 days after first crawl. Per checkpoint record:

- indexed pages
- impressions, clicks, queries, average position
- pages with impressions vs pages with zero impressions
- first indexed date / first impression date / first click date per pilot
- highest position, queries discovered

## Scale decision rules (after pilot data)

- high-impression clusters → SCALE
- indexed but low-impression → IMPROVE / RESEARCH
- not indexed → CHECK QUALITY / CRAWL / DUPLICATION
- repeated no-signal → PAUSE

Never produce thousands of pages merely to increase page count.

## Non-negotiables during the experiment

- NO backlink campaigns, NO forum/comment spam, NO PBN, NO automated
  directories, NO fake social profiles.
- Backlinks may be tested later as a separate controlled variable.
- Rank signals considered: intent match, content quality, local relevance,
  topical coverage, internal links, crawl architecture.
