# RESEARCH BEFORE WRITE — MANDATORY

No article is written without a research packet first:
`data/research/<ARTICLE_ID>.json`.

## Packet fields

article_id, primary_keyword, secondary_keywords, search_intent, research_date,
geo_entities, vehicle_entities, brand_entities, model_entities, questions_found,
related_queries, serp_patterns, official_sources, supporting_sources,
existing_internal_pages, potential_cannibalization, unique_angle, notes.

## What to research

1. Search the primary keyword. Understand the current SERP:
   - which page types rank (directory? blog? service page? official?)
   - local vs informational intent
   - common subtopics and questions
   - freshness requirements
   - entities repeatedly mentioned
2. Identify the unique angle that justifies this URL (see
   `docs/ARTICLE-RULES.md` anti-doorway rule).
3. For legal/procedural claims: find CURRENT official sources
   (see `docs/SOURCE-POLICY.md`). If it cannot be verified → BLOCK the article.
4. Compare against the matrix: title, primary keyword, intent, geo, brand/model,
   canonical URLs. Same practical intent as an existing row → MERGE or
   re-assign genuinely different intent (cannibalization_group tracks this).

## Rules

- Do NOT copy competitors. Research grounds facts and discovers intent; the
  article is original writing.
- Record `source_url`, `source_domain`, `date_accessed`, `claim_supported`
  for every official source.
- The factory `research <ID>` command refuses to advance a row whose packet
  is missing or (for `requires_official_sources=1` rows) has no official source.
