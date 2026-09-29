# SOURCE POLICY

Machine contract: `config/source-policy.json`.

## Official/authoritative sources are MANDATORY for

laws · fines · licence requirements · registration · tax · fees ·
administrative procedures · official exam locations.

Examples of acceptable official domains:
chinhphu.vn, mod.gov.vn (Bộ Công an), mof.gov.vn / thuvienphapluat.vn (with
care — prefer gvt), ggv.gov.vn… — in general: government ministry/agency
sites, official portals (dichvucong), and reputable legal databases only as
supporting (not primary) sources.

## Recording requirements

For each claim: `source_url`, `source_domain`, `date_accessed`,
`claim_supported` (what exactly the source supports).

## Claim grounding gate (quantitative claims)

Every quantitative claim in an article — VND amounts, percentages, durations
(phút/giờ), ranges included — must be covered by a `claim_evidence` entry in
the research packet `data/research/<ID>.json`:

```json
{ "claim": "<the article's claim, full VND notation>",
  "source_url": "https://<real source page>",
  "source_domain": "<must equal the source_url hostname>",
  "date_accessed": "YYYY-MM-DD",
  "claim_supported": "<verbatim quote from the source that supports the claim>" }
```

Enforced by `factory.js grounding` (wired into publishStage, verifySteps and
all validation workflows); `config/content-factory.json: grounding.required_ids`
pins the permanently audited scope (every published id joins it at commit).

- One shop's price table is NOT a province-wide market range. With a single
  source, phrase the claim as "the shop X publicly lists the price …" (or an
  equally accurate equivalent). A market-range claim needs enough independent
  sources to support it.
- A claim whose numbers cannot be grounded must be rewritten qualitatively —
  never keep the number and cite something that does not contain it.
- For PUBLISHED articles, `factory.js qa-repair <ID>` re-scores the archive
  and binds fresh evidence to the exact archive bytes (SHA-256).

## Hard rules

- Search before publishing. Time-sensitive claims need CURRENT sources.
- Government procedure and authority can change (e.g. 2025 administrative
  mergers) — never hardcode old police/administrative structures without
  verification.
- If important legal information cannot be verified → BLOCK the article.
  Never guess. Never publish stale legal claims.
- Do not invent testing centers, registration offices, or fee amounts.
- Supporting sources (press, manufacturer sites, large directories) may
  ground non-legal facts but never replace official sources for the
  categories above.
