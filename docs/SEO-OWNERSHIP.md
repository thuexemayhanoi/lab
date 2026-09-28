# SEO OWNERSHIP — who may claim what, where

Owner's verified business (see `config/business-facts.json`): a motorbike
rental service operating in Hanoi (Long Biên / phố cổ area), operator
"Thuê Xe Máy Nguyễn Tú". NAP (name, address, phone, email, hours, website,
Google Maps link) was re-verified 2026-09-28 and may be published in full
on the Contact page only. Never invent or extend NAP beyond these facts.

## actual_service_area values in the matrix

- `hanoi_owner_verified` — the owner genuinely offers this service in Hanoi.
  These articles MAY include verified address, phone, prices, deposit policy,
  opening hours, support CTA — where contextually appropriate.
- `informational_only` — no service claim allowed. Market overview,
  directory-style guidance, how-to-find, verified local options, advice.

## Global footer (ALL pages)

Compact editorial footer only: brand line, one-line description, utility
links (Liên hệ, Chính sách bảo mật, Điều khoản sử dụng, Sitemap) and the
copyright line. NO NAP in the footer at all — no operator name, no email,
no phone, no address, no location summary, no opening hours, no Quick Call
button, no nationwide rental CTA. Full verified NAP lives on the Contact
page (and a trust block on the Privacy page) only.

## Contact page

May contain the FULL verified NAP only (business name, exact address, phone,
email, hours, map/contact links). Canonical business facts only — invent nothing.

## Non-Hanoi articles (e.g. Đà Nẵng, TP.HCM, Huế, rescue outside Hanoi)

- Must NOT imply the owner operates there.
- Allowed: market overview, how to find rentals/rescue, verified local options,
  typical considerations, vehicle-selection and route advice.
- A subtle link to Contact/About is acceptable. No deceptive local-service CTA.
- Rescue: the business does NOT provide nationwide rescue; non-Hanoi rescue
  pages are informational/directory/guidance only.

## Schema

- Article + BreadcrumbList: normal.
- Organization: real operator identity.
- LocalBusiness: ONLY on truthful Hanoi service pages. Never for nationwide
  locations without a real branch. Tests enforce absence of LocalBusiness on
  informational_only pages.
- No authorized-dealer/affiliate implications for any brand.
