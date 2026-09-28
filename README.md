# lab — Bản Đồ Xe 2 Bánh Việt Nam

Static GitHub Pages research lab covering the Vietnamese motorbike ecosystem:
thuê xe máy, cứu hộ, sửa chữa/bảo dưỡng, bằng lái, đăng ký – thuế – biển số,
xe máy điện, hãng/model, phụ tùng.

- Public URL: https://thuexemayhanoi.github.io/lab/
- Language: Vietnamese content, English tooling/docs.
- Zero-backlink SEO experiment: this lab measures whether intent-matched,
  research-first, locally-grounded articles can rank without any active
  backlink building. Do NOT run backlink campaigns.

## Quick start

```
node scripts/factory/factory.js status       # also assembles the matrix
node scripts/factory/factory.js consistency
node --test tests/test-suite.js
node scripts/site/build-site.js              # build site/ then promote public outputs to repo root
```

## Repository layout

- `AGENTS.md` — **read this first** (single entry point for AI agents)
- `docs/` — canonical process & policy documents
- `config/` — site, business facts, source policy, experiment, rubric, factory config
- `data/content-matrix.csv` — 10,000-row content matrix.
  **NOTE:** committed as 4 shards `data/content-matrix.csv.part00..03`;
  the assembled `data/content-matrix.csv` is gitignored and rebuilt locally
  by `factory.js` (or `scripts/factory/assemble-matrix.js`-equivalent logic
  inside `factory.js status`) — byte-identical concatenation of the shards.
- `data/geography/` — verified provinces, legacy names, localities, transport hubs, POIs
- `data/research/` — research packets (one per article)
- `data/state/` — checkpoint, writer lock, transaction
- `data/published/` — archive of published article HTML
- `scripts/factory/` — factory CLI (status/prepare-next/research/qa/publish/recover/consistency/reports)
- `scripts/site/build-site.js` — static site builder (hubs, articles, sitemaps, search index)
- `tests/` — test suite run in CI and locally
- `reports/` — factory, SEO, experiment reports
- `_drafts/` — unpublished drafts (gitignored, never deployed)

## Deployment

GitHub Actions workflow `.github/workflows/deploy.yml`:
tests + consistency + site build → deploy to GitHub Pages (source: GitHub Actions).
Set **Settings → Pages → Source: GitHub Actions** once, manually.

## Experiment rules (short version)

- Bootstrap maximum: 10 pilot articles published.
- QA ≥ 90 to publish; repair ≤ 3 times; else BLOCKED.
- Every article needs research first; official-source articles need verified
  current official sources or they are blocked.
- No fake local claims outside the verified Hanoi service area.
- Only PUBLISHED URLs enter sitemaps/hubs/search index.

See `AGENTS.md` and `docs/` for the full contracts.
