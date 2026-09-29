# PROC — RESEARCH

1. Pick rows: `factory.js prepare-next [n]` (pilot rows were claimed once via the legacy bootstrap-only `prep-pilot.js`, which now REFUSES outside PILOT phase with zero published articles).
   Rows move PLANNED → RESEARCH.
2. For each row, search the primary keyword (web search). Capture:
   - page types ranking, local vs informational intent
   - questions found, related queries, SERP patterns
   - entities (geo, brand, model, part) repeatedly mentioned
3. Verify geography against `data/geography/` — no invented places.
4. For `requires_official_sources=1` rows: locate CURRENT official sources.
   Record source_url, source_domain, date_accessed, claim_supported.
   If a critical legal/procedural claim cannot be verified → note it and
   BLOCK the article (never guess).
5. Check cannibalization: compare title/keyword/intent/geo/brand against
   existing rows, especially the same `cannibalization_group`.
6. Write the packet `data/research/<ID>.json` with all required fields
   (see `docs/RESEARCH-BEFORE-WRITE.md`), including `unique_angle`.
7. `factory.js research <ID>` — validates the packet exists (and has
   official_sources non-empty when required) and marks research DONE
   (RESEARCH → WRITING).

Rules: no copying competitors; original writing only; packets are committed
to the repository (data/research/) as evidence.
