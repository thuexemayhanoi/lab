# Baseline Experiment Report — Zero-Backlink SEO Lab

- **Repo:** thuexemayhanoi/lab (branch: main)
- **Date:** 2026-09-28
- **Phase:** Bootstrap + 10-article pilot
- **Zero active backlink baseline: YES** — no backlink campaign has been run
  and none is permitted during the baseline measurement window
  (see `config/seo-experiment.json`).

## Pilot pages published (10/10)

| ID | Cluster | Primary keyword | Geo | QA | Words | Canonical | Official source |
|----|---------|-----------------|-----|----|-------|-----------|----------------|
| A00001 | RENTAL | thuê xe máy Hà Nội | Hà Nội (owner service area) | 100 | 2097 | https://thuexemayhanoi.github.io/lab/thue-xe-may/thue-xe-may-ha-noi/ | no |
| A00052 | RENTAL | thuê xe máy gần Sân bay quốc tế Nội Bài | Nội Bài (POI) | 100 | 2108 | https://thuexemayhanoi.github.io/lab/thue-xe-may/thue-xe-may-gan-san-bay-quoc-te-noi-bai/ | no |
| A00097 | RENTAL | thuê Honda Vision Hà Nội | Hà Nội (owner service area) | 100 | 2005 | https://thuexemayhanoi.github.io/lab/thue-xe-may/thue-honda-vision-ha-noi/ | no |
| A00465 | RENTAL | Vision hay Air Blade nên thuê dòng nào | — | 100 | 1971 | https://thuexemayhanoi.github.io/lab/thue-xe-may/vision-hay-air-blade-nen-thue-dong-nao/ | no |
| A05060 | RESCUE | cứu hộ xe máy Thủ Đức | TP. Thủ Đức (informational) | 100 | 1902 | https://thuexemayhanoi.github.io/lab/cuu-ho-xe-may/cuu-ho-xe-may-thu-duc/ | no |
| A06003 | REPAIR | bảo dưỡng xe máy định kỳ | — | 100 | 1904 | https://thuexemayhanoi.github.io/lab/sua-xe-may/bao-duong-xe-may-dinh-ky/ | no |
| A06801 | LICENCE | thi bằng lái xe máy A1 | — | 100 | 1974 | https://thuexemayhanoi.github.io/lab/bang-lai-xe-may/thi-bang-lai-xe-may-a1/ | **yes** — TT 154/2025/TT-BTC; lệ phí cấp GPLX 135.000đ |
| A07602 | REGISTRATION | đăng ký xe máy online | — | 100 | 1900 | https://thuexemayhanoi.github.io/lab/dang-ky-xe-may/dang-ky-xe-may-online/ | **yes** — TT 79/2024/TT-BCA |
| A08201 | ELECTRIC | xe máy điện có nên mua không | — | 100 | 1855 | https://thuexemayhanoi.github.io/lab/xe-may-dien/xe-may-dien-co-nen-mua-khong/ | no |
| A09401 | PARTS | lốp xe máy các loại và cách chọn | — | 100 | 2071 | https://thuexemayhanoi.github.io/lab/phu-tung/lop-xe-may-cac-loai-va-cach-chon/ | no |

- QA min: 100 · QA avg: 100 · Repair attempts: 0 (all passed first QA)
- Every pilot has a research packet: `data/research/<ID>.json`.
- Non-Hanoi pages are informational/directory only (no service claims,
  no LocalBusiness schema). Global footer carries no street address/phone.

## Verified at publish time (local + CI)

- 10/10 public files exist under `site/`, correct canonical + H1,
  Article/BreadcrumbList JSON-LD present.
- All 10 URLs present in sitemap shards (sitemap-index.xml).
- All internal links resolve; drafts removed (`_drafts/` never deployed).
- Consistency check: 10,000 unique rows, 0 duplicate ids/slugs/paths/canonicals.
- Test suite: 28/28 PASS.

## Measurement plan (GSC) — do not fabricate data

Record at 7 / 14 / 30 / 60 / 90 days after first crawl:

- indexed pages · impressions · clicks · queries · average position
- pages with impressions vs zero-impression pages
- per pilot: first indexed date, first impression date, first click date,
  highest position, queries discovered

## Scale decision rules (after pilot data)

- high-impression clusters → SCALE (next controlled batches)
- indexed but low-impression → IMPROVE / RESEARCH
- not indexed → CHECK QUALITY / CRAWL / DUPLICATION
- repeated no-signal → PAUSE

Bootstrap cap honored: 10/10 published. Mass production waits for indexing
signals. Backlink building remains forbidden during the baseline window.
