# AGENTS.md — SINGLE ENTRY POINT (READ THIS FIRST)

Any AI agent (writer, researcher, QA, operator) working in this repository
**MUST read this file first**, then follow the routing below.

## What this repository is

`lab` is an SEO research lab covering the nationwide Vietnamese motorbike
ecosystem, published as a static GitHub Pages site:

- Public URL: https://thuexemayhanoi.github.io/lab/
- Base path prefix: `/lab/`
- It is NOT the main rental business site. It tests whether low-competition
  local + long-tail queries can rank WITHOUT active backlink building.
- Zero-active-backlink baseline: **YES** (see `config/seo-experiment.json`).

## Core topic clusters

THUÊ XE MÁY (rental — dominant cluster) · CỨU HỘ (rescue) · SỬA CHỮA / BẢO DƯỠNG
(repair) · BẰNG LÁI (licence) · ĐĂNG KÝ / THUẾ / BIỂN SỐ (registration) ·
XE MÁY ĐIỆN (electric) · PHỤ TÙNG (parts).

## Canonical documents (read in this order)

1. `docs/CONTENT-FACTORY.md` — batch/chunk model, commands, roles
2. `docs/ARTICLE-RULES.md` — structure, length, titles, meta
3. `docs/RESEARCH-BEFORE-WRITE.md` — mandatory research packets
4. `docs/SOURCE-POLICY.md` + `config/source-policy.json` — official sources
5. `docs/SEO-OWNERSHIP.md` — who may claim what service where
6. `docs/GEO-LOCAL-SEO.md` — geography & local-intent model
7. `docs/PROC-RESEARCH.md`, `docs/PROC-QA.md`, `docs/PROC-PUBLISH.md`, `docs/PROC-RECOVERY.md`
8. `docs/EXPERIMENT-METRICS.md` — measurement plan

## Hard rules (violations = QA critical failure)

- NEVER invent addresses, businesses, testing centers, rescue services, prices
  stated as fact, laws, or government authorities.
- Non-Hanoi pages are informational/directory only — no fake local service
  claims, no "chúng tôi" service claims outside the verified Hanoi service area.
- Every article needs a research packet (`data/research/<ID>.json`) BEFORE writing.
- Official-source articles (`requires_official_sources=1`) must cite current
  authoritative sources or be BLOCKED.
- QA pass threshold ≥ 90. Repair ≤ 3 attempts, then BLOCKED.
- Word range 1,600–3,000 Vietnamese words. No filler/keyword stuffing.
- Only PUBLISHED pages may be publicly deployed. Drafts live in `_drafts/`
  (gitignored, never deployed).
- Max publication during bootstrap: 10 pilot articles (config: `content-factory.json`).
- Phase lifecycle: `PILOT` → `PRODUCTION` via `node scripts/factory/factory.js promote-production`
  (canonical transition; bootstrap cap only binds in PILOT). See `docs/CONTENT-FACTORY.md`.
- No autonomous AI writer in GitHub Actions; no API keys in Actions.
- No backlink campaigns. Do not create external links to manipulate rankings.

## Data contracts

- `data/content-matrix.csv` — EXACTLY 10,000 production rows.
  It is ASSEMBLED from the 4 canonical shards
  `data/content-matrix.csv.part00..03` (the assembled CSV is gitignored).
  Any tool (`factory.js`) auto-assembles on load and rewrites shards on save.
- `data/geography/*.json` — verified geography only (34 current provinces,
  63 legacy names, localities, hubs, POIs). Never invent places.
- `data/research/<ID>.json` — research packets.
- `data/state/` — checkpoint, writer lock, transaction marker.

## Factory commands

```
node scripts/factory/factory.js status
node scripts/factory/factory.js prepare-next [n]
node scripts/factory/factory.js research <ID>
node scripts/factory/factory.js qa <ID>
node scripts/factory/factory.js publish <ID> [<ID>...]
node scripts/factory/factory.js recover
node scripts/factory/factory.js consistency
node scripts/factory/factory.js reports
node scripts/factory/wrap-drafts.js        # wrap _drafts/<ID>.body.html -> <ID>.html
node scripts/factory/prep-pilot.js         # mark pilot rows PLANNED -> RESEARCH
node scripts/site/build-site.js           # rebuild site/ from published pages
```

## Status lifecycle

PLANNED → RESEARCH → WRITING → QA → PASS → PUBLISHED
Failure: QA → REPAIR → QA (max 3 repairs) → BLOCKED.

Only ONE writer mutates production at a time (writer lock + transaction
marker; see `docs/PROC-RECOVERY.md`).

## Roles

- **External AI writer** (you, typically): research → write draft body → wrap → QA → publish.
- **GitHub Actions**: tests, validation, deterministic generation, publish
  promotion, site build, deployment. Never writes articles.
