#!/usr/bin/env node
/** test-suite.js — factory + site invariants. Run: node --test tests/test-suite.js
 *  Assembles the matrix from parts (canonical shards) before testing. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
// Branch Pages architecture: the public tree is the REPOSITORY ROOT (main / (root)).
// site/ is a gitignored local intermediate. Source directories are never public
// output and are excluded from public walks.
const SITE = ROOT;
const SRC_TOP = new Set(['.git', '.github', '.gitignore', 'AGENTS.md', 'README.md', 'node_modules',
  'scripts', 'config', 'data', 'tests', 'docs', 'site', 'reports', '_drafts']);
// Every file served by Pages (repository root public outputs).
function publicFiles() {
  const out = [];
  for (const e of fs.readdirSync(ROOT)) {
    if (SRC_TOP.has(e)) continue;
    const p = path.join(ROOT, e);
    if (fs.statSync(p).isDirectory()) (function walk(d){fs.readdirSync(d,{withFileTypes:true}).forEach(x=>{const q=path.join(d,x.name);x.isDirectory()?walk(q):out.push(q);});})(p);
    else out.push(p);
  }
  // single public report URL — source file doubles as public output
  const bl = path.join(ROOT, 'reports', 'experiments', 'baseline.md');
  if (fs.existsSync(bl)) out.push(bl);
  return out;
}

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
test('factory phase contract: PILOT or PRODUCTION, checkpoint agrees', () => {
  assert.ok(['PILOT','PRODUCTION'].includes(cfg.phase), 'invalid phase ' + cfg.phase);
  const ck = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state', 'checkpoint.json'), 'utf8'));
  assert.strictEqual(ck.phase, cfg.phase, 'checkpoint phase disagrees with config');
});
test('bootstrap cap: published ≤ cap while in PILOT', () => {
  if (cfg.phase === 'PILOT')
    assert.ok(published.length <= cfg.max_publication_in_bootstrap);
});
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
test('draft safety: no drafts directory in the public tree', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, '_drafts')), 'drafts directory at repository root');
  assert.ok(publicFiles().every(f => !f.includes('_drafts')), 'drafts leaked into public root tree');
});

// ---------- POLICY PAGES / SHELL SEMANTICS ----------
test('policy pages: privacy & terms exist with canonical, one H1, real anchors', () => {
  ['chinh-sach-bao-mat', 'dieu-khoan-su-dung'].forEach(s => {
    const html = fs.readFileSync(path.join(SITE, s, 'index.html'), 'utf8');
    assert.ok(html.includes('rel="canonical"'), 'no canonical ' + s);
    assert.strictEqual((html.match(/<h1/g) || []).length, 1, 'h1 count ' + s);
    assert.ok(html.includes('href="/lab/lien-he/"'), 'no contact anchor ' + s);
  });
});
test('shell: no emoji menu icons; parent groups are buttons; utility anchors real', () => {
  const home = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  assert.ok(!/[🏍🧭🆘🔧📜🏷⚡⚙🔎☰]/u.test(home), 'emoji icon leaked into built shell');
  const head = home.slice(0, home.indexOf('</header>'));
  assert.ok((head.match(/<button[^>]*class="[^"]*nav-drop[^"]*"/g) || []).length >= 5, 'parent groups must be semantic buttons');
  ['/lab/', '/lab/ve-chung-toi/', '/lab/lien-he/', '/lab/chinh-sach-bao-mat/', '/lab/dieu-khoan-su-dung/'].forEach(href => {
    assert.ok(head.includes(`href="${href}"`), 'missing real anchor for ' + href);
  });
  assert.ok(!/javascript:void\(0\)/.test(home), 'javascript:void(0) in shell');
});
test('urls: every built internal href resolves to a real file; one H1 per page', () => {
  const files = publicFiles();
  const targets = new Set();
  files.forEach(f => {
    const t = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.html')) {
      assert.strictEqual((t.match(/<h1/g) || []).length, 1, 'H1 count != 1 in ' + f);
      [...t.matchAll(/href="(\/lab\/[^"#]*)"/g)].forEach(m => targets.add(m[1]));
    }
  });
  targets.forEach(h => {
    const p = h.replace(/^\/lab\//, '').replace(/\/$/, '');
    const ok = !p || fs.existsSync(path.join(ROOT, p, 'index.html')) || fs.existsSync(path.join(ROOT, p));
    assert.ok(ok, 'unresolved internal href ' + h);
  });
});

// ---------- SITEMAP / SEARCH ----------
const sitemapFiles = () => fs.readdirSync(ROOT).filter(f => /^sitemap-.*\.xml$/.test(f));
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
  publicFiles().forEach(f => {
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

// ---------- LOCAL READING ASSISTANT (chatbot) ----------
test('chatbot: assets generated and launcher present on every built page', () => {
  ['chatbot.js','chatbot-worker.js','knowledge-index.json'].forEach(a =>
    assert.ok(fs.existsSync(path.join(SITE,'assets',a)), 'missing asset ' + a));
  const htmlFiles = publicFiles().filter(f => f.endsWith('.html'));
  assert.ok(htmlFiles.length >= 20, 'too few built pages');
  htmlFiles.forEach(f => {
    const t = fs.readFileSync(f,'utf8');
    assert.ok(t.includes('id="chat-launcher"'), 'launcher missing in ' + f);
    assert.ok(t.includes('id="chat-panel"'), 'panel missing in ' + f);
    assert.ok(t.includes('/lab/assets/chatbot.js'), 'chatbot script missing in ' + f);
  });
});
test('chatbot: panel has dialog semantics + accessible controls', () => {
  const t = fs.readFileSync(path.join(SITE,'index.html'),'utf8');
  assert.ok(/role="dialog"[^>]*id="chat-panel"/.test(t) || /id="chat-panel"[^>]*role="dialog"/.test(t), 'panel not a dialog');
  assert.ok(/id="chat-launcher"[^>]*aria-expanded="false"/.test(t), 'launcher aria-expanded');
  assert.ok(/aria-controls="chat-panel"/.test(t), 'launcher aria-controls');
  assert.ok(/role="status"/.test(t), 'no live status region');
  assert.ok(/aria-label="Câu hỏi cho trợ lý"/.test(t), 'input not labelled');
  assert.ok(/aria-label="Xóa hội thoại"/.test(t), 'clear button not labelled');
});
test('chatbot: knowledge index covers published articles + static pages only', () => {
  const kb = JSON.parse(fs.readFileSync(path.join(SITE,'assets','knowledge-index.json'),'utf8'));
  assert.ok(kb.version === 1 && Array.isArray(kb.records) && kb.records.length >= 19, 'unexpected index shape');
  const us = kb.records.map(r => r.u);
  // every published article is indexed exactly with its output path
  published.forEach(r => assert.ok(us.includes(r.output_path), 'article missing from KB: ' + r.article_id));
  // no drafts / factory internals / unpublished matrix rows
  const planned = rows.filter(r => r.status !== 'PUBLISHED').map(r => r.output_path);
  kb.records.forEach(rec => {
    assert.ok(!planned.includes(rec.u), 'KB contains non-published row: ' + rec.u);
    assert.ok(!String(rec.u).includes('_drafts') && !String(rec.u).includes('data/'), 'KB has factory internal: ' + rec.u);
    const file = path.join(SITE, rec.u.replace(/\/$/,''), 'index.html');
    assert.ok(fs.existsSync(rec.u ? file : path.join(SITE,'index.html')), 'KB URL not built: ' + rec.u);
    assert.ok(rec.chunks.length >= 3 && rec.chunks.every(c => c.t && c.t.length <= 721), 'bad chunks in ' + rec.u);
  });
});
test('chatbot: no inference API, no API key, no NAP promotion', () => {
  const js = fs.readFileSync(path.join(SITE,'assets','chatbot.js'),'utf8');
  const w = fs.readFileSync(path.join(SITE,'assets','chatbot-worker.js'),'utf8');
  [js, w].forEach(src => {
    assert.ok(!/api[_-]?key/i.test(src), 'api key string present');
    assert.ok(!/openai\.com|api\.openai|gemini|anthropic|dashscope|qwen\.aliyun/i.test(src), 'commercial inference endpoint present');
    assert.ok(!/zalo|whatsapp|0\d{9,10}/i.test(src), 'NAP/service promotion in chatbot');
  });
  // conversation is never POSTed anywhere: only local fetch of the static knowledge index
  assert.ok(/fetch\('\/lab\/assets\/knowledge-index\.json'\)/.test(js), 'unexpected remote calls in chatbot.js');
  assert.ok(!/XMLHttpRequest|method:\s*['"]POST['"]|navigator\.sendBeacon/.test(js), 'chatbot posts data remotely');
  // the only remote import is the open-source WebLLM runtime in the worker (opt-in AI mode)
  assert.ok(w.includes("import('https://esm.run/@mlc-ai/webllm')"), 'worker must use WebLLM local runtime');
  assert.ok(w.includes('Qwen2.5-0.5B-Instruct-q4f16_1-MLC'), 'worker model id');
  assert.ok(!/await import\(/.test(js), 'main thread must not import the AI runtime eagerly');
});
test('chatbot: privacy page discloses local AI behavior truthfully', () => {
  const t = fs.readFileSync(path.join(SITE,'chinh-sach-bao-mat','index.html'),'utf8');
  assert.ok(/cục bộ/.test(t) && /inference API|dịch vụ suy luận/.test(t), 'privacy must disclose local AI');
  assert.ok(!/100% offline/.test(t), 'privacy overclaims offline behavior');
  // the "no network request" wording may only appear inside an explicit non-guarantee
  assert.ok(!/cam kết ["']?không có bất kỳ yêu cầu mạng nào["']?(?!.*không cam kết)/.test(t) || /không cam kết/.test(t), 'privacy guarantees zero network');
});

// ---------- BRANCH PAGES: repository root is the deployable public tree ----------
test('branch-pages: root public tree exists (index.html, assets/style.css, .nojekyll)', () => {
  assert.ok(fs.existsSync(path.join(ROOT,'index.html')), 'root index.html missing');
  assert.ok(fs.existsSync(path.join(ROOT,'assets','style.css')), 'root assets/style.css missing');
  assert.ok(fs.existsSync(path.join(ROOT,'.nojekyll')), 'root .nojekyll missing');
  assert.ok(fs.existsSync(path.join(ROOT,'robots.txt')) && fs.existsSync(path.join(ROOT,'sitemap-index.xml')), 'root robots/sitemap missing');
});
test('branch-pages: root hubs and policy pages exist', () => {
  ['thue-xe-may','kinh-nghiem','cuu-ho-xe-may','sua-xe-may','bang-lai-xe-may','dang-ky-xe-may','xe-may-dien','phu-tung',
   've-chung-toi','lien-he','chinh-sach-bao-mat','dieu-khoan-su-dung'].forEach(h =>
    assert.ok(fs.existsSync(path.join(ROOT,h,'index.html')), 'root hub/policy page missing: ' + h));
  published.forEach(r => assert.ok(fs.existsSync(path.join(ROOT, r.output_path.replace(/\/$/,''), 'index.html')),
    'root article page missing: ' + r.article_id));
});
test('branch-pages: no canonical or href references /lab/site/ (single public tree)', () => {
  publicFiles().forEach(f => {
    const t = fs.readFileSync(f,'utf8');
    if (f.endsWith('.html')) {
      assert.ok(!/href="\/lab\/site\//.test(t), 'href points into /lab/site/: ' + f);
      assert.ok(!/rel="canonical" href="[^"]*\/lab\/site\//.test(t), 'canonical points into /lab/site/: ' + f);
    }
    if (f.endsWith('.xml')) assert.ok(!/\/lab\/site\//.test(t), 'sitemap references /lab/site/: ' + f);
  });
});
test('branch-pages: exactly one Pages publisher — no Pages-permissions workflow remains', () => {
  const wf = path.join(ROOT,'.github','workflows');
  const files = fs.readdirSync(wf).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.ok(files.length >= 1, 'no workflows found');
  files.forEach(f => {
    const t = fs.readFileSync(path.join(wf,f),'utf8');
    assert.ok(!/upload-pages-artifact|deploy-pages/.test(t), 'Pages deployment action in ' + f);
    assert.ok(!/pages:\s*write|id-token:\s*write/.test(t), 'Pages/id-token permission in ' + f);
  });
});
test('branch-pages: factory state intact (PRODUCTION, 10,000 rows, published count)', () => {
  const st = JSON.parse(fs.readFileSync(path.join(DATA,'state','checkpoint.json'),'utf8'));
  assert.strictEqual(st.phase, 'PRODUCTION');
  assert.strictEqual(rows.length, 10000);
  assert.strictEqual(published.length, 10);
});
