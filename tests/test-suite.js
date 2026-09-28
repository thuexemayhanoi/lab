#!/usr/bin/env node
/** test-suite.js — factory + site invariants. Run: node --test tests/test-suite.js
 *  Assembles the matrix from parts (canonical shards) before testing. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SITE = path.join(ROOT, 'site');

// ---- assemble matrix from parts (canonical) ----
const partFiles = fs.readdirSync(DATA).filter(f => /^content-matrix\.csv\.part/.test(f)).sort();
if (partFiles.length) {
  fs.writeFileSync(path.join(DATA, 'content-matrix.csv'),
    partFiles.map(p => fs.readFileSync(path.join(DATA, p), 'utf8')).join(''));
}
function parseLine(line) { const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } }
  out.push(cur); return out; }
function parseCSV(text) { const L = text.split('\n'); const H = parseLine(L[0]);
  return L.slice(1).filter(l => l.trim()).map(l => { const c = parseLine(l); const o = {}; H.forEach((h, i) => o[h] = c[i] || ''); return o; }); }
const rows = parseCSV(fs.readFileSync(path.join(DATA, 'content-matrix.csv'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'content-factory.json'), 'utf8'));
const rubric = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'article-rubric.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'business-facts.json'), 'utf8'));
const published = rows.filter(r => r.status === 'PUBLISHED');
const publishedHtml = id => fs.readFileSync(path.join(ROOT, 'data', 'published', id + '.html'), 'utf8');

// ---------- MATRIX ----------
test('matrix: exactly 10,000 production rows', () => assert.strictEqual(rows.length, 10000));
test('matrix: allocation exact per cluster', () => {
  const want = { RENTAL: 5000, RESCUE: 1000, REPAIR: 800, LICENCE: 800, REGISTRATION: 600, ELECTRIC: 1200, PARTS: 600 };
  const got = {}; rows.forEach(r => got[r.cluster] = (got[r.cluster] || 0) + 1);
  assert.deepStrictEqual(got, want);
});
const uniqueTest = (field) => test('matrix: unique ' + field, () => {
  const seen = new Set(); let dup = 0;
  rows.forEach(r => { const v = r[field]; if (seen.has(v)) dup++; seen.add(v); });
  assert.strictEqual(dup, 0, field + ' has duplicates');
});
['article_id', 'slug', 'output_path', 'canonical', 'primary_keyword'].forEach(uniqueTest);
test('matrix: cannibalization_group present on every row', () => {
  assert.strictEqual(rows.filter(r => !r.cannibalization_group).length, 0);
});
test('matrix: valid status values only', () => {
  const ok = new Set(['PLANNED','RESEARCH','WRITING','QA','PASS','PUBLISHED','REVIEW','REPAIR','BLOCKED']);
  assert.strictEqual(rows.filter(r => !ok.has(r.status)).length, 0);
});

// ---------- CONFIG CONTRACTS ----------
test('config: rubric pass_min=90, review_min=80, max_repair=3', () => {
  assert.strictEqual(rubric.pass_min, 90); assert.strictEqual(rubric.review_min, 80);
  assert.strictEqual(rubric.max_repair_attempts, 3);
});
test('config: factory BATCH=50, CHUNK=10, bootstrap publication cap=10', () => {
  assert.strictEqual(cfg.BATCH, 50); assert.strictEqual(cfg.CHUNK, 10);
  assert.strictEqual(cfg.max_publication_in_bootstrap, 10);
});
test('experiment: zero-backlink baseline declared', () => {
  const exp = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'seo-experiment.json'), 'utf8'));
  assert.match(exp.baseline, /zero/);
});

// ---------- GEOGRAPHY ----------
test('geography: 34 current provinces', () => {
  const p = require(path.join(DATA, 'geography', 'provinces.json')).provinces;
  assert.strictEqual(p.length, 34);
});
test('geography: legacy names list has 63 entries (Hòa Bình split counts twice)', () => {
  const l = require(path.join(DATA, 'geography', 'legacy-names.json')).legacy_names;
  assert.strictEqual(l.length, 63);
});
test('geography: every entity has geo_id, name, type, verified_source', () => {
  const files = { 'provinces.json': 'provinces', 'localities.json': 'localities', 'legacy-names.json': 'legacy_names', 'transport-hubs.json': 'transport_hubs', 'tourism-poi.json': 'tourism_poi', 'important-poi.json': 'important_poi' };
  for (const [f, key] of Object.entries(files)) {
    const list = require(path.join(DATA, 'geography', f))[key];
    if (f === 'legacy-names.json') {
      list.forEach(e => { assert.ok(e.geo_id, f); assert.ok(e.legacy_name, f); assert.ok(e.verified_source, f); });
      continue;
    }
    list.forEach(e => { assert.ok(e.geo_id, f); assert.ok(e.name, f); assert.ok(e.type, f); assert.ok(e.verified_source, f); });
  }
});

// ---------- PUBLISHED / SITE ----------
test('bootstrap cap: published ≤ 10', () =>
  assert.ok(published.length <= cfg.max_publication_in_bootstrap));
test('published: public file, archive, and matrix agree', () => {
  published.forEach(r => {
    assert.ok(fs.existsSync(path.join(SITE, r.output_path, 'index.html')), 'no public file ' + r.output_path);
    assert.ok(fs.existsSync(path.join(DATA, 'published', r.article_id + '.html')), 'no archive ' + r.article_id);
    const html = fs.readFileSync(path.join(SITE, r.output_path, 'index.html'), 'utf8');
    assert.ok(html.includes('rel="canonical"'), 'no canonical');
    assert.ok(html.includes(r.canonical), 'wrong canonical in ' + r.article_id);
    assert.ok(/<h1[^>]*>/.test(html), 'no h1');
    assert.ok(/ld\+json/.test(html), 'no schema');
  });
});
test('published: QA score ≥ 90 and word count ≥ 1600', () => {
  published.forEach(r => {
    assert.ok(Number(r.qa_score) >= 90, r.article_id + ' qa=' + r.qa_score);
    const text = publishedHtml(r.article_id).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const words = (text.match(/[A-Za-zÀ-ỹ0-9]+/g) || []).length;
    assert.ok(words >= 1600, r.article_id + ' words=' + words);
  });
});
test('published: internal links resolve to real files', () => {
  const exists = href => {
    if (href.startsWith('/lab/assets/')) return fs.existsSync(path.join(SITE, href.replace(/^\/lab\//, '')));
    const p = href.replace(/^\/lab\//, '').replace(/\/$/, '');
    if (!p) return fs.existsSync(path.join(SITE, 'index.html'));
    return fs.existsSync(path.join(SITE, p, 'index.html'));
  };
  published.forEach(r => {
    const html = publishedHtml(r.article_id);
    const hrefs = [...html.matchAll(/href="(\/lab\/[^"#]+)"/g)].map(m => m[1]);
    assert.ok(hrefs.length >= 3, r.article_id + ' has ' + hrefs.length + ' internal links');
    hrefs.forEach(h => assert.ok(exists(h), r.article_id + ' broken link ' + h));
  });
});
test('truth: informational_only pages have no owner service claims / LocalBusiness schema', () => {
  rows.filter(r => r.actual_service_area === 'informational_only' && r.status === 'PUBLISHED').forEach(r => {
    const html = publishedHtml(r.article_id);
    assert.ok(!/"@type":"LocalBusiness"/.test(html), r.article_id + ' LocalBusiness schema');
    assert.ok(!/chúng tôi cứu hộ|đội cứu hộ của chúng tôi|gọi chúng tôi tại/.test(html), r.article_id + ' fake service claim');
  });
});
test('truth: footer NAP has no street address and no phone', () => {
  const home = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const foot = home.split('site-foot')[1] || '';
  assert.ok(!/\d{2}\s*(Nguyễn|Trần|Lê|Phạm|Phố|Đường)/.test(foot), 'street address in footer');
  assert.ok(!/0\d{9,10}/.test(foot), 'phone number in footer');
  assert.ok(foot.includes(facts.location_summary), 'location summary missing');
});
test('draft safety: no drafts directory under site/', () => {
  assert.ok(!fs.existsSync(path.join(SITE, '_drafts')));
});

// ---------- SITEMAP / SEARCH ----------
const sitemapFiles = () => fs.readdirSync(SITE).filter(f => /^sitemap-.*\.xml$/.test(f));
const sitemapUrls = () => {
  const urls = new Set();
  sitemapFiles().forEach(f => {
    const xml = fs.readFileSync(path.join(SITE, f), 'utf8');
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].forEach(m => urls.add(m[1]));
  });
  return urls;
};
test('sitemap: contains every PUBLISHED canonical', () => {
  const urls = sitemapUrls();
  published.forEach(r => assert.ok(urls.has(r.canonical), 'missing from sitemap: ' + r.canonical));
});
test('sitemap: contains no non-published matrix URLs', () => {
  const urls = sitemapUrls();
  const pubSet = new Set(published.map(r => r.canonical));
  rows.filter(r => r.status !== 'PUBLISHED').forEach(r =>
    assert.ok(!urls.has(r.canonical), 'non-published URL in sitemap: ' + r.canonical));
});
test('search index: only published pages indexed', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(SITE, 'assets', 'search-index.json'), 'utf8'));
  const pubPaths = new Set(published.map(r => '/lab/' + r.output_path));
  assert.strictEqual(idx.filter(e => !pubPaths.has('/lab/' + e.u)).length, 0);
  assert.strictEqual(idx.length, published.length);
});

// ---------- HUBS / RESEARCH ----------
test('hubs: topic hubs exist; geo hub slug uses tp-hcm', () => {
  ['thue-xe-may','cuu-ho-xe-may','sua-xe-may','bang-lai-xe-may','dang-ky-xe-may','xe-may-dien','phu-tung','kinh-nghiem','lien-he','ve-chung-toi']
    .forEach(s => assert.ok(fs.existsSync(path.join(SITE, s, 'index.html')), 'missing hub ' + s));
  if (published.some(r => /TP\.HCM|Hồ Chí Minh/i.test(r.province)))
    assert.ok(fs.existsSync(path.join(SITE, 'dia-phuong', 'tp-hcm', 'index.html')), 'geo hub tp-hcm missing');
});
test('research: non-PLANNED rows have a research packet', () => {
  rows.filter(r => ['RESEARCH','WRITING','QA','PASS','PUBLISHED','REVIEW','REPAIR'].includes(r.status))
    .forEach(r => assert.ok(fs.existsSync(path.join(DATA, 'research', r.article_id + '.json')), 'no packet ' + r.article_id));
});
test('research: official-source rows cite at least one official source', () => {
  rows.filter(r => r.requires_official_sources === '1' && r.status === 'PUBLISHED').forEach(r => {
    const p = JSON.parse(fs.readFileSync(path.join(DATA, 'research', r.article_id + '.json'), 'utf8'));
    assert.ok(p.official_sources && p.official_sources.length >= 1, r.article_id + ' missing official sources');
    p.official_sources.forEach(s => { assert.ok(s.source_url); assert.ok(s.claim_supported); });
  });
});

// ---------- URL HYGIENE / READER UX ----------
test('urls: no double-slash /lab// in any built page or search index', () => {
  const files = [];
  (function walk(d){fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{const p=path.join(d,e.name);e.isDirectory()?walk(p):files.push(p);});})(SITE);
  files.forEach(f => {
    const t = fs.readFileSync(f,'utf8');
    assert.ok(!t.includes('/lab//'), 'double slash in ' + f);
    assert.ok(!t.includes('github.io/lab//'), 'double slash canonical in ' + f);
  });
});
test('homepage: no internal QA scores exposed to readers', () => {
  const home = fs.readFileSync(path.join(SITE,'index.html'),'utf8');
  assert.ok(!/QA\s*\d/.test(home), 'QA score leaked on homepage');
  assert.ok(!/PUBLISHED|PLANNED|matrix|nhà máy nội dung/.test(home), 'factory language leaked on homepage');
});
