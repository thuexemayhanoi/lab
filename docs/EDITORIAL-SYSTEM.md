# EDITORIAL PRESENTATION SYSTEM

The published site shares ONE editorial design system. Presentation is owned by
the shared shell/build tooling, never by individual articles.

## Canonical presentation sources

| Layer | Canonical source | Public output (generated, never hand-edited) |
|---|---|---|
| Site CSS (whole design system) | `scripts/site/style.css` | `assets/style.css` |
| Navigation / drawer JS | `scripts/site/menu.js` | `assets/menu.js` |
| Header / footer / chatbot markup, article chrome (`decorateArticle`) | `scripts/site/shell.js` | every generated page |
| Chatbot behavior | `scripts/site/chatbot.js`, `scripts/site/chatbot-worker.js` | `assets/chatbot.js`, `assets/chatbot-worker.js` |
| Build + promote to root | `scripts/site/build-site.js` | repository root (branch Pages: `main` / `(root)`) |

`build-site.js` reads these files verbatim and promotes outputs to the
repository root. **Never edit `assets/*` or root HTML by hand** — change the
canonical source and rebuild:

```
node scripts/site/build-site.js
```

## Rule for writers: semantic markup only

Writers produce semantic HTML in the draft body. They do NOT write CSS, do not
inline `<style>` blocks, do not add one-off wrapper classes. The shared shell
(`shell.js decorateArticle` + `style.css`) supplies all presentation: article
hero, TOC, typography, tables, callouts, chatbot, header/footer.

## Available semantic components

Use these classes/structures in draft bodies. All are styled by the shared
design system and are fully responsive (tables get a horizontal-scroll wrapper
automatically; no table can break the mobile viewport).

- `quick` — quick-answer box (short, answer-first summary near the top).
- `key-points` — compact "Điểm chính" card; wrap a `<ul>` inside
  `<div class="key-points">` with a heading.
- `note` — neutral callout ( `<p class="note">` or `<div class="note">` ).
- `warning` — caution callout (warm neutral tone; use for legal/safety cautions).
- `<ol class="steps">` — step-by-step numbered rail (procedures).
- `<ul class="checklist">` — checklist (hồ sơ, kiểm tra trước khi đi).
- `<table>` — plain semantic table; the shell wraps it in a responsive
  `.table-scroll` region automatically. Sticky header on tall tables.
- `<details class="faq glass"><summary>…</summary>…</details>` — FAQ item.
- `<div class="sources">` — "Nguồn tham khảo" citation panel (official-source
  articles MUST use this for their sources section).
- Ordinary `h2`/`h3`/`p`/`ul`/`ol`/`a` — core editorial typography (measure,
  spacing, hierarchy are handled globally; keep paragraphs short and scannable).

Do not force every component into every article — variation is desirable.

## What the shell adds automatically (writers must not add by hand)

- Article hero: breadcrumb, category chip, H1 presentation, lead/dek, postmeta.
- Deterministic table of contents for long articles.
- Related articles ("Đọc tiếp"), hub CTA, prev/next rows (from matrix metadata).
- Header, footer, drawer, chatbot markup, reading progress bar.

## Responsive behavior (owned by `style.css`, not by articles)

- Mobile-first; breakpoints ~640px / 768px / 1024px / 1180px.
- Article text measure ~720–800px on desktop; `clamp()` fluid type.
- `overflow-x: clip` guards, safe-area insets, touch targets ≥ 44px.
- Tables: auto `.table-scroll` wrapper with `role="region"`.
- `prefers-reduced-motion` respected globally.

## Chatbot visual subsystem

The local reading assistant uses its own navy/indigo token set
(`--chat-*`) on top of the shared file — a visually distinct layer that still
belongs to the same site. On mobile it renders as a bottom sheet with
keyboard-safe composer (`100dvh` + `visualViewport` handling in `chatbot.js`).
Behavior contracts (retrieval-first, opt-in local AI, no inference API) are
defined in `docs/PROC-QA.md`/privacy page and enforced by tests.
Dialog modality contract: while the panel is open it is a **modal** dialog
(`role="dialog"` + `aria-modal="true"` in the canonical shell markup). The
behavior matches the declaration: Tab is trapped inside the panel, ESC closes
it, focus returns to the launcher (or the pre-open focus target), and body
scrolling is locked on mobile while the bottom sheet is open. Never declare
the panel non-modal while keeping the focus trap.
