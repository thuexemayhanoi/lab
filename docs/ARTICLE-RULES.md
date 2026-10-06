# ARTICLE RULES

## Length (Vietnamese words)

- PASS range: 1,600–3,000 words (QA counts `[A-Za-zÀ-ỹ0-9]+` tokens of stripped text).
- Simple local article: ~1,600–2,000.
- Technical / legal / comparison / deep guide: ~2,000–3,000.
- Length alone never earns score. Penalized: filler, repetition, keyword
  stuffing, generic AI padding.

## Structure (normal case, variation desirable — do not force identical sections)

- breadcrumb nav
- H1 (matches primary keyword naturally, not stuffed)
- short useful introduction
- quick answer box when useful
- logical H2/H3 with entity/geo-specific information
- tables when genuinely useful (prices, comparisons, procedures)
- FAQ only when useful
- sources section when required (official-source articles)
- related content + internal links

## Internal linking

- Every article links to: parent topic hub, relevant geo hub (if any),
  relevant entity/model hub, 2–5 closely related **already-PUBLISHED** articles.
- Editorial total: 4–8 internal links. No exact-match spam; no links purely
  for count. All links must resolve (tests enforce this).
- **Never link to another article in the same write-ahead queue unless that
  target is already PUBLISHED on fresh `main`.** A queued sibling is not a
  valid internal-link target yet. This prevents staged-link repair cascades
  when a later pair has not been published.

## Titles / meta

Never mechanically `[keyword] | [same suffix]` across pages. Vary per intent:

- Thuê Honda Vision Hà Nội: Giá, thủ tục và kinh nghiệm chọn xe
- Cứu hộ xe máy tại Thủ Đức: Cách tìm dịch vụ gần vị trí gặp sự cố
- Đăng ký xe máy ở Long Biên: Hồ sơ, quy trình và nơi thực hiện

No fabricated promises in titles or meta descriptions.

## Truth constraints

- No invented addresses, businesses, testing centers, rescue services,
  prices-as-fact, laws, or authorities.
- informational_only rows: no "chúng tôi" service claims, no LocalBusiness schema.
- hanoi_owner_verified rows may include the verified Hanoi contact details
  (see `config/business-facts.json` + `docs/SEO-OWNERSHIP.md`).
- Do not imply the lab is an authorized dealer of any brand.

## Editorial presentation (semantic markup — presentation is NOT the writer's job)

Writers write semantic HTML only; the shared editorial design system
(`scripts/site/style.css` + `scripts/site/shell.js decorateArticle`) supplies
all presentation for published AND future articles. Use the documented
components (`quick`, `key-points`, `note`, `warning`, `ol.steps`,
`ul.checklist`, plain `<table>`, `details.faq`, `div.sources`) when they fit —
see `docs/EDITORIAL-SYSTEM.md`. Never inline `<style>`, never invent one-off
wrapper classes, never hand-patch generated pages.

## Anti-doorway rule

A page whose only difference from another is a place name is forbidden.
Each geographic page needs several genuinely locality-specific elements
(real POIs, routes, transport access, local procedures, local questions).
If not enough unique value: leave PLANNED or BLOCKED. Do not publish.
