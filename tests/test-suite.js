#!/usr/bin/env node
/** test-suite.js — factory + site invariants. Run: node --test tests/test-suite.js
 *  Assembles the matrix from parts (canonical shards) before testing. */
'use strict';
// NEVER write to the runner's GITHUB_ENV: this suite spawns `operator.js
// validate` on sandbox command files, and exportEnv() appends OP/SCOPE/etc.
// to process.env.GITHUB_ENV when set. Inside a workflow's verify step that
// would pollute/override the run's real command env (e.g. flip $SCOPE or the
// operator commit message). Strip it for this process and every child.
if (process.env.GITHUB_ENV) delete process.env.GITHUB_ENV;
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
    // real files (sitemap index, robots, reports) are not route directories
    if (/\.(xml|txt|md|json)$/i.test(p)) return fs.existsSync(path.join(SITE, p));
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
// ---------- FOOTER: compact mini-sitemap derived from the canonical nav registry ----------
const shell = require(path.join(ROOT, 'scripts', 'site', 'shell.js'));
const footOf = html => html.split('site-foot')[1] || '';
test('footer: compact mini-sitemap derives from the canonical nav registry (header/footer equality)', () => {
  const home = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const foot = footOf(home);
  const header = home.slice(0, home.indexOf('</header>'));
  shell.FOOTER_NAV.forEach(col => {
    // group label carries a small icon from the SAME inline-SVG system the header uses
    assert.ok(foot.includes('class="foot-label"><span class="foot-label-ico">' + shell.svg(col.icon) + '</span>' + shell.esc(col.label)),
      'footer column missing icon+label: ' + col.label);
    assert.ok(shell.ICON[col.icon], 'footer group icon not in the canonical ICON set: ' + col.icon);
    col.slugs.forEach(s => {
      const link = shell.NAV_BY_SLUG[s];
      assert.ok(link, 'footer slug not in canonical registry: ' + s);
      // footer label + href must match the registry EXACTLY (labels are HTML-escaped)
      assert.ok(foot.includes('href="' + link.href + '">' + shell.esc(link.nav) + '</a>'),
        'footer link drifts from registry: ' + s);
      // the SAME nav destination must exist in the header (desktop nav, dropdown or
      // drawer). The sitemap file is footer-only by design — not a nav destination.
      if (s !== 'sitemap-index')
        assert.ok(header.includes('href="' + link.href + '"'), 'header missing canonical destination: ' + link.href);
    });
  });
  // hub link labels in footer === canonical menu labels consumed by the header
  shell.GROUPS.forEach(g => g.children.forEach(c => {
    const link = shell.NAV_BY_SLUG[c.slug];
    assert.strictEqual(link.nav, c.nav, 'registry label drift for ' + c.slug);
    assert.ok(foot.includes('>' + shell.esc(c.nav) + '</a>'), 'footer missing canonical label: ' + c.nav);
  }));
});
test('footer: no second hardcoded nav URL map — footer resolves through NAV_BY_SLUG', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'shell.js'), 'utf8');
  assert.ok(src.includes('NAV_BY_SLUG[s]'), 'footerHtml must resolve via NAV_BY_SLUG');
  assert.ok(src.includes('FOOTER_NAV'), 'footerHtml must consume FOOTER_NAV (slug-only layout)');
  // hub URLs are template-derived; a literal hub URL anywhere in the shell
  // would be a second, drift-prone URL map
  shell.GROUPS.forEach(g => g.children.forEach(c =>
    assert.ok(!src.includes(`'/lab/${c.slug}/'`) && !src.includes(`"/lab/${c.slug}/"`),
      'hardcoded hub URL literal in shell: ' + c.slug)));
  // rendered footer carries exactly the registry links — nothing extra
  const home = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const foot = footOf(home);
  const expected = shell.FOOTER_NAV.reduce((n, c) => n + c.slugs.length, 0);
  assert.strictEqual((foot.match(/<li><a href=/g) || []).length, expected,
    'footer link count != registry size (second link source?)');
});
test('footer: compact — group-label icons only (canonical SVG system), no descriptions/dropdown/NAP; short brand + copyright retained', () => {
  const foot = footOf(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'));
  assert.ok(!foot.includes('dd-desc'), 'category descriptions leaked into footer');
  assert.ok(!foot.includes('dd-icon'), 'header dropdown icons leaked into footer');
  assert.ok(!foot.includes('dropdown') && !foot.includes('drawer'), 'header widgets leaked into footer');
  assert.ok(!foot.includes('href="tel:') && !foot.includes('mailto:'), 'NAP contact leaked into footer');
  assert.ok(!/\d{2}\s*(Nguyễn|Trần|Lê|Phạm|Phố|Đường)/.test(foot), 'street address in footer');
  assert.ok(!/0\d{9,10}/.test(foot), 'phone number in footer');
  // owner decision: footer displays the SHORT brand only
  assert.ok(/class="foot-brand">Bản Đồ Xe 2 Bánh</.test(foot), 'footer brand must be the short brand');
  assert.ok(!foot.includes(shell.BRAND_FULL), 'long brand must not appear in the footer');
  assert.ok(/© \d{4} Bản Đồ Xe 2 Bánh</.test(foot), 'copyright must use the short brand');
  assert.ok(foot.includes('Cẩm nang nghiên cứu thực tế về xe máy, hành trình, bảo dưỡng, pháp lý và phương tiện hai bánh tại Việt Nam.'),
    'footer tagline must be unchanged');
  // group-label icons must come from the shell SVG system (no second icon source)
  shell.FOOTER_NAV.forEach(col => {
    assert.ok(shell.ICON[col.icon], 'footer icon outside canonical ICON set: ' + col.icon);
    assert.ok(foot.includes('<span class="foot-label-ico">' + shell.svg(col.icon)), 'footer label icon missing: ' + col.icon);
    assert.ok(!/<img/.test(foot), 'footer must not load external images');
  });
  assert.ok(foot.includes('/lab/sitemap-index.xml'), 'sitemap link missing from footer');
  assert.ok(foot.includes('Dữ liệu &amp; nội dung được biên tập theo nguồn đã kiểm chứng.'),
    'verified-source sentence missing from footer');
});
test('footer: exactly one footer per public page, registry-identical links everywhere', () => {
  publicFiles().filter(f => f.endsWith('.html')).forEach(f => {
    const t = fs.readFileSync(f, 'utf8');
    assert.strictEqual((t.match(/<footer class="site-foot"/g) || []).length, 1, 'footer count != 1 in ' + f);
    shell.FOOTER_NAV.forEach(col => col.slugs.forEach(s => {
      const link = shell.NAV_BY_SLUG[s];
      assert.ok(t.includes('href="' + link.href + '">' + shell.esc(link.nav) + '</a>'),
        'footer drift from registry in ' + f + ' for ' + s);
    }));
  });
  // every footer target resolves to a real file
  shell.FOOTER_NAV.forEach(col => col.slugs.forEach(s => {
    const href = shell.NAV_BY_SLUG[s].href;
    const p = href.replace(/^\/lab\//, '').replace(/\/$/, '');
    const ok = !p ? fs.existsSync(path.join(ROOT, 'index.html'))
      : href.endsWith('.xml') ? fs.existsSync(path.join(ROOT, p))
      : fs.existsSync(path.join(ROOT, p, 'index.html'));
    assert.ok(ok, 'footer target does not resolve: ' + href);
  }));
});
test('footer: mobile layout collapses structurally — wrap, no overflow risk', () => {
  const css = fs.readFileSync(path.join(SITE, 'assets', 'style.css'), 'utf8');
  assert.ok(/\.foot-nav\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(css),
    'desktop 3-column footer grid missing');
  assert.ok(/@media\(max-width:767px\)\{\.foot-nav\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/.test(css),
    'phone 2-column footer grid missing');
  assert.ok(/@media\(max-width:379px\)\{\.foot-nav\{grid-template-columns:1fr\}\}/.test(css),
    'very-narrow 1-column footer grid missing');
  assert.ok(/\.foot-links\{[^}]*flex-wrap:wrap/.test(css), 'footer links must wrap (overflow risk)');
  assert.ok(css.includes('overflow-x:clip'), 'page-level horizontal overflow guard missing');
});
test('draft safety: drafts can never reach the public tree', () => {
  // _drafts/ at the repo root is the canonical WRITER-side draft home: gitignored,
  // never committed, never promoted — its local existence is NOT a leak. A real
  // leak would be drafts inside the promotable staging tree or a missing gitignore.
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /(^|\n)_drafts\//, '.gitignore must exclude _drafts/ or drafts would go public');
  assert.ok(!fs.existsSync(path.join(ROOT, 'site', '_drafts')), 'drafts inside site/ staging — would be promoted to the public root');
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
test('sitemap: every URL appears exactly once across all shards (no duplicates)', () => {
  const all = [];
  sitemapFiles().forEach(f => {
    const xml = fs.readFileSync(path.join(SITE, f), 'utf8');
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].forEach(m => all.push(m[1]));
  });
  const dups = all.filter((u, i) => all.indexOf(u) !== i);
  assert.strictEqual(all.length, new Set(all).size, 'duplicate sitemap URLs: ' + [...new Set(dups)].join(', '));
  // homepage is owned by the static sitemap only
  assert.ok(all.filter(u => u === cfg.site_base_url || u === 'https://thuexemayhanoi.github.io/lab/').length === 1,
    'homepage must appear in exactly one sitemap');
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
  // published count must agree across matrix truth, checkpoint and durable archives
  assert.ok(published.length >= 10, 'the bootstrap published set must never shrink');
  assert.strictEqual(st.published_count, published.length, 'checkpoint published_count drift vs matrix');
  const archived = fs.readdirSync(path.join(DATA, 'published')).filter(f => f.endsWith('.html')).length;
  assert.strictEqual(archived, published.length, 'archive count drift vs matrix published set');
});

// ---------- A11Y SKIP LINK / OG METADATA / 404 (audit AUD-02, AUD-03, AUD-09) ----------
test('a11y: skip link on every public page targets the main content', () => {
  publicFiles().filter(f => f.endsWith('.html')).forEach(f => {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(t.includes('class="skip-link" href="#main-content"'), 'skip link missing in ' + f);
    assert.ok(/<main[^>]*id="main-content"/.test(t), 'main content id missing in ' + f);
  });
  const css = fs.readFileSync(path.join(SITE, 'assets', 'style.css'), 'utf8');
  assert.ok(/\.skip-link\{[^}]*position:absolute/.test(css), 'skip link must not affect layout when unfocused');
  assert.ok(/\.skip-link:focus\{[^}]*top:0\}/.test(css), 'skip link must become visible on keyboard focus');
});
test('seo: every indexable public page has Open Graph metadata (og:url == canonical)', () => {
  publicFiles().filter(f => f.endsWith('.html') && !f.endsWith(path.join('404.html'))).forEach(f => {
    const t = fs.readFileSync(f, 'utf8');
    ['og:title', 'og:description', 'og:url', 'og:type'].forEach(p =>
      assert.ok(t.includes('property="' + p + '"'), p + ' missing in ' + f));
    const ogUrl = (t.match(/<meta property="og:url" content="([^"]*)"/) || [])[1];
    const canon = (t.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
    assert.ok(ogUrl && ogUrl === canon, 'og:url must equal canonical in ' + f);
  });
});
test('branch-pages: custom 404 — noindex, one H1, shared shell, way-back links, no canonical', () => {
  const t = fs.readFileSync(path.join(SITE, '404.html'), 'utf8');
  assert.ok(/<meta name="robots" content="noindex, follow">/.test(t), '404 must be noindex');
  assert.strictEqual((t.match(/<h1/g) || []).length, 1, '404 H1 count != 1');
  assert.ok(!t.includes('rel="canonical"'), '404 must not carry a canonical');
  assert.ok(!t.includes('property="og:url"'), '404 must not declare an og:url');
  assert.ok(t.includes('href="/lab/"'), '404 missing home link');
  assert.ok((t.match(/<footer class="site-foot"/g) || []).length === 1, '404 missing the shared footer');
  assert.ok(t.includes('class="skip-link"'), '404 missing skip link');
  assert.ok(t.includes('id="chat-launcher"'), '404 missing chatbot launcher (shared shell)');
});

// ---------- MENU / IA: Trang chủ + Giới thiệu lead everywhere (desktop = tablet = mobile) ----------
test('menu: Trang chủ first, Giới thiệu second — desktop nav AND mobile drawer, on every page', () => {
  const pages = publicFiles().filter(f => f.endsWith('.html'));
  assert.ok(pages.length >= 20, 'too few built pages');
  pages.forEach(f => {
    const t = fs.readFileSync(f, 'utf8');
    // desktop / tablet nav: the first two .nav-link anchors
    const nav = [...t.matchAll(/<a class="nav-link" href="([^"]+)">([^<]*)<\/a>/g)];
    assert.ok(nav.length >= 2, 'fewer than 2 nav links in ' + f);
    assert.strictEqual(nav[0][1], '/lab/', 'first nav link is not Trang chủ in ' + f);
    assert.strictEqual(nav[0][2].trim(), 'Trang chủ', 'first nav label wrong in ' + f);
    assert.strictEqual(nav[1][1], '/lab/ve-chung-toi/', 'second nav link is not Giới thiệu in ' + f);
    assert.strictEqual(nav[1][2].trim(), 'Giới thiệu', 'second nav label wrong in ' + f);
    // mobile drawer: main group appears directly under the brand, BEFORE category groups
    const iMain = t.indexOf('dr-group-main');
    const iCat = t.indexOf('<div class="dr-group">');
    assert.ok(iMain >= 0, 'drawer main group missing in ' + f);
    assert.ok(iCat < 0 || iMain < iCat, 'drawer: Trang chủ/Giới thiệu must precede category groups in ' + f);
    const main = t.match(/<div class="dr-group dr-group-main">([\s\S]*?)<\/div>/);
    assert.ok(main, 'drawer main group malformed in ' + f);
    const dr = [...main[1].matchAll(/<a class="dr-link dr-main-link" href="([^"]+)">[\s\S]*?<span class="dr-text">([^<]*)<\/span>/g)];
    assert.ok(dr.length >= 2, 'drawer main links missing in ' + f);
    assert.strictEqual(dr[0][1], '/lab/', 'drawer: Trang chủ not first in ' + f);
    assert.strictEqual(dr[0][2].trim(), 'Trang chủ', 'drawer: first label wrong in ' + f);
    assert.strictEqual(dr[1][1], '/lab/ve-chung-toi/', 'drawer: Giới thiệu not second in ' + f);
    assert.strictEqual(dr[1][2].trim(), 'Giới thiệu', 'drawer: second label wrong in ' + f);
  });
});
test('menu: every nav / drawer / dropdown target resolves to a built public page', () => {
  publicFiles().filter(f => f.endsWith('.html')).forEach(f => {
    const t = fs.readFileSync(f, 'utf8');
    const hrefs = [...t.matchAll(/<a class="(?:nav-link|dr-link[^"]*|dd-link[^"]*)"[^>]*href="(\/lab\/[^"#]*)"/g)].map(m => m[1]);
    assert.ok(hrefs.length >= 6, 'too few nav hrefs in ' + f);
    hrefs.forEach(h => {
      const rel = h.replace(/^\/lab\//, '').replace(/\/$/, '');
      const p = rel ? path.join(ROOT, rel, 'index.html') : path.join(ROOT, 'index.html');
      assert.ok(fs.existsSync(p), 'nav target not built: ' + h + ' (from ' + f + ')');
    });
  });
});

// ---------- RESPONSIVE / SHARED DESIGN SYSTEM ----------
test('design: shared stylesheet carries the responsive editorial system (not per-article CSS)', () => {
  const css = fs.readFileSync(path.join(SITE, 'assets', 'style.css'), 'utf8');
  // fluid type + true responsive guards
  ['clamp(', '100dvh', 'env(safe-area-inset-bottom', 'overflow-x:clip',
   '@media(prefers-reduced-motion:reduce)'].forEach(m =>
    assert.ok(css.includes(m), 'style.css missing responsive marker: ' + m));
  // shared editorial components
  ['.table-scroll', '.key-points', 'ol.steps', 'ul.checklist', '.sources', '.faq',
   '.article-hero', '.article-lead', '.quick'].forEach(m =>
    assert.ok(css.includes(m), 'style.css missing editorial component: ' + m));
  // canonical sources are read by the builder (presentation is generator-owned)
  const b = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'build-site.js'), 'utf8');
  assert.ok(/readFileSync\(path\.join\(__dirname,\s*'style\.css'\)/.test(b), 'build-site must read canonical style.css');
  assert.ok(/readFileSync\(path\.join\(__dirname,\s*'menu\.js'\)/.test(b), 'build-site must read canonical menu.js');
  // future drafts inherit the same shell automatically: wrap-drafts emits the
  // shared header/footer, and build-site decorates every published page
  const w = fs.readFileSync(path.join(ROOT, 'scripts', 'factory', 'wrap-drafts.js'), 'utf8');
  assert.ok(/site', 'shell\.js'/.test(w) || /shell\.js/.test(w), 'wrap-drafts must use shared shell');
  assert.ok(w.includes('shell.headerHtml()'), 'wrap-drafts must emit the shared header');
  assert.ok(b.includes('shell.decorateArticle('), 'build-site must decorate every published page');
});
test('design: published articles render the shared editorial chrome, no one-off styling', () => {
  published.forEach(r => {
    const p = path.join(ROOT, r.output_path.replace(/\/$/, ''), 'index.html');
    const t = fs.readFileSync(p, 'utf8');
    assert.ok(t.includes('<header class="article-hero'), 'article hero missing in ' + r.article_id);
    assert.ok(/class="article-lead">[^<]/.test(t), 'empty/stray article lead in ' + r.article_id);
    assert.ok(!/class="article-lead">p>/.test(t), 'stray "p>" prefix in article lead of ' + r.article_id);
    assert.ok(!t.includes('<style'), 'inline <style> block in ' + r.article_id);
    assert.ok(t.includes('class="key-points"'), 'key-points box missing in ' + r.article_id);
    assert.ok(/<details class="faq/.test(t), 'FAQ details missing in ' + r.article_id);
    // any table in the canonical archive must ship inside the responsive wrapper
    const arch = fs.readFileSync(path.join(DATA, 'published', r.article_id + '.html'), 'utf8');
    if (arch.includes('<table')) {
      assert.ok(/<div class="table-scroll" role="region"/.test(t), 'responsive table wrapper missing in ' + r.article_id);
    }
  });
});

// ---------- CHATBOT COMPACT/MOBILE-FIRST CONTRACT ----------
test('chatbot: navy subsystem identity + responsive AI panel (desktop / tablet / mobile bottom sheet)', () => {
  const css = fs.readFileSync(path.join(SITE, 'assets', 'style.css'), 'utf8');
  const t = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  assert.ok(css.includes('--chat-bg:#0F172A'), 'chatbot navy tokens missing');
  assert.ok(/--chat-vh,100dvh/.test(css), 'dynamic viewport height fallback missing');
  // DESKTOP: large comfortable panel 440–520px wide, 620–760px tall, viewport-capped
  assert.ok(/\.chat-panel\{[^}]*width:clamp\(440px,34vw,520px\)/.test(css), 'desktop width must clamp to 440–520px');
  assert.ok(/\.chat-panel\{[^}]*height:clamp\(620px,72dvh,760px\)/.test(css), 'desktop height must clamp to 620–760px');
  assert.ok(/\.chat-panel\{[^}]*max-width:calc\(100vw - 32px\)/.test(css), 'desktop panel must not overflow narrow viewports');
  assert.ok(/\.chat-panel\{[^}]*max-height:calc\(var\(--chat-vh,100dvh\) - 48px\)/.test(css), 'desktop panel must be capped to the viewport');
  // TABLET: its OWN centered layout (not a shrunk desktop panel): 70–85vw wide, 70–82dvh tall
  const tablet = css.match(/@media\(min-width:768px\) and \(max-width:1023px\)\{[\s\S]*?\n\}/);
  assert.ok(tablet, 'tablet breakpoint block missing');
  assert.ok(/\.chat-panel\{left:50%;right:auto;transform:translateX\(-50%\)/.test(tablet[0]), 'tablet panel must be centered');
  assert.ok(/width:min\(85vw,520px\)/.test(tablet[0]), 'tablet width must be 70–85vw with a sane max-width');
  assert.ok(/height:min\(82dvh,720px\)/.test(tablet[0]), 'tablet height must be 70–82dvh');
  // MOBILE: LARGE bottom sheet — near full width (8–12px margins honoring safe areas),
  // 82–92dvh tall, rounded top corners, never 100vh
  const mobile = css.match(/@media\(max-width:767px\)\{[\s\S]*?\.chat-panel\{[\s\S]*?border-bottom:0/);
  assert.ok(mobile, 'mobile bottom-sheet rule missing for .chat-panel');
  assert.ok(/left:max\(10px,env\(safe-area-inset-left,0px\)\)/.test(mobile[0]), 'mobile sheet must honor left safe area');
  assert.ok(/right:max\(10px,env\(safe-area-inset-right,0px\)\)/.test(mobile[0]), 'mobile sheet must honor right safe area');
  assert.ok(/height:min\(88dvh,calc\(var\(--chat-vh,100dvh\) - 10px\)\)/.test(mobile[0]), 'mobile sheet must be 82–92dvh');
  assert.ok(/border-radius:22px 22px 0 0/.test(mobile[0]), 'mobile sheet must round only the top corners');
  assert.ok(/body\.chat-open\{overflow:hidden\}/.test(mobile[0]), 'mobile must lock body scroll while sheet is open (no double scroll)');
  assert.ok(css.includes('.chat-handle'), 'bottom-sheet handle missing');
  // composer: 16px textarea (no iOS zoom), bounded auto-grow, safe-area aware on mobile
  assert.ok(/\.chat-input textarea\{[^}]*font-size:16px/.test(css), 'textarea must be 16px to avoid iOS zoom');
  assert.ok(/\.chat-input textarea\{[^}]*max-height:96px/.test(css), 'auto-grow max height not bounded');
  assert.ok(/\.chat-input\{padding:8px 10px calc\(10px \+ env\(safe-area-inset-bottom,0px\)\)/.test(css),
    'composer bottom padding must add env(safe-area-inset-bottom)');
  assert.ok(css.includes('.chat-msg{max-width:min(92%,440px)'), 'bubbles not width-bounded');
  assert.ok(/\.chat-title-name\{font-size:clamp\(11\.5px,3\.1vw,13px\)\}/.test(css), 'mobile title sizing missing');
  assert.ok(/@media\(max-width:479px\)/.test(css), 'sub-480px tuning missing');
  assert.ok(/@media\(max-width:379px\)/.test(css), 'very-narrow fallback missing');
  // composer is the LAST element of the panel (always visible above the keyboard)
  const panel = t.match(/<section class="chat-panel"[\s\S]*?<\/section>/);
  assert.ok(panel, 'chat panel markup missing');
  assert.ok(/<\/form>\s*<\/section>$/.test(panel[0]), 'composer form must be the last child of the panel');
  assert.ok(/<textarea id="chat-q"[^>]*enterkeyhint="send"/.test(panel[0]), 'mobile keyboards need enterkeyhint=send');
});
test('chatbot: no fixed 100vh bug — iPhone safe areas respected by launcher and composer', () => {
  const css = fs.readFileSync(path.join(SITE, 'assets', 'style.css'), 'utf8');
  // dvh/svh dynamic viewport everywhere; a hard 100vh height would break under the iOS keyboard
  assert.ok(!/height:100vh/.test(css) && !/max-height:100vh/.test(css) && !/min-height:100vh/.test(css),
    'fixed 100vh height is forbidden (keyboard jumps)');
  assert.ok(/height:min\(88dvh/.test(css), 'mobile sheet height must use dvh units');
  // floating launcher lifted above the iPhone home indicator / Safari bar
  assert.ok(/\.chat-launcher\{[^}]*bottom:calc\(16px \+ env\(safe-area-inset-bottom,0px\)\)/.test(css),
    'launcher must sit above env(safe-area-inset-bottom)');
  assert.ok(/\.chat-launcher\{[^}]*right:max\(16px,env\(safe-area-inset-right,0px\)\)/.test(css),
    'launcher must honor the right safe area (landscape notch)');
  // chat log owns its scroll; body behind the sheet does not double-scroll
  assert.ok(/\.chat-log\{[^}]*overscroll-behavior:contain/.test(css), 'chat log must contain overscroll');
});
test('chatbot: friendly local-AI failure UX — no raw module error in UI', () => {
  const js = fs.readFileSync(path.join(SITE, 'assets', 'chatbot.js'), 'utf8');
  assert.ok(!/Importing a module script failed/.test(js), 'raw technical error string leaked into chatbot UI');
  assert.ok(js.includes('AI cục bộ chưa khả dụng trên thiết bị này.'), 'friendly AI-unavailable message missing');
  assert.ok(js.includes('console.warn'), 'technical detail must stay in console');
});
test('chatbot: embed is single, textarea composer, keyboard-safe, no chips', () => {
  const js = fs.readFileSync(path.join(SITE, 'assets', 'chatbot.js'), 'utf8');
  assert.ok(js.includes('visualViewport'), 'visualViewport keyboard handling missing');
  assert.ok(/requestSubmit|dispatchEvent\(new Event\('submit'/.test(js), 'Enter-to-send path missing');
  assert.ok(js.includes('autoGrow'), 'textarea auto-grow missing');
  assert.ok(js.includes('setBusy'), 'busy state on send control missing');
  publicFiles().filter(f => f.endsWith('.html')).forEach(f => {
    const t = fs.readFileSync(f, 'utf8');
    assert.strictEqual((t.match(/id="chat-launcher"/g) || []).length, 1, 'launcher not exactly once in ' + f);
    assert.strictEqual((t.match(/id="chat-panel"/g) || []).length, 1, 'panel not exactly once in ' + f);
    assert.ok(/<textarea id="chat-q" rows="1"[^>]*aria-label="Câu hỏi cho trợ lý"/.test(t), 'labelled textarea composer missing in ' + f);
    assert.ok(t.includes('chat-title-sub'), 'assistant identity header missing in ' + f);
    assert.ok(!/chat-chip|suggestion-chip|prompt-chip/.test(t), 'suggestion chips present in ' + f);
  });
});
test('chatbot: compact header actions — overflow menu holds clear, controls stay >=44px', () => {
  const t = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  assert.ok(/id="chat-more-btn"[^>]*aria-haspopup="menu"/.test(t), 'overflow menu button missing');
  assert.ok(/<div class="chat-menu"[^>]*role="menu"/.test(t), 'overflow menu container missing');
  assert.ok(/id="chat-clear"[^>]*role="menuitem"[^>]*aria-label="Xóa hội thoại"|aria-label="Xóa hội thoại"[^>]*role="menuitem"/.test(t), 'clear must live in the overflow menu');
  assert.ok(t.includes('class="chat-handle"'), 'bottom-sheet handle missing from markup');
  assert.ok(/id="chat-mode"[^>]*>Tra cứu nội dung</.test(t), 'compact mode badge missing');
  const css = fs.readFileSync(path.join(SITE, 'assets', 'style.css'), 'utf8');
  assert.ok(/\.chat-ai-toggle\{[^}]*min-height:44px/.test(css), 'AI toggle touch target < 44px');
  assert.ok(/\.chat-more-btn,\.chat-close\{[^}]*width:44px;height:44px/.test(css), 'header controls < 44px');
});

// ---------- CONTACT / PRIVACY TRUST ----------
test('contact: verified NAP, responsive Maps embed (verified address only) + truthful LocalBusiness schema', () => {
  const t = fs.readFileSync(path.join(SITE, 'lien-he', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(SITE, 'assets', 'style.css'), 'utf8');
  const f = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'business-facts.json'), 'utf8'));
  assert.ok(t.includes('112 Nguyễn Văn Cừ, Bồ Đề, Long Biên, Hà Nội, Việt Nam'), 'exact address missing');
  // the address is displayed exactly ONCE — in the contact-info section, never repeated below
  assert.strictEqual((t.match(/112 Nguyễn Văn Cừ, Bồ Đề, Long Biên, Hà Nội, Việt Nam/g) || []).length, 1,
    'address must appear exactly once on the contact page');
  assert.ok(t.includes('0942 467 674'), 'exact phone missing');
  assert.ok(t.includes('nguyentuantu8x@gmail.com'), 'exact email missing');
  assert.ok(t.includes('09:00 - 21:00'), 'exact opening hours missing');
  assert.ok(t.includes('https://thuexemaynguyentu.com'), 'verified website missing');
  assert.ok(t.includes('href="tel:+84942467674"'), 'tel: link missing');
  assert.ok(t.includes('href="mailto:nguyentuantu8x@gmail.com"'), 'mailto: link missing');
  assert.ok(t.includes('https://share.google/59Er3R16jWr3psKeo'), 'Google Maps CTA missing');
  assert.ok(t.includes('Thuê Xe Máy Nguyễn Tú'), 'verified business name missing');
  // Maps embed: built ONLY from the verified repo address (no invented coordinates),
  // responsive, rounded, lazy, fully labelled
  const ifr = t.match(/<iframe[^>]*src="([^"]*)"[^>]*>/);
  assert.ok(ifr, 'contact page must embed a Google Maps iframe');
  assert.ok(ifr[1].startsWith('https://www.google.com/maps?q=' + encodeURIComponent(f.address) + '&amp;output=embed'),
    'iframe must embed the EXACT verified address from business-facts.json (no new address/coords)');
  assert.ok(/loading="lazy"/.test(ifr[0]), 'map iframe must lazy-load');
  assert.ok(/title="[^"]+"/.test(ifr[0]), 'map iframe must have an accessible title');
  assert.ok(/\.map-embed\{[^}]*width:100%;aspect-ratio:16\/10/.test(css), 'map embed must be 100% responsive');
  assert.ok(/\.map-embed iframe\{[^}]*border:0/.test(css), 'map iframe must be borderless (rounded by wrapper)');
  assert.ok(/Mở Google Maps/.test(t), 'Mở Google Maps button must stay beside/below the map');
  assert.ok(!/map-line/.test(t), 'old duplicate address block must be gone');
  // schema on the contact page only, strictly from verified facts
  assert.ok(/"@type":"LocalBusiness"/.test(t), 'LocalBusiness schema missing on contact page');
  assert.ok(/"@type":"PostalAddress"/.test(t), 'PostalAddress schema missing');
  assert.ok(/"opens":"09:00"/.test(t) && /"closes":"21:00"/.test(t), 'opening hours schema mismatch');
  assert.ok(!/aggregateRating|"review"|priceRange|"geo"/.test(t), 'unverified schema fields present');
  // trust section
  assert.ok(t.includes('Thông tin trước khi liên hệ'), 'pre-contact trust section missing');
  assert.strictEqual((t.match(/<h1/g) || []).length, 1, 'contact page must have one H1');
});
test('contact: LocalBusiness schema stays on the contact page only', () => {
  publicFiles().filter(f => f.endsWith('.html') && !f.includes(path.join('lien-he', 'index.html'))).forEach(f => {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/"@type":"LocalBusiness"/.test(t), 'LocalBusiness leaked to ' + f);
  });
});
test('privacy: contact transparency block (verified NAP) at the end', () => {
  const t = fs.readFileSync(path.join(SITE, 'chinh-sach-bao-mat', 'index.html'), 'utf8');
  ['Thuê Xe Máy Nguyễn Tú', '112 Nguyễn Văn Cừ, Bồ Đề, Long Biên, Hà Nội, Việt Nam',
   '0942 467 674', 'nguyentuantu8x@gmail.com', 'https://thuexemaynguyentu.com', '09:00 - 21:00'].forEach(s =>
    assert.ok(t.includes(s), 'privacy NAP missing: ' + s));
  const napIdx = t.indexOf('Thông tin liên hệ');
  assert.ok(napIdx > -1 && napIdx > t.indexOf('<h1'), 'NAP block must be near the end of the privacy page');
  assert.ok(!/<iframe/.test(t), 'no map iframe on privacy page');
  assert.ok(!/24\/7|giao xe miễn phí/i.test(t), 'unverified service claims on privacy page');
});

// ---------- EDITORIAL AUDIT REPORT SYNC ----------
test('audit: reports/editorial/audit-after.json matches current source (no stale report)', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 'lab-audit-check-' + process.pid + '.json');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'factory', 'editorial-audit.js'), '--out', tmp], { cwd: ROOT });
  const fresh = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.rmSync(tmp, { force: true });
  const stored = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'editorial', 'audit-after.json'), 'utf8'));
  assert.strictEqual(fresh.audited, stored.audited, 'audited count drift');
  assert.strictEqual(fresh.summary.avg_total, stored.summary.avg_total, 'stale audit avg — regenerate with: node scripts/factory/editorial-audit.js --out reports/editorial/audit-after.json');
  assert.strictEqual(fresh.summary.min_total, stored.summary.min_total, 'stale audit min');
  assert.strictEqual(fresh.summary.max_total, stored.summary.max_total, 'stale audit max');
  fresh.articles.forEach(a => {
    const s = stored.articles.find(x => x.article_id === a.article_id);
    assert.ok(s, 'article missing from stored audit: ' + a.article_id);
    assert.strictEqual(a.editorial.total, s.editorial.total, 'stale editorial score for ' + a.article_id);
    assert.deepStrictEqual(a.issues || [], s.issues || [], 'stale issues for ' + a.article_id);
    assert.strictEqual(a.word_count, s.word_count, 'stale word count for ' + a.article_id);
  });
});

// =====================================================================
// FACTORY OPERATOR — golden orchestration port (/blog pattern -> Node /lab)
// Command contract (data/state/operator-command.json), single coordinator,
// recover-first, resume-before-claim, publish gate, safe-push invariants.
// Mutating tests run inside a throwaway sandbox (os.tmpdir), never on the
// production tree.
// =====================================================================
const { execFileSync, spawnSync } = require('child_process');
const os = require('os');
// CRITICAL isolation rule: every spawned canonical script must be the SANDBOX's
// own copy (scripts resolve their repo root from __dirname/../.., NOT cwd) —
// spawning ROOT's scripts with cwd=SB would mutate the PRODUCTION tree.
const OP = (args, cwd) => { const c = cwd || ROOT; return spawnSync(process.execPath, [path.join(c, 'scripts', 'factory', 'operator.js'), ...args], { cwd: c, encoding: 'utf8' }); };
const FACT = (args, cwd) => { const c = cwd || ROOT; return spawnSync(process.execPath, [path.join(c, 'scripts', 'factory', 'factory.js'), ...args], { cwd: c, encoding: 'utf8' }); };
const wfText = f => fs.readFileSync(path.join(ROOT, '.github', 'workflows', f), 'utf8');

// sandbox: full copy of the repo with shards removed (single-csv mode) so
// tests can mutate the matrix without touching shard splitting; _drafts is
// also excluded so recover scenarios control draft presence explicitly.
const SB = path.join(os.tmpdir(), 'lab-op-sandbox-' + process.pid);
fs.rmSync(SB, { recursive: true, force: true });
fs.cpSync(ROOT, SB, { recursive: true, filter: (s) => {
  const rel = path.relative(ROOT, s);
  return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
    && !path.basename(s).startsWith('content-matrix.csv.part');
} });
function sbStatus(id, status) {
  const p = path.join(SB, 'data', 'content-matrix.csv');
  // quote-aware CSV parse (naive split(',') breaks on fields containing commas)
  const parseLine = l => { const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) { const c = l[i];
      if (q) { if (c === '"') { if (l[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } }
    out.push(cur); return out; };
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const out = [lines[0]];
  for (const l of lines.slice(1).filter(x => x.trim())) {
    const c = parseLine(l);
    if (c[0] === id) c[24] = status;
    out.push(c.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','));
  }
  fs.writeFileSync(p, out.join('\n'));
}
function sbWrite(rel, obj) { fs.writeFileSync(path.join(SB, rel), JSON.stringify(obj, null, 2)); }
function sbCmdFile(obj) { const p = path.join(SB, 'data', 'state', 'operator-command.json'); fs.writeFileSync(p, JSON.stringify(obj)); return 'data/state/operator-command.json'; }

test('operator: whitelist — invalid op rejected (no arbitrary shell)', () => {
  const r = OP(['validate', sbCmdFile({ op: 'rm -rf /' })], SB);
  assert.notStrictEqual(r.status, 0, 'invalid op must be refused');
  assert.match(r.stderr, /unsupported op/);
  const r2 = OP(['validate', sbCmdFile({ op: 'status', evil: 'injection' })], SB);
  assert.notStrictEqual(r2.status, 0, 'unknown field must be refused');
});
test('operator: count must be 1..10', () => {
  assert.notStrictEqual(OP(['validate', sbCmdFile({ op: 'prepare-next', count: 11 })], SB).status, 0, 'count 11 refused');
  assert.notStrictEqual(OP(['validate', sbCmdFile({ op: 'prepare-next', count: 0 })], SB).status, 0, 'count 0 refused');
  assert.notStrictEqual(OP(['validate', sbCmdFile({ op: 'prepare-next', count: '3; rm -rf /' })], SB).status, 0, 'non-integer refused');
  assert.strictEqual(OP(['validate', sbCmdFile({ op: 'prepare-next', count: 10 })], SB).status, 0, 'count 10 allowed');
});
test('operator: malformed article IDs rejected', () => {
  assert.notStrictEqual(OP(['validate', sbCmdFile({ op: 'publish', ids: 'A00001;rm -rf /' })], SB).status, 0, 'shell-ish ids refused');
  assert.notStrictEqual(OP(['validate', sbCmdFile({ op: 'publish', ids: ['../etc/passwd'] })], SB).status, 0, 'path id refused');
  assert.notStrictEqual(OP(['validate', sbCmdFile({ op: 'publish', ids: ['A1'] })], SB).status, 0, 'short id refused');
});
test('operator: invalid scope rejected; fast is the production default', () => {
  assert.notStrictEqual(OP(['validate', sbCmdFile({ op: 'qa', scope: 'yolo' })], SB).status, 0, 'bad scope refused');
  const r = OP(['validate', sbCmdFile({ op: 'publish', ids: 'A00002,A00003', command_id: 'cmd-1', coordinator: 'external-writer' })], SB);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /"scope":"fast"/, 'production ops default to fast scope');
  const r2 = OP(['validate', sbCmdFile({ op: 'verify', scope: 'deep' })], SB);
  assert.strictEqual(r2.status, 0);
});
test('operator: empty scope resolves to op-appropriate default (workflow $SCOPE unset)', () => {
  // The workflow exports SCOPE from the command file; commands without an
  // explicit scope export the empty string. Empty must resolve like missing:
  // verify -> full (safest), production ops -> fast — never REFUSED.
  const opMod = require(path.join(SB, 'scripts', 'factory', 'operator.js'));
  assert.strictEqual(opMod.validateCommand({ op: 'qa', ids: 'A00002', scope: '' }).scope, 'fast', 'empty scope on production op resolves to fast');
  assert.strictEqual(opMod.validateCommand({ op: 'verify', scope: '' }).scope, 'full', 'empty scope on standalone verify resolves to full');
  const r = OP(['validate', sbCmdFile({ op: 'verify', scope: '' })], SB);
  assert.strictEqual(r.status, 0, 'command-file verify with empty scope must not be refused');
  assert.match(r.stdout, /"scope":"full"/, 'resolved scope is exported to the workflow env');
});
test('operator: publish requires ids (gate is explicit)', () => {
  assert.notStrictEqual(OP(['validate', sbCmdFile({ op: 'publish' })], SB).status, 0, 'publish without ids refused');
});
test('factory: prepare-next refuses while unfinished chunk exists (resume first)', () => {
  sbStatus('A00002', 'WRITING');
  const r = FACT(['prepare-next', '3'], SB);
  assert.notStrictEqual(r.status, 0, 'must refuse to claim new work');
  assert.match(r.stderr, /unfinished chunk present/);
});
test('regression: REVIEW rows are unfinished — prepare-next refuses (repair first)', () => {
  // REVIEW (qa 80–89) must NOT count as completed: isolate it as the only
  // non-terminal state in the sandbox matrix and require the same refusal.
  sbStatus('A00002', 'PUBLISHED'); // undo the WRITING mutation from the test above
  sbStatus('A00005', 'REVIEW');
  const r = FACT(['prepare-next', '3'], SB);
  assert.notStrictEqual(r.status, 0, 'REVIEW must block claiming a new chunk');
  assert.match(r.stderr, /unfinished chunk present/);
  assert.match(r.stderr, /A00005=REVIEW/, 'refusal must name the REVIEW row');
  // restore sandbox state for the tests below
  sbStatus('A00005', 'PLANNED');
  sbStatus('A00002', 'WRITING');
});
test('regression: operator publish ids capped at CHUNK (max 10)', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => 'A' + String(i + 5).padStart(5, '0')).join(',');
  assert.notStrictEqual(OP(['validate', sbCmdFile({ op: 'publish', ids: eleven })], SB).status, 0, '11 ids must be refused');
  const ten = eleven.split(',').slice(0, 10).join(',');
  assert.strictEqual(OP(['validate', sbCmdFile({ op: 'publish', ids: ten })], SB).status, 0, '10 ids allowed');
});
test('factory: prepare-next honors count 1..10', () => {
  assert.notStrictEqual(FACT(['prepare-next', '11'], SB).status, 0, 'count>CHUNK refused');
  assert.notStrictEqual(FACT(['prepare-next', '0'], SB).status, 0, 'count<1 refused');
});
test('factory: publish refuses non-PASS rows (gate never lowers)', () => {
  sbStatus('A00003', 'RESEARCH');
  fs.mkdirSync(path.join(SB, '_drafts'), { recursive: true });
  fs.writeFileSync(path.join(SB, '_drafts', 'A00003.html'), '<h1>x</h1>');
  const before = fs.readFileSync(path.join(SB, 'data', 'content-matrix.csv'), 'utf8');
  const r = OP(['publish', '--ids', 'A00003'], SB);
  assert.notStrictEqual(r.status, 0, 'operator publish must refuse non-PASS');
  assert.match(r.stderr, /publish pre-check|not PASS/);
  const after = fs.readFileSync(path.join(SB, 'data', 'content-matrix.csv'), 'utf8');
  assert.strictEqual(before, after, 'matrix must be untouched by refused publish');
});
test('regression: qa scores REVIEW rows (REVIEW is not terminal — repair path)', () => {
  sbStatus('A00002', 'REVIEW');
  fs.mkdirSync(path.join(SB, '_drafts'), { recursive: true });
  fs.writeFileSync(path.join(SB, '_drafts', 'A00002.html'), '<h1>x</h1>');
  const r = FACT(['qa', 'A00002'], SB);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /protected/, 'REVIEW must be scorable, never protected/terminal');
  assert.match(r.stdout, /QA A00002 score=/);
  sbStatus('A00002', 'WRITING'); // restore for the tests below
});
test('regression: publish enforces CHUNK=10 (REFUSE >10 ids; no ids => at most the current chunk)', () => {
  // Disposable sandbox — this test actually publishes inside the copy only.
  const SB3 = path.join(os.tmpdir(), 'lab-chunk-sandbox-' + process.pid);
  fs.rmSync(SB3, { recursive: true, force: true });
  fs.cpSync(ROOT, SB3, { recursive: true, filter: (s) => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && !path.basename(s).startsWith('content-matrix.csv.part');
  } });
  try {
    const parseLine = l => { const out = []; let cur = '', q = false;
      for (let i = 0; i < l.length; i++) { const c = l[i];
        if (q) { if (c === '"') { if (l[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } }
      out.push(cur); return out; };
    const csvPath = path.join(SB3, 'data', 'content-matrix.csv');
    const csvSet = (id, status) => {
      const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
      const out = [lines[0]];
      for (const l of lines.slice(1).filter(x => x.trim())) {
        const c = parseLine(l);
        if (c[0] === id) c[24] = status;
        out.push(c.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','));
      }
      fs.writeFileSync(csvPath, out.join('\n'));
    };
    const ids = Array.from({ length: 11 }, (_, i) => 'A' + String(i + 5).padStart(5, '0'));
    fs.mkdirSync(path.join(SB3, '_drafts'), { recursive: true });
    ids.forEach(id => { csvSet(id, 'PASS'); fs.writeFileSync(path.join(SB3, '_drafts', id + '.html'), '<h1>x</h1>'); });
    // 1) more than CHUNK explicit ids => REFUSE (never silently publish a prefix)
    const before = fs.readFileSync(csvPath, 'utf8');
    const r = spawnSync(process.execPath, [path.join(SB3, 'scripts', 'factory', 'factory.js'), 'publish', ...ids], { cwd: SB3, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, 'publish with 11 ids must REFUSE');
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /CHUNK=10/, 'refusal must state the chunk invariant');
    assert.strictEqual(before, fs.readFileSync(csvPath, 'utf8'), 'refused publish must not touch the matrix');
    const tx = JSON.parse(fs.readFileSync(path.join(SB3, 'data', 'state', 'transaction.json'), 'utf8'));
    assert.strictEqual(tx.active, false, 'refusal must not leave a transaction open');
    const lock = JSON.parse(fs.readFileSync(path.join(SB3, 'data', 'state', 'writer-lock.json'), 'utf8'));
    assert.strictEqual(lock.locked, false, 'refusal must release the writer lock');
    // 2) no ids => publishes at most the current chunk (10), never the whole backlog
    const r2 = spawnSync(process.execPath, [path.join(SB3, 'scripts', 'factory', 'factory.js'), 'publish'], { cwd: SB3, encoding: 'utf8' });
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /PUBLISHED 10/, 'exactly one chunk (10) may publish per operation');
    const statuses = {};
    for (const l of fs.readFileSync(csvPath, 'utf8').split('\n').slice(1).filter(x => x.trim())) {
      const s = parseLine(l)[24];
      statuses[s] = (statuses[s] || 0) + 1;
    }
    assert.strictEqual(statuses.PUBLISHED, 13 + 10, 'published set grows by exactly CHUNK');
    assert.strictEqual(statuses.PASS, 1, 'leftover PASS row stays for the NEXT chunk — never swept');
  } finally { fs.rmSync(SB3, { recursive: true, force: true }); }
});
test('operator: active writer lock is respected (STOP, no force-unlock)', () => {
  sbWrite('data/state/writer-lock.json', { locked: true, holder: 'someone-else', acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() });
  const r = OP(['prepare-next', '--count', '2'], SB);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /writer lock held/);
  const lock = JSON.parse(fs.readFileSync(path.join(SB, 'data', 'state', 'writer-lock.json'), 'utf8'));
  assert.strictEqual(lock.holder, 'someone-else', 'lock must not be force-cleared');
});
test('factory: ambiguous active transaction makes recover STOP safely', () => {
  sbWrite('data/state/writer-lock.json', { locked: false, holder: null, acquired_at: null, expires_at: null });
  sbStatus('A00004', 'PASS'); // not published, no draft => unresolvable from truth
  sbWrite('data/state/transaction.json', { active: true, id: 'TX-TEST', started_at: new Date().toISOString(), operation: 'publish', articles: ['A00004'], notes: 'test' });
  const r = FACT(['recover'], SB);
  assert.notStrictEqual(r.status, 0, 'ambiguous transaction must STOP');
  assert.match(r.stderr, /RECOVER STOP/);
  const tx = JSON.parse(fs.readFileSync(path.join(SB, 'data', 'state', 'transaction.json'), 'utf8'));
  assert.strictEqual(tx.active, true, 'transaction must NOT be force-cleared');
});
test('factory: resolvable transaction recovers deterministically; clean state recovers idempotently', () => {
  // completed publish (matrix PUBLISHED + archive + public file) => roll forward, tx closed
  sbStatus('A00001', 'PUBLISHED');
  sbWrite('data/state/transaction.json', { active: true, id: 'TX-OK', started_at: new Date().toISOString(), operation: 'publish', articles: ['A00001'], notes: 'test' });
  const r = FACT(['recover'], SB);
  assert.strictEqual(r.status, 0, r.stderr);
  const tx = JSON.parse(fs.readFileSync(path.join(SB, 'data', 'state', 'transaction.json'), 'utf8'));
  assert.strictEqual(tx.active, false);
  // idempotent: second recover on clean state changes nothing
  const ckBefore = fs.readFileSync(path.join(SB, 'data', 'state', 'checkpoint.json'), 'utf8');
  const r2 = FACT(['recover'], SB);
  assert.strictEqual(r2.status, 0);
  assert.strictEqual(ckBefore, fs.readFileSync(path.join(SB, 'data', 'state', 'checkpoint.json'), 'utf8'), 'recover must be deterministic');
});
test('operator: single coordinator — concurrency group serializes, never cancels', () => {
  const y = wfText('factory-operator.yml');
  assert.match(y, /group:\s*lab-factory-production/, 'must pin one production coordinator group');
  assert.match(y, /cancel-in-progress:\s*false/, 'must never cancel an in-flight production run');
  assert.match(y, /paths:\s*\['data\/state\/operator-command\.json'\]/, 'trigger must be the command file only');
});
test('operator: verified-tree invariant — commit must equal the verified tree', () => {
  const y = wfText('factory-operator.yml');
  assert.match(y, /OPERATOR_VERIFIED_TREE/, 'must capture the verified tree');
  assert.match(y, /git write-tree/, 'must hash the staged tree');
  assert.match(y, /cây commit khác cây đã verified/, 'must refuse commit on tree drift');
});
test('operator: no force push anywhere; rebase loop always re-verifies', () => {
  for (const f of ['factory-operator.yml', 'factory-validate.yml', 'factory-capacity-validate.yml', 'ci-validate.yml']) {
    const y = wfText(f);
    assert.ok(!/--force|-f\s+git\s+push|push\s+-f/u.test(y), 'force push found in ' + f);
  }
  const y = wfText('factory-operator.yml');
  assert.match(y, /git rebase origin\/main/, 'must fetch+rebase on push race');
  assert.match(y, /OPERATOR_LOCAL_VERIFY_HEAD_POST_REBASE/, 'rebase must be followed by re-verify');
  assert.match(y, /operator\.js verify --scope "\$SCOPE"\s*\n\s*if ! git diff --quiet/, 're-verify + clean-tree check after rebase');
});
test('factory: read-only validation preserves state and truth', () => {
  // pristine copy: the shared SB matrix has drifted (scenario mutations above),
  // while capacity-check validates the FULL consistent tree (matrix ↔ checkpoint ↔ sitemap)
  const SB2 = path.join(os.tmpdir(), 'lab-ro-sandbox-' + process.pid);
  fs.rmSync(SB2, { recursive: true, force: true });
  fs.cpSync(ROOT, SB2, { recursive: true, filter: (s) => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && !path.basename(s).startsWith('content-matrix.csv.part');
  } });
  try {
    const snap = () => ['data/state/checkpoint.json', 'data/state/transaction.json', 'data/state/writer-lock.json']
      .map(p => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(SB2, p))).digest('hex')).join('.');
    const before = snap();
    assert.strictEqual(FACT(['status'], SB2).status, 0);
    assert.strictEqual(FACT(['consistency'], SB2).status, 0);
    assert.strictEqual(spawnSync(process.execPath, [path.join(SB2, 'scripts', 'factory', 'capacity-check.js')], { cwd: SB2, encoding: 'utf8' }).status, 0, 'capacity check must pass in sandbox');
    assert.strictEqual(before, snap(), 'read-only ops must not touch state');
  } finally { fs.rmSync(SB2, { recursive: true, force: true }); }
});
test('factory: build is deterministic (two runs, byte-identical tracked tree)', () => {
  const hashTree = () => {
    const list = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git' || e.name === 'site' || e.name === '_drafts' || e.name === 'data' && false) continue; const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else if (/\.(html|xml|json|js|css|txt|svg)$/i.test(e.name) && !q.includes(path.join('data', 'content-matrix.csv'))) list.push(q); } })(SB);
    list.sort();
    return require('crypto').createHash('sha256').update(list.map(p => p + ':' + require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex')).join('\n')).digest('hex');
  };
  assert.strictEqual(spawnSync(process.execPath, [path.join(SB, 'scripts', 'site', 'build-site.js')], { cwd: SB, encoding: 'utf8' }).status, 0, 'build 1');
  const h1 = hashTree();
  assert.strictEqual(spawnSync(process.execPath, [path.join(SB, 'scripts', 'site', 'build-site.js')], { cwd: SB, encoding: 'utf8' }).status, 0, 'build 2');
  const h2 = hashTree();
  assert.strictEqual(h1, h2, 'second build must not change a single byte');
});
test('factory: throughput ledger/report use real events only (no fabricated rates)', () => {
  assert.strictEqual(FACT(['reports'], SB).status, 0);
  const thr = JSON.parse(fs.readFileSync(path.join(SB, 'reports', 'factory', 'throughput.json'), 'utf8'));
  assert.ok(typeof thr.chunks_completed === 'number' && thr.chunks_completed >= 0);
  assert.strictEqual(thr.effective_articles_per_hour, null, 'no rate without ≥2 real measured events');
  assert.match(thr.note, /no backfill/i);
});
test('draft safety: _drafts is gitignored and operator ops never commit drafts', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /(^|\n)_drafts\//, 'drafts must stay out of the public root tree');
  const y = wfText('factory-operator.yml');
  assert.match(y, /KHÔNG BAO GIỜ commit/, 'workflow must document the draft boundary');
});
test('cleanup: remove operator sandbox', () => { fs.rmSync(SB, { recursive: true, force: true }); });
