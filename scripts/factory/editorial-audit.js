#!/usr/bin/env node
/** editorial-audit.js — deterministic editorial scoring for PUBLISHED articles.
 * Reads repository truth (matrix + published archives + generated public pages)
 * and scores each PUBLISHED article on 7 editorial dimensions (total 100):
 *   CONTENT DEPTH / INTENT SATISFACTION   25
 *   FACTUAL / SOURCE QUALITY               20
 *   READABILITY / STRUCTURE                15
 *   SEO ON-PAGE / SEARCH INTENT            15
 *   INTERNAL LINKING / IA                  10
 *   UX / SCANNABILITY                      10
 *   TECHNICAL / SCHEMA / META               5
 * This editorial score is a tracking aid, NOT a replacement for the canonical
 * factory QA gate (factory.js qa — pass >= 90). It never mutates matrix/state.
 * Usage: node scripts/factory/editorial-audit.js [--out reports/editorial/audit.json]
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');

// ---- assemble matrix from canonical shards (read-only) ----
const partFiles = fs.readdirSync(DATA).filter(f => /^content-matrix\.csv\.part/.test(f)).sort();
const csvText = partFiles.length
  ? partFiles.map(p => fs.readFileSync(path.join(DATA, p), 'utf8')).join('')
  : fs.readFileSync(path.join(DATA, 'content-matrix.csv'), 'utf8');
function parseLine(line) { const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } }
  out.push(cur); return out; }
function parseCSV(text) { const L = text.split('\n'); const H = parseLine(L[0]);
  return L.slice(1).filter(l => l.trim()).map(l => { const c = parseLine(l); const o = {}; H.forEach((h, i) => o[h] = c[i] || ''); return o; }); }
const rows = parseCSV(csvText);
const published = rows.filter(r => r.status === 'PUBLISHED');

const strip = x => String(x || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const wordsOf = x => (strip(x).match(/[A-Za-zÀ-ỹ0-9]+/g) || []).length;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function auditArticle(r) {
  const id = r.article_id;
  const archive = fs.readFileSync(path.join(DATA, 'published', id + '.html'), 'utf8');
  const pagePath = path.join(ROOT, r.output_path.replace(/\/$/, ''), 'index.html');
  const page = fs.existsSync(pagePath) ? fs.readFileSync(pagePath, 'utf8') : archive;
  const main = (page.match(/<main[^>]*>([\s\S]*?)<\/main>/) || [null, ''])[1] || '';
  // writer-authored editorial region: archive <main> minus the breadcrumb nav
  // (generated chrome — TOC, related cards, prev/next, hub CTA — is presentation,
  // not editorial linking; the 4–8 band applies to writer links)
  const archMain = (archive.match(/<main[^>]*>([\s\S]*?)<\/main>/) || [null, ''])[1] || '';
  const writerRegion = archMain.replace(/<nav class="breadcrumb">[\s\S]*?<\/nav>/, '');
  const issues = [];

  // ---------- 1. CONTENT DEPTH / INTENT (25) ----------
  let depth = 0;
  const bodyWords = wordsOf(main);
  const simpleIntent = /local|commercial/.test(r.search_intent);
  const target = simpleIntent ? 1600 : 2000;
  if (bodyWords >= 1600 && bodyWords <= 3000) depth += 12; else issues.push('word_count_out_of_band:' + bodyWords);
  if (bodyWords >= target) depth += 4;
  if (bodyWords >= target + 300) depth += 2; // depth beyond minimum
  const h2s = (main.match(/<h2[^>]*>/g) || []).length;
  const h3s = (main.match(/<h3[^>]*>/g) || []).length;
  if (h2s >= 5) depth += 4; else if (h2s >= 4) depth += 2; else issues.push('too_few_h2:' + h2s);
  if (h3s >= 2) depth += 3;
  // intent-specific substance: geo or entity named in body (only meaningful when
  // the matrix row carries an entity; general-market rows have none)
  const intentEntity = [r.province, r.locality, r.poi, r.brand, r.model, r.part, r.vehicle_type].filter(Boolean);
  if (intentEntity.length) {
    if (intentEntity.some(e => strip(main).toLowerCase().includes(String(e).toLowerCase()))) depth += 2;
    else issues.push('intent_entity_absent_from_body');
  } else if (strip(main).toLowerCase().includes(String(r.primary_keyword || '').split(' ')[0].toLowerCase())) {
    depth += 2; // general-market row: topic term must anchor the body
  } else issues.push('topic_anchor_absent_from_body');
  depth = clamp(depth, 0, 25);

  // ---------- 2. FACTUAL / SOURCE QUALITY (20) ----------
  let fact = 10; // base: verified by canonical QA gate (no invented facts per QA)
  const packetPath = path.join(DATA, 'research', id + '.json');
  if (fs.existsSync(packetPath)) {
    fact += 4;
    if (r.requires_official_sources === '1') {
      const p = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
      if (p.official_sources && p.official_sources.length >= 1) fact += 2; else issues.push('official_packet_missing_sources');
      const srcSection = /<h2[^>]*>[^<]*Nguồn[^<]*<\/h2>/.test(main);
      if (srcSection) fact += 4; else issues.push('missing_sources_section_official_row');
      // official-domain links present in the page
      if (/chinhphu\.vn|mod\.gov\.vn|gov\.vn|dichvucong|mof\.gov\.vn/.test(main)) fact += 2;
      else issues.push('no_official_domain_link');
    } else {
      fact += 4; // non-legal row: packet + general editorial care
      if (/tham khảo|tùy|tuỳ|quy định của cửa hàng|thị trường/i.test(main)) fact += 2;
      else issues.push('no_market_disclaimer_softeners');
    }
  } else issues.push('missing_research_packet');
  fact = clamp(fact, 0, 20);

  // ---------- 3. READABILITY / STRUCTURE (15) ----------
  let read = 0;
  const paras = [...main.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(m => m[1]);
  const pLens = paras.map(wordsOf).filter(n => n > 0);
  const avgP = pLens.length ? pLens.reduce((a, b) => a + b, 0) / pLens.length : 0;
  if (avgP >= 35 && avgP <= 85) read += 5; else if (avgP > 0) { read += 3; issues.push('avg_paragraph_words:' + Math.round(avgP)); }
  // wall = very long paragraph WITHOUT visual anchors (em/strong lead-ins act as
  // scannable sub-points; 120 words ≈ 6+ Vietnamese sentences is the comfort band)
  const longWalls = paras.filter(p => wordsOf(p) > 120 && (p.match(/<(em|strong)[^>]*>/g) || []).length < 2).length;
  if (longWalls === 0) read += 4; else { read += Math.max(0, 4 - longWalls); issues.push('wall_paragraphs:' + longWalls); }
  const h1Count = (main.match(/<h1[^>]*>/g) || []).length;
  if (h1Count === 1) read += 3; else issues.push('h1_count:' + h1Count);
  if (h3s >= 2 && h2s >= 4) read += 3; // real hierarchy depth, not flat
  read = clamp(read, 0, 15);

  // ---------- 4. SEO ON-PAGE (15) ----------
  let seo = 0;
  const title = (page.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const desc = (page.match(/name="description" content="([^"]*)"/) || [])[1] || '';
  const canonicalOk = page.includes('rel="canonical" href="' + r.canonical + '"');
  if (canonicalOk) seo += 5; else issues.push('canonical_mismatch');
  if (title.length >= 45 && title.length <= 110) seo += 4; else { seo += 2; issues.push('title_len:' + title.length); }
  if (desc.length >= 120 && desc.length <= 165) seo += 4; else { seo += 2; issues.push('desc_len:' + desc.length); }
  const h1Text = strip((main.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '');
  // fuzzy keyword-in-H1: token overlap (natural rephrasing keeps >=60% of tokens)
  const kwToks = String(r.primary_keyword || '').toLowerCase().split(/\s+/).filter(w => w.length > 1);
  const h1Low = ' ' + h1Text.toLowerCase().replace(/[:?.,–—-]/g, ' ') + ' ';
  const overlap = kwToks.filter(w => h1Low.includes(' ' + w + ' ') || h1Low.includes(' ' + w)).length;
  if (kwToks.length === 0 || overlap / kwToks.length >= 0.6) seo += 2;
  else issues.push('primary_keyword_overlap_in_h1:' + Math.round(overlap / kwToks.length * 100) + '%');
  read = clamp(read, 0, 15); seo = clamp(seo, 0, 15);

  // ---------- 5. INTERNAL LINKING / IA (10) ----------
  const links = [...new Set([...writerRegion.matchAll(/href="(\/lab\/[^"#]+)"/g)].map(m => m[1]))];
  let link = 0;
  if (links.length >= 4 && links.length <= 8) link = 10;
  else if (links.length > 8) { link = 8; issues.push('link_count:' + links.length + '(>8 editorial band)'); }
  else if (links.length === 3) { link = 6; issues.push('link_count:3'); }
  else { link = 0; issues.push('link_count:' + links.length); }
  // parent hub + about/contact present strengthen IA
  const hub = '/' + r.output_path.split('/')[0] + '/';
  if (links.some(l => l === '/lab' + hub || l === '/lab' + hub)) link = Math.min(10, link);
  link = clamp(link, 0, 10);

  // ---------- 6. UX / SCANNABILITY (10) ----------
  let ux = 0;
  if (/class="quick"/.test(main)) ux += 2; else issues.push('no_quick_answer');
  if (/class="key-points"/.test(main)) ux += 2; else issues.push('no_key_points');
  if (/<details class="faq/.test(main)) ux += 2; else if (/<h2[^>]*>[^<]*Câu hỏi thường gặp/.test(main)) { ux += 1; issues.push('faq_not_details'); }
  if (/<details class="toc/.test(main)) ux += 2; else issues.push('no_toc');
  if (/<div class="table-scroll"/.test(main) && /<table/.test(main)) ux += 2;
  else if (/<table/.test(main)) issues.push('table_not_scroll_wrapped');
  else if (/<ol class="steps"|<ul class="checklist"/.test(main)) ux += 2;
  ux = clamp(ux, 0, 10);

  // ---------- 7. TECHNICAL / SCHEMA / META (5) ----------
  let tech = 0;
  try {
    const ld = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map(m => JSON.parse(m[1]));
    const graph = ld.flatMap(o => o['@graph'] || [o]);
    if (graph.some(o => o['@type'] === 'Article')) tech += 2; else issues.push('no_article_schema');
    if (graph.some(o => o['@type'] === 'BreadcrumbList')) tech += 1; else issues.push('no_breadcrumb_schema');
    if (r.actual_service_area === 'informational_only' && graph.some(o => o['@type'] === 'LocalBusiness')) { tech = 0; issues.push('CRITICAL_localbusiness_on_informational'); }
  } catch (e) { issues.push('schema_json_parse_error'); }
  if (/lang="vi"/.test(page)) tech += 1; else issues.push('lang_not_vi');
  if (/name="viewport"/.test(page)) tech += 1; else issues.push('no_viewport');
  tech = clamp(tech, 0, 5);

  const total = depth + fact + read + seo + link + ux + tech;
  return {
    article_id: id, url: r.canonical, primary_intent: r.search_intent + ' · ' + r.primary_keyword,
    word_count: bodyWords, canonical_qa_score: Number(r.qa_score),
    editorial: { total, depth, fact, read, seo, link, ux, tech },
    issues
  };
}

const results = published.map(auditArticle);
const report = {
  generated: new Date().toISOString(),
  audited: results.length,
  weights: { depth: 25, fact: 20, read: 15, seo: 15, link: 10, ux: 10, tech: 5 },
  summary: {
    avg_total: Math.round(results.reduce((a, b) => a + b.editorial.total, 0) / (results.length || 1) * 10) / 10,
    min_total: results.reduce((a, b) => Math.min(a, b.editorial.total), 100),
    max_total: results.reduce((a, b) => Math.max(a, b.editorial.total), 0)
  },
  articles: results
};
const outIdx = process.argv.indexOf('--out');
const out = outIdx > -1 ? process.argv[outIdx + 1] : null;
const outFile = out ? path.resolve(ROOT, out) : null;
if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2)); }
console.log('EDITORIAL AUDIT — ' + results.length + ' published articles');
results.forEach(a => console.log(
  a.article_id + '  editorial=' + String(a.editorial.total).padStart(3) + '/100  qa=' + a.canonical_qa_score +
  '  words=' + a.word_count + '  [' + a.editorial.depth + ',' + a.editorial.fact + ',' + a.editorial.read + ',' +
  a.editorial.seo + ',' + a.editorial.link + ',' + a.editorial.ux + ',' + a.editorial.tech + ']' +
  (a.issues.length ? '  issues: ' + a.issues.join('; ') : '')));
console.log('AVG ' + report.summary.avg_total + '  MIN ' + report.summary.min_total + '  MAX ' + report.summary.max_total);
if (outFile) console.log("WROTE " + outFile);
