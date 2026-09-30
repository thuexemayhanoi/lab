# PROC — QA

Run: `factory.js qa <ID>` (operates on `_drafts/<ID>.html`).

## QA scope (normal loop = FAST)

Normal 2-article production uses FAST verification scoped to the current
pair only: transaction/lock sanity, selected IDs, QA score contract,
critical failures, grounding where the row requires it, checkpoint↔matrix
coherence for the pair. FAST never runs the full test-suite,
capacity-check or editorial audit — those are DEEP/FULL gates, and Tier 4
(soak) is engine-change maintenance only. Thresholds are identical in
every scope: PASS ≥ 75, REVIEW 70–74, below 70 REPAIR/BLOCKED; critical
factual/legal failures FAIL hard regardless of scope.

## Automated checks

- word count ≥ 1,600 (regex `[A-Za-zÀ-ỹ0-9]+` on stripped text; 3,000 soft max)
- exactly one H1
- correct canonical (matches matrix row)
- breadcrumb nav present
- JSON-LD schema present (Article + BreadcrumbList)
- internal links ≥ 3
- no fake-service claim patterns on `informational_only` rows
- no LocalBusiness schema on `informational_only` rows

## Scoring

- PASS: 75–100
- REVIEW: 70–74 (never publish; repair)
- FAIL: < 70 or any critical failure

## Critical failures (automatic non-PASS)

fake local business claim · invented address · invented business ·
invented testing center · invented rescue service · invented price as fact ·
invented law · invented government authority · wrong canonical ·
duplicate primary intent · major copied content · missing required official
source · misleading affiliate/authorized-dealer claim · public draft leak.

## Repair loop

QA → REPAIR → QA, maximum 3 repair attempts (`config/article-rubric.json`),
then BLOCKED. The external writer performs the repairs (expand sections,
add verified facts, fix links) — never lower the threshold to increase
throughput; article length flexibility (1,600–3,000) is the writer's lever.

## Human/AI editorial layer

Automated checks are necessary but not sufficient. Before publish, the writer
reviews: distinct informational reason to exist (anti-doorway), locality-specific
substance, natural title/meta, link quality (4–8 editorial links), truthful
NAP/CTA per `docs/SEO-OWNERSHIP.md`.
