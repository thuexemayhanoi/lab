#!/usr/bin/env node
/** repair-archives.js — one-off deterministic repair of published article archives
 *  (data/published/*.html): fixes double-slash breadcrumb schema URLs, regenerates
 *  meta description at word boundaries, adds a visible published-date line.
 *  Content itself is NOT rewritten. Safe to re-run (idempotent). */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'data', 'published');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clipWords = (s, max) => { s = s.trim(); if (s.length <= max) return s;
  const cut = s.slice(0, max); const sp = cut.lastIndexOf(' '); return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim(); };
let fixed = 0;
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.html'))) {
  const p = path.join(DIR, f);
  let html = fs.readFileSync(p, 'utf8');
  const before = html;
  // 1) double-slash URLs (canonical, breadcrumb schema, any href)
  html = html.replace(/github\.io\/lab\/\//g, 'github.io/lab/');
  // 2) regenerate meta description from the first body paragraph (word-boundary safe)
  const firstP = (html.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '';
  const desc = clipWords(firstP.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 155);
  if (desc) {
    html = html.replace(/<meta name="description" content="[^"]*">/,
      `<meta name="description" content="${esc(desc)}">`);
    html = html.replace(/("description":")((?:[^"\\]|\\.)*)(")/, (m, a, b, c) => a + esc(desc) + c);
  }
  // 3) visible published date after H1 (idempotent)
  const date = (html.match(/"datePublished":"(\d{4}-\d{2}-\d{2})"/) || [])[1];
  if (date && !/class="postmeta"/.test(html)) {
    html = html.replace(/(<\/h1>)/, `$1\n<p class="postmeta">Cập nhật ${date}</p>`);
  }
  if (html !== before) { fs.writeFileSync(p, html); fixed++; console.log('REPAIRED', f); }
}
console.log('DONE. repaired=' + fixed);
