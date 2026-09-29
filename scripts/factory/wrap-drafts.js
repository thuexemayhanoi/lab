#!/usr/bin/env node
/** wrap-drafts.js — wrap _drafts/<ID>.body.html into full draft pages _drafts/<ID>.html
 * with the same layout as build-site.js, Article + BreadcrumbList JSON-LD and the
 * canonical URL from the content matrix. Deterministic; run before QA. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const partFiles = fs.readdirSync(DATA).filter(f => /^content-matrix\.csv\.part/.test(f)).sort();
let csvText = fs.readFileSync(path.join(DATA, 'content-matrix.csv'), 'utf8');
if (partFiles.length) csvText = partFiles.map(p => fs.readFileSync(path.join(DATA, p), 'utf8')).join('');
const header = csvText.split('\n')[0].split(',');
const rows = {};
csvText.split('\n').slice(1).filter(l => l.trim()).forEach(l => {
  const cur = '', q = false; const out = [];
  let c2 = '', qq = false;
  for (let i = 0; i < l.length; i++) { const c = l[i];
    if (qq) { if (c === '"') { if (l[i+1] === '"') { c2 += '"'; i++; } else qq = false; } else c2 += c; }
    else { if (c === '"') qq = true; else if (c === ',') { out.push(c2); c2 = ''; } else c2 += c; } }
  out.push(c2);
  const o = {}; header.forEach((h, i) => o[h] = out[i] || '');
  rows[o.article_id] = o;
});
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'business-facts.json'), 'utf8'));
// canonical Liquid Glass shell shared with build-site.js (header/footer/menu)
const shell = require(path.join(__dirname, '..', 'site', 'shell.js'));
const esc = shell.esc;
const firstH1 = b => ((b.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');
const firstP = b => ((b.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
// word-boundary-safe truncation: never cut a Vietnamese word in half
const clipWords = (s, max) => { s = s.trim(); if (s.length <= max) return s;
  const cut = s.slice(0, max); const sp = cut.lastIndexOf(' '); return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim(); };
let n = 0;
for (const f of fs.readdirSync(path.join(ROOT, '_drafts'))) {
  if (!f.endsWith('.body.html')) continue;
  const id = f.replace('.body.html', '');
  const r = rows[id]; if (!r) { console.error('no matrix row for ' + id); process.exitCode = 1; continue; }
  const body = fs.readFileSync(path.join(ROOT, '_drafts', f), 'utf8');
  const title = esc(firstH1(body).replace(/<[^>]+>/g, ''));
  const desc = esc(clipWords(firstP(body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 155));
  const date = new Date().toISOString().slice(0, 10);
  const schema = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'Article', headline: title, inLanguage: 'vi', datePublished: date,
      author: { '@type': 'Organization', name: cfg.site_name }, mainEntityOfPage: r.canonical, description: desc },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: cfg.base_url },
      { '@type': 'ListItem', position: 2, name: esc(r.parent_topic), item: cfg.base_url + r.output_path.split('/')[0] + '/' },
      { '@type': 'ListItem', position: 3, name: title, item: r.canonical } ] } ] };
  const bodyWithMeta = body.replace(/(<\/h1>)/, `$1\n<p class="postmeta">Cập nhật ${date}</p>`);
  // canonical durable-archive format (matches data/published/A00001.html):
  //  - a visible breadcrumb nav at the top of main — build-site decorateArticle
  //    keys off it and the BreadcrumbList JSON-LD must match what is displayed
  //  - the chatbot is RUNTIME chrome injected by the current shell at build
  //    time (withShell replaces the footer); it must NOT live in the archive
  const hubSlug = r.output_path.split('/')[0];
  const hubTitle = String(r.parent_topic || hubSlug).toLowerCase().replace(/^./, c => c.toUpperCase());
  const breadcrumb = `<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › <a href="/lab/${hubSlug}/">${esc(hubTitle)}</a> › ${title}</nav>`;
  const footerNoChat = shell.footerHtml(facts).replace(/<button class="chat-launcher"[\s\S]*$/, '');
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${r.canonical}">
<script type="application/ld+json">${JSON.stringify(schema)}</script>
<link rel="stylesheet" href="/lab/assets/style.css">
</head>
<body>
${shell.headerHtml()}
<main class="wrap article">${breadcrumb}
${bodyWithMeta}</main>
${footerNoChat}
<script src="/lab/assets/menu.js" defer></script>
</body>
</html>`;
  fs.writeFileSync(path.join(ROOT, '_drafts', id + '.html'), html);
  n++;
}
console.log('WRAPPED ' + n + ' draft bodies.');
