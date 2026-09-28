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
const HUBS = [['thue-xe-may','Thuê xe máy'],['cuu-ho-xe-may','Cứu hộ xe máy'],['sua-xe-may','Sửa chữa & bảo dưỡng'],['bang-lai-xe-may','Bằng lái xe máy'],['dang-ky-xe-may','Đăng ký xe máy'],['xe-may-dien','Xe máy điện'],['phu-tung','Phụ tùng xe máy'],['kinh-nghiem','Kinh nghiệm']];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nav = HUBS.map(([slug, t]) => `<a href="/lab/${slug}/">${t}</a>`).join('');
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
<header class="site-head"><div class="wrap"><a class="brand" href="/lab/">Motorbike SEO Lab</a><nav>${nav}<a href="/lab/lien-he/">Liên hệ</a><a href="/lab/ve-chung-toi/">Về chúng tôi</a></nav></div></header>
<main class="wrap article">${bodyWithMeta}</main>
<footer class="site-foot"><div class="wrap">
<p>${esc(facts.business_name)} — ${esc(facts.location_summary)}</p>
<p><a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></p>
<p class="fine">Trang thông tin nghiên cứu về hệ sinh thái xe máy Việt Nam. Không phải trang dịch vụ toàn quốc.</p>
</div></footer>
</body>
</html>`;
  fs.writeFileSync(path.join(ROOT, '_drafts', id + '.html'), html);
  n++;
}
console.log('WRAPPED ' + n + ' draft bodies.');
