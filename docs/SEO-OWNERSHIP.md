# SEO OWNERSHIP — who may claim what, where

Owner's verified business (see `config/business-facts.json`): a motorbike
rental service operating in Hanoi (Long Biên / phố cổ area), operator
"Cho thuê xe máy Phố Cổ - Mr Tú". Phone and exact street address are
REQUIRES_VERIFICATION unless re-verified — do not publish unverified NAP.

## actual_service_area values in the matrix

- `hanoi_owner_verified` — the owner genuinely offers this service in Hanoi.
  These articles MAY include verified address, phone, prices, deposit policy,
  opening hours, support CTA — where contextually appropriate.
- `informational_only` — no service claim allowed. Market overview,
  directory-style guidance, how-to-find, verified local options, advice.

## Global footer (ALL pages)

Only: operator identity, email, opening hours, location summary
"Long Biên, Hà Nội, Việt Nam". NO exact street address, NO Quick Call button,
NO nationwide rental CTA, NO fake local phone numbers. No nationwide branches.

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
