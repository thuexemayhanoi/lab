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
test('config: rubric pass_min=75, review_min=70, max_repair=3', () => {
  assert.strictEqual(rubric.pass_min, 75); assert.strictEqual(rubric.review_min, 70);
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
test('published: QA score ≥ rubric pass_min and word count ≥ 1600', () => {
  published.forEach(r => {
    assert.ok(Number(r.qa_score) >= rubric.pass_min, r.article_id + ' qa=' + r.qa_score);
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
test('draft safety: drafts are committed but never published (Jekyll exclusion)', () => {
  // _drafts/ at the repo root is the canonical WRITER-side draft home: COMMITTED
  // for the push-driven factory loop, never promoted. GitHub Pages runs Jekyll —
  // with NO .nojekyll, Jekyll never publishes underscore-prefixed directories,
  // so drafts can never go public. A real leak is a re-appearing .nojekyll,
  // drafts inside the promotable staging tree, or drafts in public outputs.
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(!/(^|\n)_drafts\//.test(gi), '_drafts/ must NOT be gitignored — drafts are committed for the push-driven factory loop');
  assert.ok(!fs.existsSync(path.join(ROOT, '.nojekyll')), 'root .nojekyll must be ABSENT — Pages must run Jekyll so underscore _drafts/ is never published');
  assert.ok(!fs.existsSync(path.join(ROOT, 'site', '_drafts')), 'drafts inside site/ staging — would be promoted to the public root');
  assert.ok(publicFiles().every(f => !f.includes('_drafts')), 'drafts leaked into public root tree');
});
test('draft boundary: no .nojekyll is generated by the builder (Jekyll exclusion stays active)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'build-site.js'), 'utf8');
  assert.ok(!/writeFileSync\([^)]*nojekyll/.test(src), 'build-site.js must not WRITE .nojekyll — Pages must keep the Jekyll underscore exclusion');
  assert.ok(!/PUB_FILES=\[[^\]]*nojekyll/.test(src), 'build-site.js must not PROMOTE .nojekyll to the public root');
});
test('jekyll: public root files carry no YAML front matter (Jekyll copies them verbatim)', () => {
  assert.ok(publicFiles().every(f => !fs.readFileSync(f, 'utf8').startsWith('---\n')),
    'a public root file starts with YAML front matter — Jekyll would process it and break URLs');
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
// ---------- ACCESSIBLE DYNAMIC SEARCH (issue #3) ----------
// Homepage search mutates #search-results innerHTML for loading / error /
// no-result / result states. Screen readers must hear ONE concise, debounced
// textual announcement per settled state — never the full result list.
test('search: dynamic search announces loading, errors, and result updates accessibly (issue #3)', () => {
  const home = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  // dedicated polite live region for concise announcements
  assert.ok(/id="search-status"[^>]*role="status"[^>]*aria-live="polite"|role="status"[^>]*aria-live="polite"[^>]*id="search-status"/.test(home),
    'homepage needs a polite live status region (#search-status) for search announcements');
  // the raw result list is NOT itself a live region (AT hears the summary, not 10 cards)
  assert.ok(/<ul id="search-results"/.test(home), 'search results list missing');
  assert.ok(!/<ul id="search-results"[^>]*aria-live/.test(home),
    'raw result list must not be a live region — announce concise state text in #search-status instead');
  // visually-hidden utility exists in the canonical design system
  const css = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'style.css'), 'utf8');
  assert.ok(/\.sr-only\{[^}]*clip/.test(css), 'canonical style.css missing the visually-hidden .sr-only utility');
  const promotedCss = fs.readFileSync(path.join(SITE, 'assets', 'style.css'), 'utf8');
  assert.strictEqual(promotedCss, css, 'assets/style.css must be the verbatim promotion of scripts/site/style.css — run node scripts/site/build-site.js');
  // generated search behavior: every state announces a concise text message
  const js = fs.readFileSync(path.join(SITE, 'assets', 'search.js'), 'utf8');
  ['Đang tải chỉ mục tìm kiếm.', 'Không tải được chỉ mục tìm kiếm', 'Không tìm thấy bài đã xuất bản nào.', 'Tìm thấy '].forEach(m =>
    assert.ok(js.includes(m), 'search.js must announce state: ' + m));
  assert.ok(/getElementById\('search-status'\)/.test(js), 'search.js must target #search-status');
  assert.ok(/st\.textContent=/.test(js) && !/st\.innerHTML=/.test(js), 'announcements must be plain text (textContent), never HTML');
  // debounced + no announcement spam: one announcement per settled state
  assert.ok(/STATUS_TIMER/.test(js) && /setTimeout\(/.test(js), 'search announcements must be debounced');
  assert.ok(/st\.textContent!==msg/.test(js), 'must not re-announce identical settled states');
  // canonical generator must keep emitting the contract
  const gen = fs.readFileSync(path.join(ROOT, 'scripts', 'site', 'build-site.js'), 'utf8');
  assert.ok(gen.includes('id="search-status" class="sr-only" role="status" aria-live="polite"'), 'build-site homepage template missing the live status region');
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
test('branch-pages: root public tree exists (index.html, assets/style.css, no .nojekyll)', () => {
  assert.ok(fs.existsSync(path.join(ROOT,'index.html')), 'root index.html missing');
  assert.ok(fs.existsSync(path.join(ROOT,'assets','style.css')), 'root assets/style.css missing');
  assert.ok(!fs.existsSync(path.join(ROOT,'.nojekyll')), 'root .nojekyll must be ABSENT (Jekyll runs on Pages — underscore _drafts/ never published)');
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
test('audit: stored editorial entries match a fresh re-audit of the same articles (audit-after.json is a DEEP/FULL artifact)', () => {
  // Simple Production Mode: FAST publishes no longer regenerate
  // reports/editorial/audit-after.json (editorial-audit is a deep/full gate).
  // The freshness contract is therefore per-article: every STORED entry must
  // still match a fresh re-audit of THAT article (drift = stale report);
  // coverage lag (articles published after the last DEEP pass) is allowed and
  // refreshed by the next deep publish / node scripts/factory/editorial-audit.js --out.
  const { execFileSync } = require('child_process');
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 'lab-audit-check-' + process.pid + '.json');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'factory', 'editorial-audit.js'), '--out', tmp], { cwd: ROOT });
  const fresh = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.rmSync(tmp, { force: true });
  const stored = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', 'editorial', 'audit-after.json'), 'utf8'));
  assert.ok(Number(stored.audited) > 0, 'stored audit must exist (run editorial-audit --out once)');
  assert.ok(Number(stored.audited) <= Number(fresh.audited),
    'stored audit covers ' + stored.audited + ' but only ' + fresh.audited + ' are auditable now');
  stored.articles.forEach(s => {
    const a = fresh.articles.find(x => x.article_id === s.article_id);
    assert.ok(a, 'stored audit references an article no longer auditable: ' + s.article_id);
    assert.strictEqual(a.editorial.total, s.editorial.total, 'stale editorial score for ' + s.article_id);
    assert.deepStrictEqual(a.issues || [], s.issues || [], 'stale issues for ' + s.article_id);
    assert.strictEqual(a.word_count, s.word_count, 'stale word count for ' + s.article_id);
  });
});

// =====================================================================
// FACTORY OPERATOR — golden orchestration port (/blog pattern -> Node /lab)
// Push-driven production loop (factory-production.yml + push-selection.js):
// single coordinator, recover-first, resume-before-claim, publish gate,
// safe-push invariants. Mutating tests run inside a throwaway sandbox
// (os.tmpdir), never on the production tree.
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

test('operator: whitelist — invalid op rejected (no arbitrary shell)', () => {
  const r = OP(['rm -rf /'], SB);
  assert.notStrictEqual(r.status, 0, 'invalid op must be refused');
  assert.match(r.stderr, /unsupported op/);
  const r2 = OP(['status', '--evil', 'x'], SB);
  assert.notStrictEqual(r2.status, 0, 'unknown flag must be refused (usage)');
});
test('operator: count must be 1..10', () => {
  assert.notStrictEqual(OP(['prepare-next', '--count', '11'], SB).status, 0, 'count 11 refused');
  assert.notStrictEqual(OP(['prepare-next', '--count', '0'], SB).status, 0, 'count 0 refused');
  assert.notStrictEqual(OP(['prepare-next', '--count', '3; rm -rf /'], SB).status, 0, 'non-integer refused (strict CLI flag parse)');
  const opMod = require(path.join(SB, 'scripts', 'factory', 'operator.js'));
  assert.strictEqual(opMod.validateCommand({ op: 'prepare-next', count: 10 }).count, 10, 'count 10 allowed');
});
test('operator: malformed article IDs rejected', () => {
  assert.notStrictEqual(OP(['publish', '--ids', 'A00001;rm -rf /'], SB).status, 0, 'shell-ish ids refused');
  assert.notStrictEqual(OP(['publish', '--ids', '../etc/passwd'], SB).status, 0, 'path id refused');
  assert.notStrictEqual(OP(['publish', '--ids', 'A1'], SB).status, 0, 'short id refused');
});
test('operator: invalid scope rejected; fast is the production default', () => {
  assert.notStrictEqual(OP(['qa', '--scope', 'yolo'], SB).status, 0, 'bad scope refused');
  const opMod = require(path.join(SB, 'scripts', 'factory', 'operator.js'));
  const r = opMod.validateCommand({ op: 'publish', ids: 'A00002,A00003', command_id: 'cmd-1', coordinator: 'external-writer' });
  assert.strictEqual(r.scope, 'fast', 'production ops default to fast scope');
  const r2 = opMod.validateCommand({ op: 'verify', scope: 'deep' });
  assert.strictEqual(r2.scope, 'deep');
});
test('operator: empty scope resolves to op-appropriate default', () => {
  // Empty must resolve like missing: verify -> full (safest), production ops
  // -> fast — never REFUSED.
  const opMod = require(path.join(SB, 'scripts', 'factory', 'operator.js'));
  assert.strictEqual(opMod.validateCommand({ op: 'qa', ids: 'A00002', scope: '' }).scope, 'fast', 'empty scope on production op resolves to fast');
  assert.strictEqual(opMod.validateCommand({ op: 'verify', scope: '' }).scope, 'full', 'empty scope on standalone verify resolves to full');
});
test('operator: publish requires ids (gate is explicit)', () => {
  assert.notStrictEqual(OP(['publish'], SB).status, 0, 'publish without ids refused');
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
test('regression: operator ids capped at QUEUE_MAX/IDS_MAX (write-ahead queue ≤20; --count stays 1..10)', () => {
  // 21 ids refused — spawned child (a validateCommand refusal exits the child; never call it in-process with invalid input)
  const twentyone = Array.from({ length: 21 }, (_, i) => 'A' + String(i + 60).padStart(5, '0')).join(',');
  const r21 = OP(['publish', '--ids', twentyone], SB);
  assert.notStrictEqual(r21.status, 0, '21 ids must be refused');
  assert.match(r21.stderr, /IDS_MAX|write-ahead queue/);
  // 20 ids — exactly the TURBO write-ahead queue size — validate OK
  const twenty = twentyone.split(',').slice(0, 20).join(',');
  const opMod = require(path.join(SB, 'scripts', 'factory', 'operator.js'));
  assert.strictEqual(opMod.validateCommand({ op: 'publish', ids: twenty }).ids.length, 20, '20 ids allowed (QUEUE_MAX=20)');
  // legacy --count path keeps the small CHUNK cap
  assert.notStrictEqual(OP(['prepare-next', '--count', '11'], SB).status, 0, 'count 11 still refused (legacy path)');
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
    const csvSetScore = (id, status, score) => {
      const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
      const out = [lines[0]];
      for (const l of lines.slice(1).filter(x => x.trim())) {
        const c = parseLine(l);
        if (c[0] === id) { c[24] = status; c[26] = String(score); }
        out.push(c.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','));
      }
      fs.writeFileSync(csvPath, out.join('\n'));
    };
    const ids = Array.from({ length: 11 }, (_, i) => 'A' + String(i + 15).padStart(5, '0'));
    fs.mkdirSync(path.join(SB3, '_drafts'), { recursive: true });
    const draftSha3 = require('crypto').createHash('sha256').update('<h1>x</h1>').digest('hex');
    fs.mkdirSync(path.join(SB3, 'data', 'qa'), { recursive: true });
    ids.forEach(id => { csvSetScore(id, 'PASS', 100); fs.writeFileSync(path.join(SB3, '_drafts', id + '.html'), '<h1>x</h1>');
      // rows A00015.. are PUBLISHED in the real repo — drop the copied real
      // archive so the AMBIGUOUS publish gate never fires on the sandbox
      fs.rmSync(path.join(SB3, 'data', 'published', id + '.html'), { force: true });
      fs.writeFileSync(path.join(SB3, 'data', 'qa', id + '.json'), JSON.stringify({ article_id: id, score: 100, words: 1, result: 'PASS', fails: [], draft_sha256: draftSha3, matrix_status_after: 'PASS' })); });
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
    const countStatuses3 = () => { const s = {};
      for (const l of fs.readFileSync(csvPath, 'utf8').split('\n').slice(1).filter(x => x.trim())) {
        const st = parseLine(l)[24]; s[st] = (s[st] || 0) + 1; }
      return s; };
    const before2 = countStatuses3();
    const r2 = spawnSync(process.execPath, [path.join(SB3, 'scripts', 'factory', 'factory.js'), 'publish'], { cwd: SB3, encoding: 'utf8' });
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /PUBLISHED 10/, 'exactly one chunk (10) may publish per operation');
    const after2 = countStatuses3();
    assert.strictEqual(after2.PUBLISHED, (before2.PUBLISHED || 0) + 10, 'published set grows by exactly CHUNK');
    assert.strictEqual(after2.PASS, (before2.PASS || 0) - 10, 'leftover PASS row stays for the NEXT chunk — never swept');
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
  const y = wfText('factory-production.yml');
  assert.match(y, /group:\s*lab-factory-production/, 'must pin one production coordinator group');
  assert.match(y, /cancel-in-progress:\s*false/, 'must never cancel an in-flight production run');
  // Paths filter đã bỏ (workflow đa-trigger + paths filter sinh run 0-job đỏ);
  // an toàn giữ nguyên: push-gate phát hiện push đụng _drafts/** (outputs.drafts).
  assert.doesNotMatch(y, /paths:\s*\['_drafts/, 'no paths filter — multi-trigger workflow must not produce 0-job failure runs');
  assert.match(y, /push-gate/, 'push-gate guard job must exist');
  assert.match(y, /outputs\.drafts/, 'push-gate must export the drafts signal');
});
test('operator: verified-tree invariant — commit must equal the verified tree', () => {
  const y = wfText('factory-production.yml');
  assert.match(y, /OPERATOR_VERIFIED_TREE/, 'must capture the verified tree');
  assert.match(y, /git write-tree/, 'must hash the staged tree');
  assert.match(y, /cây commit khác cây đã verified/, 'must refuse commit on tree drift');
});
test('operator: no force push anywhere; rebase loop always re-verifies', () => {
  for (const f of fs.readdirSync(path.join(ROOT, '.github', 'workflows'))) {
    const y = wfText(f);
    assert.ok(!/--force|-f\s+git\s+push|push\s+-f/u.test(y), 'force push found in ' + f);
  }
  const y = wfText('factory-production.yml');
  assert.match(y, /git rebase origin\/main/, 'must fetch+rebase on push race');
  assert.match(y, /OPERATOR_LOCAL_VERIFY_HEAD_POST_REBASE/, 'rebase must be followed by re-verify');
  assert.match(y, /operator\.js verify --scope fast\s*\n\s*if ! git diff --quiet/, 're-verify + clean-tree check after rebase');
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
  // no fabricated rates: the report must stay null while fewer than 2 real
  // measured publish events exist, and expose the REAL measured rate (a
  // positive number) once the ledger actually holds >= 2 of them.
  if ((thr.publish_operations || 0) < 2) {
    assert.strictEqual(thr.effective_articles_per_hour, null, 'no rate without ≥2 real measured events');
  } else {
    assert.ok(Number.isFinite(thr.effective_articles_per_hour) && thr.effective_articles_per_hour > 0,
      'rate from ≥2 real measured publish events must be a positive number');
  }
  assert.match(thr.note, /no backfill/i);
});
test('draft safety: _drafts is committed (not gitignored) and Pages never publishes it', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.ok(!/(^|\n)_drafts\//.test(gi), '_drafts/ must NOT be gitignored — the push-driven factory loop commits drafts');
  assert.ok(!fs.existsSync(path.join(ROOT, '.nojekyll')), '.nojekyll must be ABSENT so Jekyll never publishes _drafts/');
  const y = wfText('factory-production.yml');
  assert.doesNotMatch(y, /paths:\s*\['_drafts/, 'no paths filter — it creates 0-job failure runs on multi-trigger workflows');
  assert.match(y, /push-gate[\s\S]*?outputs:\s*\n\s*drafts:/, 'push-gate must detect committed _drafts pushes and export outputs.drafts');
  assert.match(y, /push-selection\.js/, 'draft ids are derived deterministically from the push');
});
// =====================================================================
// PUSH-DRIVEN PRODUCTION — push-selection.js (EXACT ids derived from the
// pushed _drafts/ files; /blog & /vanchinh model) + prepare-next --ids
// (exact claims). The writer pushes drafts; the workflow derives ids from
// the push — NEVER random PLANNED rows, NEVER a PUBLISHED row.
// =====================================================================
const SBP = path.join(os.tmpdir(), 'lab-pushsel-sandbox-' + process.pid);
fs.rmSync(SBP, { recursive: true, force: true });
fs.cpSync(ROOT, SBP, { recursive: true, filter: (s) => {
  const rel = path.relative(ROOT, s);
  return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
    && !path.basename(s).startsWith('content-matrix.csv.part');
} });
const PUSHSEL = (args, cwd) => { const c = cwd || SBP;
  return spawnSync(process.execPath, [path.join(c, 'scripts', 'factory', 'push-selection.js'), ...args], { cwd: c, encoding: 'utf8' }); };
function sbpStatus(id, status) {
  const p = path.join(SBP, 'data', 'content-matrix.csv');
  const parseLineSbp = l => { const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) { const c = l[i];
      if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } }
    out.push(cur); return out; };
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const out = [lines[0]];
  for (const l of lines.slice(1).filter(x => x.trim())) {
    const c = parseLineSbp(l);
    if (c[0] === id) c[24] = status;
    out.push(c.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','));
  }
  fs.writeFileSync(p, out.join('\n'));
}
function sbpControl(obj) { fs.writeFileSync(path.join(SBP, 'data', 'state', 'production-control.json'), JSON.stringify(obj, null, 2) + '\n'); }
function sbpDraft(id) {
  fs.mkdirSync(path.join(SBP, '_drafts'), { recursive: true });
  fs.writeFileSync(path.join(SBP, '_drafts', id + '.html'), '<!doctype html><html><body><h1>' + id + '</h1></body></html>');
  fs.writeFileSync(path.join(SBP, '_drafts', id + '.body.html'), '<h2>' + id + ' body</h2>');
}
function sbpPacket(id) {
  fs.mkdirSync(path.join(SBP, 'data', 'research'), { recursive: true });
  fs.writeFileSync(path.join(SBP, 'data', 'research', id + '.json'), JSON.stringify({
    article_id: id, primary_keyword: 'kw ' + id, search_intent: 'informational',
    research_date: '2026-10-01', questions_found: ['q1'], official_sources: [], unique_angle: 'angle'
  }));
}
function sbpSel(added, modified) {
  const a = path.join(SBP, 'added.txt'), m = path.join(SBP, 'modified.txt');
  fs.writeFileSync(a, added.join('\n') + (added.length ? '\n' : ''));
  fs.writeFileSync(m, modified.join('\n') + (modified.length ? '\n' : ''));
  return PUSHSEL(['--added', a, '--modified', m]);
}
const selJson = r => JSON.parse(r.stdout.split('\n')[0]);

test('push-selection: skip — no _drafts file in the push (tooling commit)', () => {
  sbpControl({ enabled: true, chunk_size: 2, queue_min: 2, queue_max: 20 });
  const r = sbpSel(['scripts/factory/push-selection.js'], ['README.md']);
  assert.strictEqual(r.status, 0, r.stderr);
  const sel = selJson(r);
  assert.strictEqual(sel.proceed, false);
  assert.strictEqual(sel.mode, 'skip');
  assert.strictEqual(sel.refuse, null);
});
// TURBO write-ahead queue world: production truth moves forward over time
// (A00015.. are PUBLISHED in the real matrix), so the queue tests pin their
// own fixture zone — rows A00015..A00040 forced PUBLISHED, then the given
// ids PLANNED. Every test rebuilds its world (no cross-test assumptions).
function sbpWorld(planned) {
  for (let i = 15; i <= 40; i++) sbpStatus('A' + String(i).padStart(5, '0'), 'PUBLISHED');
  (planned || []).forEach(id => sbpStatus(id, 'PLANNED'));
  sbpControl({ enabled: true, chunk_size: 2, queue_min: 2, queue_max: 20 });
}
function sbpQueue(ids) { // drafts + packets for every id; returns the added-path list
  ids.forEach(id => { sbpDraft(id); sbpPacket(id); });
  const paths = [];
  ids.forEach(id => { paths.push('_drafts/' + id + '.html', '_drafts/' + id + '.body.html'); });
  return paths;
}
test('push-selection: TURBO queue — pushed ids are sorted by matrix order and split into pairs', () => {
  sbpWorld(['A00015', 'A00016', 'A00017', 'A00018']);
  const paths = sbpQueue(['A00018', 'A00017', 'A00016', 'A00015']); // deliberately out of push order
  const r = sbpSel(paths, []);
  assert.strictEqual(r.status, 0, r.stderr);
  const sel = selJson(r);
  assert.strictEqual(sel.mode, 'new');
  assert.strictEqual(sel.proceed, true);
  assert.deepStrictEqual(sel.claim_ids, ['A00015', 'A00016', 'A00017', 'A00018'],
    'claim order = repository/matrix order, never the push order');
  assert.deepStrictEqual(sel.qa_ids, ['A00015', 'A00016', 'A00017', 'A00018']);
  assert.deepStrictEqual(sel.pairs, [['A00015', 'A00016'], ['A00017', 'A00018']],
    'the write-ahead queue is consumed as deterministic sequential pairs of 2');
});
test('push-selection: TURBO queue — 20 ids (queue_max) in ONE writer push => 10 pairs', () => {
  const ids = Array.from({ length: 20 }, (_, i) => 'A' + String(i + 15).padStart(5, '0'));
  sbpWorld(ids);
  const r = sbpSel(sbpQueue(ids), []);
  assert.strictEqual(r.status, 0, r.stderr);
  const sel = selJson(r);
  assert.strictEqual(sel.claim_ids.length, 20);
  assert.strictEqual(sel.pairs.length, 10, 'one queue push => 10 sequential pairs inside ONE production run');
  assert.deepStrictEqual(sel.pairs[9], ['A00033', 'A00034']);
});
test('push-selection: refuse — 21 ids > queue_max 20 (split the push)', () => {
  const ids = Array.from({ length: 21 }, (_, i) => 'A' + String(i + 15).padStart(5, '0'));
  sbpWorld(ids);
  const r = sbpSel(sbpQueue(ids), []);
  assert.strictEqual(r.status, 3, 'refuse must exit 3');
  assert.match(selJson(r).refuse, /queue_max 20/);
});
test('push-selection: refuse — 1 id < queue_min 2 (a queue push carries 2..20 consecutive PLANNED ids)', () => {
  sbpWorld(['A00015', 'A00016']);
  sbpQueue(['A00015']);
  const r = sbpSel(['_drafts/A00015.html', '_drafts/A00015.body.html'], []);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /queue_min 2/);
});
test('push-selection: refuse — queue must start at the FIRST PLANNED row (skip against matrix order)', () => {
  sbpWorld(['A00015', 'A00016', 'A00017']);
  sbpQueue(['A00016', 'A00017']);
  const r = sbpSel(['_drafts/A00016.html', '_drafts/A00017.html'], []);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /first PLANNED row A00015/);
});
test('push-selection: refuse — hole inside the queue span (unclaimed PLANNED row)', () => {
  sbpWorld(['A00015', 'A00016', 'A00017', 'A00018']);
  sbpQueue(['A00015', 'A00017', 'A00018']);
  const r = sbpSel(['_drafts/A00015.html', '_drafts/A00017.html', '_drafts/A00018.html'], []);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /skips PLANNED row A00016/);
});
test('push-selection: queue after a PUBLISHED prefix is legal (finished rows skip over)', () => {
  sbpWorld(['A00017', 'A00018']); // A00015/A00016 stay PUBLISHED inside the span
  const r = sbpSel(sbpQueue(['A00017', 'A00018']), []);
  assert.strictEqual(r.status, 0, r.stderr);
  const sel = selJson(r);
  assert.strictEqual(sel.mode, 'new');
  assert.deepStrictEqual(sel.claim_ids, ['A00017', 'A00018']);
});
test('push-selection: refuse — unknown id never claimed (fail-closed, exit 3)', () => {
  sbpDraft('A99999');
  const r = sbpSel(['_drafts/A99999.html'], []);
  assert.strictEqual(r.status, 3, 'refuse must exit 3');
  assert.match(selJson(r).refuse || '', /A99999 not in matrix/);
  assert.match(r.stderr, /REFUSED/);
});
test('push-selection: refuse — PUBLISHED rows are never re-published via push', () => {
  sbpWorld([]); // A00015 is PUBLISHED in this world
  sbpDraft('A00015');
  const r = sbpSel(['_drafts/A00015.html'], []);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /PUBLISHED/);
});
test('push-selection: refuse — BLOCKED rows are protected', () => {
  sbpWorld(['A00015', 'A00016']);
  sbpStatus('A00016', 'BLOCKED');
  sbpQueue(['A00015', 'A00016']);
  const r = sbpSel(['_drafts/A00015.html', '_drafts/A00016.html'], []);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /BLOCKED/);
});
test('push-selection: refuse — mixed new + repair push (finish the open chunk first)', () => {
  sbpWorld(['A00015', 'A00016', 'A00017']);
  sbpStatus('A00017', 'REPAIR');
  sbpQueue(['A00015', 'A00017']);
  const r = sbpSel(['_drafts/A00015.html'], ['_drafts/A00017.html']);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /new .* and repair/);
});
test('push-selection: refuse — body-only push needs the wrapped draft', () => {
  sbpWorld(['A00021', 'A00022']);
  // earlier tests may have left drafts/packets behind — this test must control
  // exactly which artifacts exist for its ids
  ['A00021', 'A00022'].forEach(id => {
    fs.rmSync(path.join(SBP, '_drafts', id + '.html'), { force: true });
    fs.rmSync(path.join(SBP, 'data', 'research', id + '.json'), { force: true });
  });
  fs.mkdirSync(path.join(SBP, '_drafts'), { recursive: true });
  fs.writeFileSync(path.join(SBP, '_drafts', 'A00021.body.html'), '<h2>body</h2>');
  fs.writeFileSync(path.join(SBP, '_drafts', 'A00022.body.html'), '<h2>body</h2>');
  const r = sbpSel(['_drafts/A00021.body.html', '_drafts/A00022.body.html'], []);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /wrapped draft/);
});
test('push-selection: refuse — stray _drafts filename (only A#####.html|.body.html)', () => {
  fs.mkdirSync(path.join(SBP, '_drafts'), { recursive: true });
  fs.writeFileSync(path.join(SBP, '_drafts', 'notes.txt'), 'x');
  const r = sbpSel(['_drafts/notes.txt'], []);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /A#####/);
  fs.rmSync(path.join(SBP, '_drafts', 'notes.txt'), { force: true });
});
test('push-selection: paused — production-control disabled stops NEW pushes cleanly (exit 0)', () => {
  sbpWorld(['A00018', 'A00019']);
  sbpControl({ enabled: false, chunk_size: 2, queue_min: 2, queue_max: 20 });
  const r = sbpSel(sbpQueue(['A00018', 'A00019']), []);
  assert.strictEqual(r.status, 0, r.stderr);
  const sel = selJson(r);
  assert.strictEqual(sel.mode, 'paused');
  assert.strictEqual(sel.proceed, false);
  assert.deepStrictEqual(sel.claim_ids, []);
  assert.strictEqual(sel.control_enabled, false);
});
test('push-selection: repair — push of a WRITING draft targets qa only (no new claims)', () => {
  sbpWorld([]);
  sbpStatus('A00019', 'WRITING');
  sbpDraft('A00019');
  const r = sbpSel([], ['_drafts/A00019.html']);
  assert.strictEqual(r.status, 0, r.stderr);
  const sel = selJson(r);
  assert.strictEqual(sel.mode, 'repair');
  assert.strictEqual(sel.proceed, true);
  assert.deepStrictEqual(sel.claim_ids, []);
  assert.deepStrictEqual(sel.qa_ids, ['A00019']);
});
test('push-selection: repair proceeds even when production-control is disabled', () => {
  sbpWorld([]);
  sbpControl({ enabled: false, chunk_size: 2, queue_min: 2, queue_max: 20 });
  sbpStatus('A00019', 'REPAIR');
  sbpDraft('A00019');
  const r = sbpSel([], ['_drafts/A00019.html']);
  assert.strictEqual(r.status, 0, r.stderr);
  const sel = selJson(r);
  assert.strictEqual(sel.mode, 'repair');
  assert.strictEqual(sel.proceed, true, 'repair of open work stays allowed while paused');
});
test('push-selection: repair of a RESEARCH row needs a parseable research packet', () => {
  sbpWorld([]);
  sbpStatus('A00019', 'RESEARCH');
  sbpDraft('A00019');
  fs.rmSync(path.join(SBP, 'data', 'research', 'A00019.json'), { force: true }); // earlier tests may have left a packet
  const rMissing = sbpSel([], ['_drafts/A00019.html']);
  assert.strictEqual(rMissing.status, 3);
  assert.match(selJson(rMissing).refuse, /research packet/);
  sbpPacket('A00019');
  const rOk = sbpSel([], ['_drafts/A00019.html']);
  assert.strictEqual(rOk.status, 0, rOk.stderr);
  assert.strictEqual(selJson(rOk).mode, 'repair');
});
test('push-selection: refuse — repair push > chunk_size 2 ids (repair stays pair-sized)', () => {
  sbpWorld([]);
  sbpStatus('A00019', 'REVIEW'); sbpStatus('A00020', 'REVIEW'); sbpStatus('A00021', 'REVIEW');
  sbpDraft('A00019'); sbpDraft('A00020'); sbpDraft('A00021');
  const r = sbpSel(['_drafts/A00019.html', '_drafts/A00020.html', '_drafts/A00021.html'], []);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /chunk_size 2/);
});
test('push-selection: new push without a research packet is refused (research BEFORE write)', () => {
  sbpWorld(['A00020', 'A00021']);
  sbpDraft('A00020'); sbpDraft('A00021');
  // earlier tests may have left packets behind — the queue ids must have NONE
  fs.rmSync(path.join(SBP, 'data', 'research', 'A00020.json'), { force: true });
  fs.rmSync(path.join(SBP, 'data', 'research', 'A00021.json'), { force: true });
  const r = sbpSel(['_drafts/A00020.html', '_drafts/A00021.html'], []);
  assert.strictEqual(r.status, 3);
  assert.match(selJson(r).refuse, /research packet/);
});
test('push-selection: contract — shards-first matrix read; refuse exits 3', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'factory', 'push-selection.js'), 'utf8');
  assert.ok(src.includes('content-matrix\\.csv\\.part'), 'must read the canonical shards (a clean checkout has no assembled CSV)');
  assert.match(src, /process\.exit\(3\)/, 'refuse must exit 3 (fail-closed)');
});
test('push-driven: production-control contract (enabled; chunk 1..10; queue 2..20)', () => {
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state', 'production-control.json'), 'utf8'));
  assert.strictEqual(c.enabled, true, 'production must be enabled');
  assert.ok(Number.isInteger(c.chunk_size) && c.chunk_size >= 1 && c.chunk_size <= 10, 'chunk_size must be an integer 1..10');
  assert.ok(Number.isInteger(c.queue_min) && c.queue_min >= 2, 'queue_min must be an integer >= 2 (pair minimum)');
  assert.ok(Number.isInteger(c.queue_max) && c.queue_max <= 20, 'queue_max must be an integer <= 20 (write-ahead buffer cap)');
  assert.ok(c.queue_min <= c.queue_max, 'queue_min must not exceed queue_max');
});
test('prepare-next --ids: ONE write-ahead queue claim of consecutive PLANNED rows (push-driven)', () => {
  sbpWorld(['A00015', 'A00016', 'A00017']);
  const r = FACT(['prepare-next', '--ids', 'A00015,A00016,A00017'], SBP);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREPARED 3/);
  const preparedLine = r.stdout.split('\n').find(l => l.startsWith('PREPARED'));
  assert.ok(preparedLine, 'PREPARED line must exist');
  assert.match(preparedLine, /A00015/);
  assert.match(preparedLine, /A00016/);
  assert.match(preparedLine, /A00017/);
  assert.strictEqual(preparedLine.includes('A00018'), false, 'must not claim anything beyond the exact queue ids');
});
test('prepare-next --ids: refuses while an unfinished queue exists (resume first)', () => {
  const r = FACT(['prepare-next', '--ids', 'A00018'], SBP); // A00015..A00017 are now RESEARCH (claimed, unfinished)
  assert.notStrictEqual(r.status, 0, 'must refuse to claim new work');
  assert.match(r.stderr, /unfinished chunk present/);
});
// fresh sandbox for the exact-claim refusal matrix (no unfinished rows)
const SBP2 = path.join(os.tmpdir(), 'lab-pushsel2-sandbox-' + process.pid);
fs.rmSync(SBP2, { recursive: true, force: true });
fs.cpSync(ROOT, SBP2, { recursive: true, filter: (s) => {
  const rel = path.relative(ROOT, s);
  return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
    && !path.basename(s).startsWith('content-matrix.csv.part');
} });
function csvSetStatus(csvPath, id, status) {
  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  const out = [lines[0]];
  for (const l of lines.slice(1).filter(x => x.trim())) {
    const c = parseLine4(l);
    if (c[0] === id) c[24] = status;
    out.push(c.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','));
  }
  fs.writeFileSync(csvPath, out.join('\n'));
}
test('prepare-next --ids: non-PLANNED / unknown / malformed / duplicate / >QUEUE_MAX refused', () => {
  const rPub = FACT(['prepare-next', '--ids', 'A00001'], SBP2); // A00001 is PUBLISHED
  assert.notStrictEqual(rPub.status, 0, 'PUBLISHED row must be refused');
  assert.match(rPub.stderr, /PUBLISHED/);
  const rUnknown = FACT(['prepare-next', '--ids', 'A99999'], SBP2);
  assert.notStrictEqual(rUnknown.status, 0, 'unknown id must be refused');
  assert.match(rUnknown.stderr, /unknown id/);
  assert.notStrictEqual(FACT(['prepare-next', '--ids', 'a1'], SBP2).status, 0, 'malformed id must be refused');
  assert.notStrictEqual(FACT(['prepare-next', '--ids', 'A00015,A00015'], SBP2).status, 0, 'duplicate id must be refused');
  // > QUEUE_MAX (20) ids refused up front — the write-ahead queue cap
  const twentyOne = Array.from({ length: 21 }, (_, i) => 'A' + String(i + 1).padStart(5, '0')).join(',');
  const rQ = FACT(['prepare-next', '--ids', twentyOne], SBP2);
  assert.notStrictEqual(rQ.status, 0, '>QUEUE_MAX ids must be refused');
  assert.match(rQ.stderr, /QUEUE_MAX/);
});
test('operator: prepare-next --ids passthrough (validate + execute path)', () => {
  assert.notStrictEqual(OP(['prepare-next', '--ids', 'A00015,A00016', '--count', '2'], SBP2).status, 0, 'ids+count must be refused (mutually exclusive)');
  // full operator path: preflight -> ONE queue claim -> reports -> scoped fast verify
  csvSetStatus(path.join(SBP2, 'data', 'content-matrix.csv'), 'A00015', 'PLANNED');
  csvSetStatus(path.join(SBP2, 'data', 'content-matrix.csv'), 'A00016', 'PLANNED');
  const r = OP(['prepare-next', '--ids', 'A00015,A00016', '--scope', 'fast'], SBP2);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PREPARED 2/);
  assert.match(r.stdout, /VERIFY PASS \(scope=fast\)/);
});
test('prepare-next --ids: a full 20-id write-ahead queue claim (QUEUE_MAX)', () => {
  // clear the rows claimed by the passthrough test (finished again), then
  // claim a full 20-id queue in ONE deterministic call
  const csv2 = path.join(SBP2, 'data', 'content-matrix.csv');
  csvSetStatus(csv2, 'A00015', 'PUBLISHED');
  csvSetStatus(csv2, 'A00016', 'PUBLISHED');
  const ids = Array.from({ length: 20 }, (_, i) => 'A' + String(i + 41).padStart(5, '0')); // A00041..A00060
  ids.forEach(id => csvSetStatus(csv2, id, 'PLANNED'));
  const r = FACT(['prepare-next', '--ids', ids.join(',')], SBP2);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /PREPARED 20/);
});

// =====================================================================
// FACTORY HARDENING — QA hash-bound publish gate, claim grounding gate,
// atomic two-phase publish (stage/commit/rollback + fault injection), and
// the contiguous-prefix last_completed_id contract.
// =====================================================================
const SB4 = path.join(os.tmpdir(), 'lab-harden-sandbox-' + process.pid);
fs.rmSync(SB4, { recursive: true, force: true });
fs.cpSync(ROOT, SB4, { recursive: true, filter: (s) => {
  const rel = path.relative(ROOT, s);
  return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
    && !path.basename(s).startsWith('content-matrix.csv.part');
} });
const fact4 = require(path.join(SB4, 'scripts', 'factory', 'factory.js'));
const csvPath4 = path.join(SB4, 'data', 'content-matrix.csv');
const parseLine4 = l => { const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) { const c = l[i];
    if (q) { if (c === '"') { if (l[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } }
  out.push(cur); return out; };
function setRow4(id, fields) {
  const lines = fs.readFileSync(csvPath4, 'utf8').split('\n');
  const out = [lines[0]];
  for (const l of lines.slice(1).filter(x => x.trim())) {
    const c = parseLine4(l);
    if (c[0] === id) { if (fields.status !== undefined) c[24] = fields.status; if (fields.qa_score !== undefined) c[26] = String(fields.qa_score); }
    out.push(c.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','));
  }
  fs.writeFileSync(csvPath4, out.join('\n'));
}
const status4 = id => { for (const l of fs.readFileSync(csvPath4, 'utf8').split('\n').slice(1).filter(x => x.trim())) { const c = parseLine4(l); if (c[0] === id) return { status: c[24], qa_score: c[26] }; } return null; };
const sha4 = s => require('crypto').createHash('sha256').update(s).digest('hex');
const draft4 = (id, html) => { fs.mkdirSync(path.join(SB4, '_drafts'), { recursive: true }); fs.writeFileSync(path.join(SB4, '_drafts', id + '.html'), html); };
const evidence4 = (id, ev) => { fs.mkdirSync(path.join(SB4, 'data', 'qa'), { recursive: true }); fs.writeFileSync(path.join(SB4, 'data', 'qa', id + '.json'), JSON.stringify(ev)); };
const ready4 = (id, html) => { setRow4(id, { status: 'PASS', qa_score: 100 }); draft4(id, html);
  // the sandbox copies the real repo (id may already be PUBLISHED there) —
  // drop the stale real archive so the AMBIGUOUS publish gate never fires
  fs.rmSync(path.join(SB4, 'data', 'published', id + '.html'), { force: true });
  evidence4(id, { article_id: id, score: 100, words: 1, result: 'PASS', fails: [], draft_sha256: sha4(html), matrix_status_after: 'PASS' }); };
const tx4 = () => JSON.parse(fs.readFileSync(path.join(SB4, 'data', 'state', 'transaction.json'), 'utf8'));
const lock4 = () => JSON.parse(fs.readFileSync(path.join(SB4, 'data', 'state', 'writer-lock.json'), 'utf8'));
const expireLock4 = () => fs.writeFileSync(path.join(SB4, 'data', 'state', 'writer-lock.json'), JSON.stringify({ locked: true, holder: 'publish', acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() - 1000).toISOString() }));
const clean4 = (ctx) => { assert.strictEqual(tx4().active, false, ctx + ': tx must be inactive'); assert.strictEqual(lock4().locked, false, ctx + ': writer lock must be free'); };
// build-site restores PUBLISHED pages from the durable archive and REQUIRES the
// canonical site shell (header.site-head / footer.site-foot) — any draft that
// will go through a BUILD must carry it.
const shellHtml4 = id => '<header class="site-head"><nav class="menu"><a href="/lab/">Trang chủ</a></nav></header>\n<main><h1>Bài kiểm thử ' + id + '</h1><p>Nội dung kiểm thử deterministic cho quy trình atomic publish hai pha của bài ' + id + ': ghi nhận stage, verify và commit trong cùng một giao dịch, đảm bảo mọi bước đều được xác minh trước khi công bố.</p></main>\n<footer class="site-foot"><p>Chân trang kiểm thử.</p></footer>';

test('hardening: QA-hash publish gate allows an exact PASS + hash-bound draft', () => {
  ready4('A00015', shellHtml4('A00015'));
  const r = FACT(['publish', 'A00015'], SB4);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /PUBLISHED 1: A00015/);
  assert.strictEqual(status4('A00015').status, 'PUBLISHED');
  assert.ok(!fs.existsSync(path.join(SB4, '_drafts', 'A00015.html')), 'draft removed only at commit');
  assert.ok(fs.existsSync(path.join(SB4, 'data', 'published', 'A00015.html')), 'durable archive written');
  const ledger = JSON.parse(fs.readFileSync(path.join(SB4, 'data', 'state', 'throughput-ledger.json'), 'utf8'));
  assert.ok(ledger.events.some(e => e.op === 'publish' && (e.ids || []).includes('A00015')), 'ledger records the real publish event');
  clean4('gate-allow');
});
test('hardening: draft edited by 1 byte after QA => publish REFUSE (hash mismatch)', () => {
  ready4('A00016', '<h1>ok</h1>');
  fs.appendFileSync(path.join(SB4, '_drafts', 'A00016.html'), 'x'); // exactly 1 byte
  const r = FACT(['publish', 'A00016'], SB4);
  assert.notStrictEqual(r.status, 0, 'stale QA hash must REFUSE');
  assert.match(r.stderr, /QA_EVIDENCE_STALE|DRAFT_CHANGED_AFTER_QA/);
  assert.strictEqual(status4('A00016').status, 'PASS', 'matrix untouched by refusal');
  assert.ok(fs.existsSync(path.join(SB4, '_drafts', 'A00016.html')), 'draft intact after refusal');
  assert.ok(!fs.existsSync(path.join(SB4, 'data', 'published', 'A00016.html')), 'no archive from a refused publish');
  clean4('hash-mismatch');
});
test('hardening: missing QA evidence => publish REFUSE', () => {
  ready4('A00017', '<h1>ok</h1>');
  fs.rmSync(path.join(SB4, 'data', 'qa', 'A00017.json'));
  const r = FACT(['publish', 'A00017'], SB4);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /QA_EVIDENCE_MISSING/);
  assert.strictEqual(status4('A00017').status, 'PASS');
  clean4('evidence-missing');
});
test('hardening: QA evidence result != PASS => publish REFUSE', () => {
  ready4('A00018', '<h1>ok</h1>');
  evidence4('A00018', { article_id: 'A00018', score: 100, words: 1, result: 'REVIEW', fails: [], draft_sha256: sha4('<h1>ok</h1>'), matrix_status_after: 'PASS' });
  const r = FACT(['publish', 'A00018'], SB4);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /QA_EVIDENCE_NOT_PASS/);
  clean4('evidence-not-pass');
});
test('hardening: QA evidence score below rubric => publish REFUSE', () => {
  ready4('A00019', '<h1>ok</h1>');
  evidence4('A00019', { article_id: 'A00019', score: 65, words: 1, result: 'PASS', fails: [], draft_sha256: sha4('<h1>ok</h1>'), matrix_status_after: 'PASS' });
  const r = FACT(['publish', 'A00019'], SB4);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /QA_EVIDENCE_BELOW_THRESHOLD/);
  clean4('evidence-below-threshold');
});
test('hardening: matrix qa_score below rubric => publish REFUSE (evidence alone is not enough)', () => {
  ready4('A00020', '<h1>ok</h1>');
  setRow4('A00020', { status: 'PASS', qa_score: 65 });
  const r = FACT(['publish', 'A00020'], SB4);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /matrix qa_score/);
  clean4('matrix-qa-score');
});
test('hardening: grounding gate — ungrounded VND claim => publish REFUSE', () => {
  // A00075 is far past the published prefix and has NO research packet in the
  // repo — the grounding refusal can only be attributed to the draft claims
  ready4('A00075', '<header class="site-head"><nav class="menu"><a href="/lab/">Trang chủ</a></nav></header>\n<main><h1>ok</h1><p>Giá xe số khoảng 100.000đ/ngày tại đây.</p></main>\n<footer class="site-foot"><p>Chân trang.</p></footer>');
  const r = FACT(['publish', 'A00075'], SB4);
  assert.notStrictEqual(r.status, 0, 'ungrounded quantitative claim must REFUSE');
  assert.match(r.stderr, /GROUNDING_FAIL/);
  assert.strictEqual(status4('A00075').status, 'PASS', 'matrix untouched by grounding refusal');
  assert.ok(fs.existsSync(path.join(SB4, '_drafts', 'A00075.html')), 'draft intact after grounding refusal');
  clean4('grounding-refuse');
});
test('hardening: grounding gate — real claim_evidence => the same publish passes', () => {
  // backfill genuine claim_evidence (verified source quote) for the draft above
  fs.mkdirSync(path.join(SB4, 'data', 'research'), { recursive: true });
  fs.writeFileSync(path.join(SB4, 'data', 'research', 'A00075.json'), JSON.stringify({ article_id: 'A00075', sources: [], claim_evidence: [{ claim: 'Giá xe số khoảng 100.000đ/ngày', source_url: 'https://example.com/bang-gia', source_domain: 'example.com', date_accessed: '2026-09-29', claim_supported: 'Bảng giá công khai: xe số 100.000đ/ngày' }] }));
  const r = FACT(['publish', 'A00075'], SB4);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(status4('A00075').status, 'PUBLISHED');
  clean4('grounding-pass');
});
test('hardening: malformed claim_evidence (domain mismatch) => grounding REFUSE', () => {
  ready4('A00022', '<h1>ok</h1><p>Xe tay ga khoảng 150.000đ/ngày.</p>');
  fs.mkdirSync(path.join(SB4, 'data', 'research'), { recursive: true });
  fs.writeFileSync(path.join(SB4, 'data', 'research', 'A00022.json'), JSON.stringify({ article_id: 'A00022', claim_evidence: [{ claim: 'Xe tay ga khoảng 150.000đ/ngày', source_url: 'https://other.org/bang-gia', source_domain: 'example.com', date_accessed: '2026-09-29', claim_supported: 'Xe tay ga 150.000đ/ngày' }] }));
  const r = FACT(['publish', 'A00022'], SB4);
  assert.notStrictEqual(r.status, 0, 'source_domain must match the source_url hostname');
  assert.match(r.stderr, /malformed claim_evidence/);
  assert.strictEqual(status4('A00022').status, 'PASS');
  clean4('malformed-evidence');
});
test('hardening: last_completed_id = contiguous completed prefix (pristine truth)', () => {
  const SB5 = path.join(os.tmpdir(), 'lab-prefix-sandbox-' + process.pid);
  fs.rmSync(SB5, { recursive: true, force: true });
  fs.cpSync(ROOT, SB5, { recursive: true, filter: (s) => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && !path.basename(s).startsWith('content-matrix.csv.part');
  } });
  try {
    const f5 = require(path.join(SB5, 'scripts', 'factory', 'factory.js'));
    const prog = f5.progressOf(f5.loadMatrix());
    // production truth moves forward over time — derive the expected pristine
    // prefix from the sandbox matrix itself, then pin the pointer semantics
    const rows5 = f5.loadMatrix();
    let last = null, i = 0;
    while (i < rows5.length && rows5[i].status === 'PUBLISHED') { last = rows5[i].article_id; i++; }
    const total5 = rows5.filter(r => r.status === 'PUBLISHED').length;
    const firstPlanned5 = rows5.filter(r => r.status === 'PLANNED').map(r => r.article_id).sort()[0] || null;
    assert.strictEqual(prog.published_count, total5, 'published_count = exact PUBLISHED set');
    assert.strictEqual(prog.last_completed_id, last, 'prefix ends at the contiguous PUBLISHED prefix — never the lexicographic max (pilot rows far away)');
    assert.ok(/A\d{5}/.test(prog.last_completed_id), 'prefix must be non-empty on healthy production truth');
    assert.strictEqual(prog.next_claimable_id, firstPlanned5, 'next_claimable = first PLANNED row');
  } finally { fs.rmSync(SB5, { recursive: true, force: true }); }
});
test('hardening: a hole in the prefix shortens last_completed_id; pilots never extend it', () => {
  const SB5 = path.join(os.tmpdir(), 'lab-prefix-sandbox-' + process.pid);
  fs.rmSync(SB5, { recursive: true, force: true });
  fs.cpSync(ROOT, SB5, { recursive: true, filter: (s) => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && !path.basename(s).startsWith('content-matrix.csv.part');
  } });
  try {
    const csv5 = path.join(SB5, 'data', 'content-matrix.csv');
    const f5p = path.join(SB5, 'scripts', 'factory', 'factory.js');
    delete require.cache[require.resolve(f5p)];
    let f5 = require(f5p);
    const before = f5.progressOf(f5.loadMatrix());
    assert.strictEqual(f5.loadMatrix().find(r => r.article_id === 'A00010').status, 'PUBLISHED',
      'A00010 must sit inside the contiguous published prefix for this regression');
    const lines = fs.readFileSync(csv5, 'utf8').split('\n');
    const out = [lines[0]];
    for (const l of lines.slice(1).filter(x => x.trim())) {
      const c = parseLine4(l);
      if (c[0] === 'A00010') c[24] = 'PLANNED';
      out.push(c.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','));
    }
    fs.writeFileSync(csv5, out.join('\n'));
    delete require.cache[require.resolve(f5p)];
    f5 = require(f5p);
    const prog = f5.progressOf(f5.loadMatrix());
    assert.strictEqual(prog.last_completed_id, 'A00009', 'prefix stops before the hole at A00010');
    assert.strictEqual(prog.next_claimable_id, 'A00010');
    assert.strictEqual(prog.published_count, before.published_count - 1, 'the de-published hole row leaves the published set');
  } finally { fs.rmSync(SB5, { recursive: true, force: true }); }
});
test('hardening: fault injection — crash after stage => deterministic rollback via recover', () => {
  ready4('A00024', '<h1>ok</h1>');
  assert.strictEqual(FACT(['recover'], SB4).status, 0, 'pre-sync checkpoint from clean truth');
  const ckBefore = fs.readFileSync(path.join(SB4, 'data', 'state', 'checkpoint.json'), 'utf8');
  fact4.publishStage(['A00024']); // in-process stage = the crash window begins
  assert.strictEqual(status4('A00024').status, 'PUBLISHED', 'staged row is PUBLISHED inside the staged window');
  assert.ok(fs.existsSync(path.join(SB4, 'data', 'published', 'A00024.html')), 'staged archive exists mid-transaction');
  assert.ok(fs.existsSync(path.join(SB4, '_drafts', 'A00024.html')), 'draft survives the stage (removed only at commit)');
  assert.strictEqual(tx4().phase, 'STAGED');
  expireLock4(); // the process "died"; the lock went stale
  const r = FACT(['recover'], SB4);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROLLBACK COMPLETE/);
  assert.strictEqual(status4('A00024').status, 'PASS', 'row restored to pre-stage truth');
  assert.ok(!fs.existsSync(path.join(SB4, 'data', 'published', 'A00024.html')), 'staged archive removed by rollback');
  assert.ok(fs.existsSync(path.join(SB4, '_drafts', 'A00024.html')), 'draft intact after rollback');
  assert.strictEqual(ckBefore, fs.readFileSync(path.join(SB4, 'data', 'state', 'checkpoint.json'), 'utf8'), 'checkpoint restored byte-identical');
  clean4('crash-after-stage');
});
test('hardening: fault injection — crash right after beginTx (journal, no files) => rollback', () => {
  ready4('A00025', '<h1>ok</h1>');
  assert.strictEqual(FACT(['recover'], SB4).status, 0, 'pre-sync checkpoint from clean truth');
  const ckBefore = fs.readFileSync(path.join(SB4, 'data', 'state', 'checkpoint.json'), 'utf8');
  fs.writeFileSync(path.join(SB4, 'data', 'state', 'transaction.json'), JSON.stringify({ active: true, id: 'TX-CRASH', started_at: new Date().toISOString(), operation: 'publish', articles: ['A00025'], phase: 'STAGED', journal: { rows_before: { A00025: 'PASS' }, checkpoint_before: ckBefore, files: [], drafts: ['A00025'], ids: ['A00025'] } }));
  expireLock4();
  const r = FACT(['recover'], SB4);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROLLBACK COMPLETE/);
  assert.strictEqual(status4('A00025').status, 'PASS');
  assert.ok(fs.existsSync(path.join(SB4, '_drafts', 'A00025.html')), 'draft intact');
  assert.strictEqual(ckBefore, fs.readFileSync(path.join(SB4, 'data', 'state', 'checkpoint.json'), 'utf8'), 'checkpoint restored byte-identical');
  clean4('crash-after-begintx');
});
test('hardening: STAGED transaction without a journal => RECOVER STOP (never force-clear)', () => {
  fs.writeFileSync(path.join(SB4, 'data', 'state', 'transaction.json'), JSON.stringify({ active: true, id: 'TX-NOJ', started_at: new Date().toISOString(), operation: 'publish', articles: ['A00024'], phase: 'STAGED' }));
  expireLock4();
  const r = FACT(['recover'], SB4);
  assert.notStrictEqual(r.status, 0, 'ambiguous staged tx must STOP');
  assert.match(r.stderr, /RECOVER STOP/);
  assert.strictEqual(tx4().active, true, 'transaction must NOT be force-cleared');
  // resolve deterministically for the tests below: restore journal truth, then roll back
  const ck = fs.readFileSync(path.join(SB4, 'data', 'state', 'checkpoint.json'), 'utf8');
  fs.writeFileSync(path.join(SB4, 'data', 'state', 'transaction.json'), JSON.stringify({ active: true, id: 'TX-NOJ', started_at: new Date().toISOString(), operation: 'publish', articles: [], phase: 'STAGED', journal: { rows_before: {}, checkpoint_before: ck, files: [], drafts: [], ids: [] } }));
  assert.strictEqual(FACT(['recover'], SB4).status, 0, 'journal-restored tx must roll back');
  clean4('staged-no-journal');
});
test('hardening: atomic operator publish — build failure rolls back (never half-published)', () => {
  ready4('A00026', '<h1>ok</h1>');
  const bs = path.join(SB4, 'scripts', 'site', 'build-site.js');
  const orig = fs.readFileSync(bs, 'utf8');
  // the copied REAL ledger already records the historical publish of A00026 —
  // a rollback must add NO NEW event (relative count, not absolute absence)
  const evCount4 = (id) => JSON.parse(fs.readFileSync(path.join(SB4, 'data', 'state', 'throughput-ledger.json'), 'utf8'))
    .events.filter(e => e.op === 'publish' && (e.ids || []).includes(id)).length;
  const evBefore = evCount4('A00026');
  try {
    fs.writeFileSync(bs, 'process.exit(1);\n' + orig);
    const r = OP(['publish', '--ids', 'A00026', '--scope', 'fast'], SB4);
    assert.notStrictEqual(r.status, 0, 'failed build must not commit');
    assert.match(r.stderr, /NOT committed|Rolling back/);
    assert.strictEqual(status4('A00026').status, 'PASS', 'row restored to pre-publish truth');
    assert.ok(fs.existsSync(path.join(SB4, '_drafts', 'A00026.html')), 'draft intact after rollback');
    assert.ok(!fs.existsSync(path.join(SB4, 'data', 'published', 'A00026.html')), 'staged archive removed by rollback');
    assert.strictEqual(evCount4('A00026'), evBefore, 'no NEW ledger event for a rolled-back publish');
    clean4('operator-build-fail');
  } finally { fs.writeFileSync(bs, orig); }
});
test('hardening: atomic operator publish — editorial-audit failure rolls back (DEEP scope still gates on it)', () => {
  ready4('A00026', '<h1>ok</h1>');
  const ea = path.join(SB4, 'scripts', 'factory', 'editorial-audit.js');
  const orig = fs.readFileSync(ea, 'utf8');
  try {
    fs.writeFileSync(ea, 'process.exit(1);\n' + orig);
    const r = OP(['publish', '--ids', 'A00026', '--scope', 'deep'], SB4);
    assert.notStrictEqual(r.status, 0, 'failed editorial audit must not commit');
    assert.match(r.stderr, /NOT committed|Rolling back/);
    assert.strictEqual(status4('A00026').status, 'PASS');
    assert.ok(fs.existsSync(path.join(SB4, '_drafts', 'A00026.html')), 'draft intact');
    assert.ok(!fs.existsSync(path.join(SB4, 'data', 'published', 'A00026.html')), 'archive removed by rollback');
    clean4('operator-audit-fail');
  } finally { fs.writeFileSync(ea, orig); }
});
test('hardening: qa-repair refuses non-PUBLISHED rows (never fabricate evidence)', () => {
  const r = FACT(['qa-repair', 'A00016'], SB4); // A00016 is PASS (draft flow), not PUBLISHED
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /qa-repair refused/);
  clean4('qa-repair-refuse');
});
test('hardening: qa-repair re-scores a PUBLISHED archive and binds its exact hash', () => {
  const SB6 = path.join(os.tmpdir(), 'lab-qarepair-sandbox-' + process.pid);
  fs.rmSync(SB6, { recursive: true, force: true });
  fs.cpSync(ROOT, SB6, { recursive: true, filter: (s) => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && !path.basename(s).startsWith('content-matrix.csv.part');
  } });
  try {
    const r = FACT(['qa-repair', 'A00005'], SB6);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /QA-REPAIR A00005 score=/);
    const ev = JSON.parse(fs.readFileSync(path.join(SB6, 'data', 'qa', 'A00005.json'), 'utf8'));
    assert.strictEqual(ev.scored_artifact, 'published-archive');
    assert.strictEqual(ev.result, 'PASS');
    const archiveSha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(SB6, 'data', 'published', 'A00005.html'))).digest('hex');
    assert.strictEqual(ev.draft_sha256, archiveSha, 'repaired evidence binds the exact archive bytes');
    // matrix row stays PUBLISHED with the re-scored qa_score
    const row = fs.readFileSync(path.join(SB6, 'data', 'content-matrix.csv'), 'utf8').split('\n').map(l => parseLine4(l)).find(c => c[0] === 'A00005');
    assert.strictEqual(row[24], 'PUBLISHED');
  } finally { fs.rmSync(SB6, { recursive: true, force: true }); }
});
test('hardening: the grounding gate stays wired into the publish path (operator staged verify)', () => {
  // single-workflow architecture: factory-production.yml runs operator
  // publish (FAST = staged consistency + SELECTED-ID grounding), and the
  // staged verify steps always contain the grounding gate.
  const opSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'factory', 'operator.js'), 'utf8');
  assert.match(opSrc, /grounding/, 'operator verify must stage the grounding gate');
  const staged = require(path.join(ROOT, 'scripts', 'factory', 'operator.js'))
    .verifyStepsStaged('fast', 'TX-1', ['A00015']).map(s => s.join(' ')).join(' | ');
  assert.match(staged, /grounding/, 'FAST publish verify keeps selected-ID grounding');
  const y = wfText('factory-production.yml');
  assert.match(y, /operator\.js publish --ids/, 'production loop must publish through the operator (grounding-gated)');
});
// =====================================================================
// HARDENING SESSION 3 — staged-aware verify (success-path publish must
// COMMIT, not self-rollback), deterministic public-output prune (build
// manifest), and prep-pilot bootstrap guards.
// =====================================================================
const row4 = id => { const txt = fs.readFileSync(csvPath4, 'utf8'); const h = parseLine4(txt.split('\n')[0]);
  for (const l of txt.split('\n').slice(1).filter(x => x.trim())) { const c = parseLine4(l); if (c[0] === id) { const o = {}; h.forEach((k, i) => o[k] = c[i] || ''); return o; } } return null; };
const build4 = () => { const r = spawnSync(process.execPath, [path.join(SB4, 'scripts', 'site', 'build-site.js')], { cwd: SB4, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'SB4 build must succeed: ' + r.stdout + r.stderr); return r; };
const manifest4 = () => JSON.parse(fs.readFileSync(path.join(SB4, 'data', 'state', 'build-manifest.json'), 'utf8'));
const sitemapHas4 = canonical => fs.readdirSync(SB4).filter(f => /^sitemap-.*\.xml$/.test(f) && f !== 'sitemap-index.xml')
  .some(f => fs.readFileSync(path.join(SB4, f), 'utf8').includes(canonical));
const pageRel4 = r => r.output_path.replace(/^\/+/, '').replace(/\/+$/, '') + '/index.html';

test('harden3: END-TO-END operator publish SUCCEEDS (staged verify no longer self-deadlocks)', () => {
  ready4('A00028', shellHtml4('A00028'));
  build4(); // promote pages for rows published by earlier bare-publish tests (A00015/A00021)
  const before = JSON.parse(fs.readFileSync(path.join(SB4, 'data', 'state', 'throughput-ledger.json'), 'utf8'));
  const pubBefore = before.events.filter(e => e.op === 'publish').length;
  const r = OP(['publish', '--ids', 'A00028', '--scope', 'deep'], SB4);
  assert.strictEqual(r.status, 0, 'operator publish success path must COMMIT, not self-rollback:\nSTDOUT ' + r.stdout + '\nSTDERR ' + r.stderr);
  assert.match(r.stdout, /PUBLISHED \(atomic, build\+verify PASS\) 1: A00028/);
  // engine state: tx inactive, lock free, draft removed, matrix PUBLISHED
  clean4('e2e-success');
  assert.strictEqual(status4('A00028').status, 'PUBLISHED');
  assert.ok(!fs.existsSync(path.join(SB4, '_drafts', 'A00028.html')), 'draft removed at commit');
  assert.ok(fs.existsSync(path.join(SB4, 'data', 'published', 'A00028.html')), 'durable archive written');
  // public surface: root page + manifest + sitemap + hub + search + knowledge index
  const row = row4('A00028');
  const rel = pageRel4(row);
  assert.ok(fs.existsSync(path.join(SB4, rel)), 'published public page exists at the repository root');
  assert.ok(manifest4().files.includes(rel), 'build manifest tracks the published page');
  assert.ok(sitemapHas4(row.canonical), 'published canonical present in a sitemap shard');
  const hubSlug = rel.split('/')[0];
  assert.ok(fs.readFileSync(path.join(SB4, hubSlug, 'index.html'), 'utf8').includes(row.output_path), 'article listed on its hub page');
  const search = JSON.parse(fs.readFileSync(path.join(SB4, 'assets', 'search-index.json'), 'utf8'));
  assert.ok(search.some(e => e.u === row.output_path), 'search index covers the published article');
  const kidx = JSON.parse(fs.readFileSync(path.join(SB4, 'assets', 'knowledge-index.json'), 'utf8'));
  assert.ok((kidx.records || []).some(e => e.u === row.output_path), 'knowledge index covers the published article');
  // checkpoint truth + ledger: exactly ONE real publish event
  const ck = JSON.parse(fs.readFileSync(path.join(SB4, 'data', 'state', 'checkpoint.json'), 'utf8'));
  assert.deepStrictEqual(ck.last_batch, ['A00028']);
  const pubCount = fs.readFileSync(csvPath4, 'utf8').split('\n').slice(1).filter(x => x.trim())
    .map(l => parseLine4(l)).filter(c => c[24] === 'PUBLISHED').length;
  assert.strictEqual(Number(ck.published_count), pubCount, 'checkpoint published_count = matrix truth');
  const ledger = JSON.parse(fs.readFileSync(path.join(SB4, 'data', 'state', 'throughput-ledger.json'), 'utf8'));
  const events28 = ledger.events.filter(e => e.op === 'publish' && JSON.stringify(e.ids) === JSON.stringify(['A00028']));
  assert.strictEqual(events28.length, 1, 'exactly one real publish event for A00028');
  assert.strictEqual(ledger.events.filter(e => e.op === 'publish').length, pubBefore + 1, 'ledger gained exactly one publish event');
});

test('harden3: de-published page VANISHES from the public tree after REPAIR + rebuild', () => {
  const row = row4('A00028');
  const rel = pageRel4(row);
  assert.ok(fs.existsSync(path.join(SB4, rel)), 'precondition: A00028 public page exists');
  setRow4('A00028', { status: 'REPAIR', qa_score: 80 }); // de-publish (repair path)
  build4();
  assert.ok(!fs.existsSync(path.join(SB4, rel)), 'old public URL must vanish once the row is de-published');
  assert.ok(!manifest4().files.includes(rel), 'manifest no longer lists the de-published page');
  assert.ok(!sitemapHas4(row.canonical), 'de-published canonical must leave the sitemaps');
  // all legitimate published URLs remain after the prune
  const rel5 = pageRel4(row4('A00005'));
  assert.ok(fs.existsSync(path.join(SB4, rel5)), 'legitimate published page still present after prune');
  assert.ok(manifest4().files.includes(rel5), 'legitimate published page still in the manifest');
  // restore sandbox truth and re-sync derived pointers
  setRow4('A00028', { status: 'PUBLISHED', qa_score: 100 });
  build4();
  assert.ok(fs.existsSync(path.join(SB4, rel)), 're-published page restored by rebuild');
  assert.strictEqual(FACT(['recover'], SB4).status, 0, 'checkpoint re-synced from matrix truth');
});

test('harden3: staged public URL is pruned from the root after publish rollback', () => {
  ready4('A00029', shellHtml4('A00029'));
  const rel = pageRel4(row4('A00029'));
  const rootPage = path.join(SB4, rel);
  fact4.publishStage(['A00029']); // staged: lock + STAGED tx held in-process
  build4(); // the staged build promotes the staged URL to the public root
  assert.ok(fs.existsSync(rootPage), 'staged build promoted the staged URL to the root');
  assert.ok(manifest4().files.includes(rel), 'manifest tracks the staged URL');
  fact4.publishRollback('test: forced failure after the staged build');
  assert.ok(!fs.existsSync(rootPage), 'staged public URL must VANISH from the root after rollback');
  assert.ok(!manifest4().files.includes(rel), 'manifest no longer lists the rolled-back URL');
  assert.ok(fs.existsSync(path.join(SB4, '_drafts', 'A00029.html')), 'draft intact after rollback');
  assert.ok(!fs.existsSync(path.join(SB4, 'data', 'published', 'A00029.html')), 'staged archive removed by rollback');
  assert.strictEqual(status4('A00029').status, 'PASS', 'matrix restored to pre-stage truth');
  clean4('prune-after-rollback');
});

test('harden3: staged verify contract accepts ONLY the exact in-flight transaction', () => {
  ready4('A00030', shellHtml4('A00030'));
  const staged = fact4.publishStage(['A00030']);
  const txId = staged.tx.id;
  build4(); // the real operator flow builds the staged state BEFORE verifying it
  // wrong tx id => refuse (never a blanket bypass of the tx invariant)
  let r = FACT(['consistency', '--staged-tx', 'TX-NOT-MINE'], SB4);
  assert.notStrictEqual(r.status, 0, 'consistency must refuse a foreign tx id');
  assert.match(r.stderr, /no matching active STAGED publish transaction/);
  // staged id outside the journal => refuse
  r = FACT(['consistency', '--staged-tx', txId, '--staged-ids', 'A00099'], SB4);
  assert.notStrictEqual(r.status, 0, 'consistency must refuse ids outside the journal');
  assert.match(r.stderr, /staged ids outside transaction/);
  // the exact in-flight tx + its journal ids => PASS (this un-deadlocks the
  // operator success path WITHOUT weakening the production invariant)
  r = FACT(['consistency', '--staged-tx', txId, '--staged-ids', 'A00030'], SB4);
  assert.strictEqual(r.status, 0, 'staged consistency must PASS for the exact in-flight tx:\n' + r.stdout + r.stderr);
  assert.match(r.stdout, /CONSISTENCY PASS/);
  // capacity-check: foreign tx => FAIL; exact tx => PASS (publish lock accepted)
  r = spawnSync(process.execPath, [path.join(SB4, 'scripts', 'factory', 'capacity-check.js'), '--staged-tx', 'TX-NOT-MINE'], { cwd: SB4, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'capacity-check must FAIL for a foreign staged tx');
  r = spawnSync(process.execPath, [path.join(SB4, 'scripts', 'factory', 'capacity-check.js'), '--staged-tx', txId], { cwd: SB4, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'staged capacity-check must PASS for the exact in-flight tx:\n' + r.stdout + r.stderr);
  // grounding narrowed to the staged id
  r = FACT(['grounding', 'A00030'], SB4);
  assert.strictEqual(r.status, 0, 'grounding of the staged id must PASS');
  fact4.publishRollback('staged-contract test done');
  clean4('staged-contract');
});

test('harden3: prep-pilot REFUSES outside the PILOT bootstrap (no state touched)', () => {
  const ckB = fs.readFileSync(path.join(SB4, 'data', 'state', 'checkpoint.json'), 'utf8');
  const csvB = fs.readFileSync(csvPath4, 'utf8');
  const r = spawnSync(process.execPath, [path.join(SB4, 'scripts', 'factory', 'prep-pilot.js')], { cwd: SB4, encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'prep-pilot must refuse in PRODUCTION phase');
  assert.match(r.stderr, /REFUSED.*PILOT-phase bootstrap-only/);
  assert.strictEqual(ckB, fs.readFileSync(path.join(SB4, 'data', 'state', 'checkpoint.json'), 'utf8'), 'checkpoint byte-identical after refusal');
  assert.strictEqual(csvB, fs.readFileSync(csvPath4, 'utf8'), 'matrix byte-identical after refusal');
});

test('harden3: prep-pilot bootstrap path works ONLY inside a PILOT-phase, zero-published sandbox', () => {
  const SB7 = path.join(os.tmpdir(), 'lab-preppilot-sandbox-' + process.pid);
  fs.rmSync(SB7, { recursive: true, force: true });
  fs.cpSync(ROOT, SB7, { recursive: true, filter: (s) => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && !path.basename(s).startsWith('content-matrix.csv.part');
  } });
  try {
    const cfg7 = path.join(SB7, 'config', 'content-factory.json');
    const c7 = JSON.parse(fs.readFileSync(cfg7, 'utf8'));
    c7.phase = 'PILOT';
    fs.writeFileSync(cfg7, JSON.stringify(c7, null, 2));
    const ck7 = path.join(SB7, 'data', 'state', 'checkpoint.json');
    const k7 = JSON.parse(fs.readFileSync(ck7, 'utf8'));
    k7.published_count = 0; // bootstrap window: nothing published yet
    fs.writeFileSync(ck7, JSON.stringify(k7, null, 2));
    let r = spawnSync(process.execPath, [path.join(SB7, 'scripts', 'factory', 'prep-pilot.js')], { cwd: SB7, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'PILOT bootstrap window must still run the legacy prep:\n' + r.stdout + r.stderr);
    assert.match(r.stdout, /PREPARED/);
    // once ANYTHING is published the bootstrap window is over => refuse
    const k8 = JSON.parse(fs.readFileSync(ck7, 'utf8'));
    k8.published_count = 1;
    fs.writeFileSync(ck7, JSON.stringify(k8, null, 2));
    const csvB = fs.readFileSync(path.join(SB7, 'data', 'content-matrix.csv'), 'utf8');
    r = spawnSync(process.execPath, [path.join(SB7, 'scripts', 'factory', 'prep-pilot.js')], { cwd: SB7, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, 'published_count>0 must refuse');
    assert.match(r.stderr, /REFUSED.*bootstrap safety/);
    assert.strictEqual(csvB, fs.readFileSync(path.join(SB7, 'data', 'content-matrix.csv'), 'utf8'), 'matrix untouched by the refusal');
  } finally { fs.rmSync(SB7, { recursive: true, force: true }); }
});

test('cleanup: remove hardening sandbox', () => { fs.rmSync(SB4, { recursive: true, force: true }); });

test('cleanup: remove operator sandbox', () => { fs.rmSync(SB, { recursive: true, force: true }); });

// =====================================================================
// HARDENING SESSION 4 — 4-tier validation model (push-driven production
// loop contract F1, per-ref concurrency F2, liveness watchdog F3, soak F4, docs contract F5).
// =====================================================================
const wd = require(path.join(ROOT, 'scripts', 'factory', 'liveness-watchdog.js'));

test('F1 push-driven workflow contract: factory-production.yml is the single production loop', () => {
  const y = wfText('factory-production.yml');
  // Paths filter đã bỏ: workflow đa-trigger + paths filter sinh run 0-job
  // FAILURE gắn check đỏ vô nghĩa lên mọi push không đụng _drafts. Hợp đồng
  // an toàn được giữ bởi push-gate: publish chỉ chạy khi push thật sự đụng
  // _drafts/** (outputs.drafts).
  assert.doesNotMatch(y, /paths:\s*\['_drafts/, 'không dùng paths filter (run 0-job FAILURE)');
  assert.match(y, /push-gate/, 'phải có push-gate guard job cho mọi push main');
  assert.match(y, /outputs\.drafts/, 'push-gate phải xuất tín hiệu drafts');
  assert.match(y, /group:\s*lab-factory-production/, 'phải giữ group serialization GLOBAL');
  assert.match(y, /cancel-in-progress:\s*false/, 'không bao giờ cancel production run đang chạy');
  assert.match(y, /push-selection\.js/, 'phải chọn EXACT IDs qua push-selection.js');
  assert.match(y, /operator\.js recover/, 'phải recover trước khi claim');
  assert.match(y, /prepare-next --ids/, 'phải claim EXACT IDs vừa push');
  assert.match(y, /operator\.js qa --ids/, 'phải QA đúng IDs đã push');
  assert.match(y, /operator\.js publish --ids/, 'phải publish CHỈ hàng PASS');
  assert.match(y, /status \| recover \| diagnostics/, 'dispatch chỉ còn ops bảo trì');
  assert.doesNotMatch(y, /operator-command\.json/, 'kênh command-file đã retire');
  assert.doesNotMatch(y, /factory-operator\.yml/, 'workflow cũ không được reference');
  assert.ok(!fs.existsSync(path.join(ROOT, '.github', 'workflows', 'factory-operator.yml')),
    'factory-operator.yml phải bị XÓA khỏi repo');
});
test('F1 channel retirement: operator.js is CLI-only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'factory', 'operator.js'), 'utf8');
  assert.doesNotMatch(src, /operator-command\.json/, 'không còn command-file channel');
  assert.doesNotMatch(src, /--channel/, 'không còn channel flag');
  assert.match(src, /push-selection\.js/, 'header phải document hợp đồng push-selection');
});
test('F2 concurrency contract: exactly three canonical workflows — production serialized, repair chained, soak Tier 4', () => {
  // Kiến trúc 3 workflow: factory-production.yml (vòng production),
  // factory-repair.yml (Agent #4/#5 lắng nghe run của 'Factory production' qua
  // workflow_run — GitHub TỪ CHỐI workflow_run tự tham chiếu), factory-soak.yml
  // (Tier 4). Toàn bộ mutation production vẫn serialize qua MỘT group GLOBAL.
  const wfDir = path.join(ROOT, '.github', 'workflows');
  const files = fs.readdirSync(wfDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.deepStrictEqual(files, ['factory-production.yml', 'factory-repair.yml', 'factory-soak.yml'],
    'exactly the three canonical workflows may exist');
  const op = wfText('factory-production.yml');
  assert.match(op, /group:\s*lab-factory-production/, 'production loop must keep the GLOBAL serialization group');
  assert.match(op, /cancel-in-progress:\s*false/, 'production loop must never cancel in-flight runs');
  assert.ok(!/lab-factory-production-\$\{\{/.test(op), 'production group must NOT be per-ref');
  const rp = wfText('factory-repair.yml');
  assert.match(rp, /workflows:\s*\['Factory production'\]/, 'repair must be triggered by Factory production failures');
  assert.ok(!/workflows:\s*\['Factory repair'\]/.test(rp), 'repair must never self-reference (self workflow_run fails to parse)');
  assert.match(rp, /group:\s*lab-factory-production/, 'repair must serialize with production (same GLOBAL group)');
  assert.match(rp, /cancel-in-progress:\s*false/, 'repair must never cancel an in-flight production run');
});
test('F3 watchdog unit: HEALTHY IDLE -> PASS (user resting is never a failure)', () => {
  const r = wd.evaluate({ nowIso: '2026-09-30T00:00:00Z', activeChunk: [], activeChunkUnfinished: 0,
    transaction: { active: false }, lock: { locked: false }, command: null, commandFileMinutes: null,
    lastProgressMinutes: 100000 }, {});
  assert.strictEqual(r.status, 'HEALTHY IDLE');
  assert.strictEqual(r.exitCode, wd.EXIT_PASS);
});
test('F3 watchdog unit: HEALTHY ACTIVE (unfinished work + fresh progress) -> PASS', () => {
  const r = wd.evaluate({ nowIso: '2026-09-30T00:00:00Z', activeChunk: ['A00015'], activeChunkUnfinished: 1,
    transaction: { active: false }, lock: { locked: true, holder: 'publish', expires_at: '2026-09-30T01:00:00Z' },
    command: null, commandFileMinutes: null, lastProgressMinutes: 5 }, {});
  assert.strictEqual(r.status, 'HEALTHY ACTIVE');
  assert.strictEqual(r.exitCode, wd.EXIT_PASS);
});
test('F3 watchdog unit: stale drafts -> WARN (exit 2), clean _drafts -> PASS', () => {
  const base = { nowIso: '2026-09-30T00:00:00Z', activeChunk: [], activeChunkUnfinished: 0,
    transaction: { active: false }, lock: { locked: false }, lastProgressMinutes: 1 };
  const stale = wd.evaluate({ ...base, staleDrafts: ['A00005.html', 'A99999.body.html'] }, {});
  assert.strictEqual(stale.exitCode, wd.EXIT_WARN, 'stale drafts là lint WARN, không FAIL production');
  assert.ok(stale.findings.some(f => f.status === 'STALE_DRAFTS'), 'must flag STALE_DRAFTS');
  const clean = wd.evaluate({ ...base, staleDrafts: [] }, {});
  assert.strictEqual(clean.exitCode, wd.EXIT_PASS, '_drafts sạch => PASS');
});
test('F3 watchdog unit: stalled active chunk (no fresh progress) -> FAIL', () => {
  const r = wd.evaluate({ nowIso: '2026-09-30T00:00:00Z', activeChunk: ['A00015'], activeChunkUnfinished: 1,
    transaction: { active: false }, lock: { locked: false }, command: null, commandFileMinutes: null,
    lastProgressMinutes: 800 }, {});
  assert.strictEqual(r.exitCode, wd.EXIT_FAIL);
  assert.ok(r.findings.some(f => f.status === 'STALLED'), 'must flag STALLED');
});
test('F3 watchdog unit: expired lock + unfinished work -> FAIL; expired lock idle -> WARN', () => {
  const bad = wd.evaluate({ nowIso: '2026-09-30T00:00:00Z', activeChunk: ['A00015'], activeChunkUnfinished: 1,
    transaction: { active: false }, lock: { locked: true, holder: 'writer', expires_at: '2026-09-29T23:00:00Z' },
    command: null, commandFileMinutes: null, lastProgressMinutes: 1 }, {});
  assert.strictEqual(bad.exitCode, wd.EXIT_FAIL);
  assert.ok(bad.findings.some(f => f.status === 'EXPIRED_LOCK_UNFINISHED_WORK'));
  const idle = wd.evaluate({ nowIso: '2026-09-30T00:00:00Z', activeChunk: [], activeChunkUnfinished: 0,
    transaction: { active: false }, lock: { locked: true, holder: 'writer', expires_at: '2026-09-29T23:00:00Z' },
    command: null, commandFileMinutes: null, lastProgressMinutes: 1 }, {});
  assert.strictEqual(idle.exitCode, wd.EXIT_WARN, 'idle expired lock is hygiene (WARN), never force-cleared by the watchdog');
});
test('F3 watchdog unit: over-age active transaction -> FAIL', () => {
  const r = wd.evaluate({ nowIso: '2026-09-30T00:00:00Z', activeChunk: [], activeChunkUnfinished: 0,
    transaction: { active: true, id: 'TX-1', operation: 'publish', started_at: '2026-09-29T21:00:00Z' },
    lock: { locked: false }, command: null, commandFileMinutes: null, lastProgressMinutes: 1 }, {});
  assert.strictEqual(r.exitCode, wd.EXIT_FAIL);
  assert.ok(r.findings.some(f => f.status === 'ACTIVE_TX_TOO_OLD'));
});
test('F3 watchdog CLI: read-only on the real repo, PASS on healthy idle, state byte-identical', () => {
  const snap = () => ['data/state/checkpoint.json', 'data/state/transaction.json', 'data/state/writer-lock.json', 'data/state/throughput-ledger.json']
    .map(p => require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex')).join('.');
  const before = snap();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'factory', 'liveness-watchdog.js')], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'watchdog must PASS on the healthy idle production state:\n' + r.stdout);
  assert.match(r.stdout, /HEALTHY IDLE/, 'production is idle: user resting is not a failure');
  assert.strictEqual(before, snap(), 'watchdog must never mutate repository truth');
});
test('F3 watchdog contract: wired into the production smoke; read-only source, never commits', () => {
  // the standalone watchdog workflow was retired with the other CI tiers —
  // the watchdog now runs INSIDE the factory-production.yml smoke step.
  const y = wfText('factory-production.yml');
  assert.match(y, /liveness-watchdog\.js/, 'the production smoke must run the liveness watchdog');
  const wd = fs.readFileSync(path.join(ROOT, 'scripts', 'factory', 'liveness-watchdog.js'), 'utf8');
  assert.ok(!/git push|git commit/.test(wd), 'watchdog script must never commit or push');
  assert.ok(!/child_process|spawnSync|execSync/.test(wd), 'watchdog must be pure evaluation, no shell');
});
test('F4 soak contract: dedicated Tier 4 workflow (tier4-gate) — never in the production hot loop', () => {
  // factory-soak.yml là workflow Tier 4 RIÊNG: mọi push vào main / PR đều qua
  // tier4-gate (no-op xanh khi diff không đụng engine/workflow/tests; chạy đủ
  // bộ Tier 4 khi có thay đổi thật — không dùng paths filter, không 0-job đỏ).
  // Hot loop production vẫn KHÔNG BAO GIỜ chạy soak.
  assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'soak', 'factory-soak.js')), 'soak suite must exist');
  const sw = wfText('factory-soak.yml');
  assert.match(sw, /tier4-gate/, 'soak workflow must gate Tier 4 on real diff detection');
  assert.match(sw, /group:\s*factory-soak/, 'soak must have its own concurrency group');
  assert.match(sw, /on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/, 'soak Tier 4 runs on pushes to main');
  const y = wfText('factory-production.yml');
  assert.doesNotMatch(y, /factory-soak/, 'the production hot loop must never run the soak suite');
  assert.doesNotMatch(y, /node --test/, 'the production hot loop must never run the full test-suite');
});
test('F5 docs contract: 4-tier validation model documented in canonical docs', () => {
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const proc = fs.readFileSync(path.join(ROOT, 'docs', 'PROC-PUBLISH.md'), 'utf8');
  const factory = fs.readFileSync(path.join(ROOT, 'docs', 'CONTENT-FACTORY.md'), 'utf8');
  for (const [name, t] of [['AGENTS.md', agents], ['docs/PROC-PUBLISH.md', proc], ['docs/CONTENT-FACTORY.md', factory]]) {
    assert.match(t, /Tier 1/i, name + ' must document Tier 1 (unit)');
    assert.match(t, /Tier 4/i, name + ' must document Tier 4 (long-run/recovery/liveness)');
    assert.match(t, /node --test tests\/test-suite\.js/, name + ' must pin the Tier 1 command');
    assert.match(t, /soak/i, name + ' must require the soak suite');
  }
  assert.match(agents, /push-driven/i, 'AGENTS.md must document the push-driven production loop');
  assert.match(agents, /push-selection\.js/, 'AGENTS.md must document the push-selection contract');
  assert.match(proc, /push-driven/i, 'PROC-PUBLISH must document the push-driven loop');
  assert.match(proc, /factory-production\.yml/, 'PROC-PUBLISH must pin the production workflow');
});


// ---------- HARDENING SESSION 5: canonical matrix truth + fail-closed watchdog + Tier 4 main enforcement ----------
const WS5 = path.join(os.tmpdir(), 'lab-hardening5-' + process.pid);
const WS5_REPO = path.join(os.tmpdir(), 'lab-hardening5-repo-' + process.pid);
function wdFixture(mutate) {
  fs.rmSync(WS5, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS5, 'data', 'state'), { recursive: true });
  const H = 'article_id,slug,cluster,status\n';
  const fr = ['A00001,s1,RENTAL,PLANNED', 'A00002,s2,RENTAL,RESEARCH', 'A00003,s3,RENTAL,PASS',
    'A00004,s4,RENTAL,QA', 'A00005,s5,RENTAL,PUBLISHED', 'A00006,s6,RENTAL,PASS'];
  fs.writeFileSync(path.join(WS5, 'data', 'content-matrix.csv.part00'), H + fr.slice(0, 4).join('\n') + '\n');
  fs.writeFileSync(path.join(WS5, 'data', 'content-matrix.csv.part01'), fr.slice(4).join('\n') + '\n');
  const st = {
    'checkpoint.json': { last_run: '2026-09-29T00:00:00Z', phase: 'PRODUCTION', matrix_rows: 6, published_count: 1,
      last_batch: [], last_completed_id: 'A00005', next_claimable_id: 'A00006', active_chunk: [], notes: 'fixture' },
    'transaction.json': { active: false, id: null, started_at: null, operation: null, articles: [], notes: 'Committed.' },
    'writer-lock.json': { locked: false, holder: null, acquired_at: null, expires_at: null },
    'throughput-ledger.json': { version: 1, events: [{ op: 'qa', started_at: '2026-09-28T23:00:00Z',
      finished_at: '2026-09-29T00:01:00Z', ids: ['A00005'], count: 1 }] },
  };
  for (const [f, o] of Object.entries(st)) fs.writeFileSync(path.join(WS5, 'data', 'state', f), JSON.stringify(o));
  if (mutate) mutate(WS5);
  return WS5;
}
const wdRun = (args) => spawnSync(process.execPath,
  [path.join(ROOT, 'scripts', 'factory', 'liveness-watchdog.js'), ...args], { encoding: 'utf8' });
const wdStalledMut = (id) => (sb) => {
  const cp = JSON.parse(fs.readFileSync(path.join(sb, 'data', 'state', 'checkpoint.json'), 'utf8'));
  cp.active_chunk = [id];
  fs.writeFileSync(path.join(sb, 'data', 'state', 'checkpoint.json'), JSON.stringify(cp));
};

test('S5 A: clean checkout chỉ có canonical shards (không assembled CSV) — watchdog đọc đủ 10,000 rows repo thật', () => {
  fs.rmSync(WS5_REPO, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS5_REPO, 'data', 'state'), { recursive: true });
  let shards = 0;
  for (const f of fs.readdirSync(DATA)) {
    if (/^content-matrix\.csv\.part/.test(f)) { fs.copyFileSync(path.join(DATA, f), path.join(WS5_REPO, 'data', f)); shards++; }
  }
  assert.ok(shards >= 2, 'fixture cần ít nhất 2 shards thật');
  assert.ok(!fs.existsSync(path.join(WS5_REPO, 'data', 'content-matrix.csv')),
    'clean checkout simulation: assembled CSV (gitignored) phải KHÔNG tồn tại');
  for (const f of ['checkpoint.json', 'transaction.json', 'writer-lock.json', 'throughput-ledger.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', 'state', f), path.join(WS5_REPO, 'data', 'state', f));
  }
  const snap = wd.collectSnapshot(WS5_REPO, '2026-09-30T00:00:00Z');
  assert.strictEqual(snap.matrixRows, rows.length, 'phải đọc đủ SỐ ROW THẬT từ canonical shards (' + rows.length + ')');
  assert.strictEqual(snap.matrixSource, 'shards', 'phải tự nhận diện nguồn canonical shards');
  assert.strictEqual(snap.fatals.length, 0, 'không được có fatal trên canonical truth đầy đủ');
  assert.strictEqual(wd.evaluate(snap, {}).exitCode, wd.EXIT_PASS, 'repo idle + shards đầy đủ => PASS, không bỏ lọt');
});

test('S5 I: HEALTHY IDLE với canonical shards đầy đủ (không assembled CSV) -> exit 0', () => {
  const r = wdRun([wdFixture()]);
  assert.strictEqual(r.status, 0, 'shards đầy đủ + state valid + idle => PASS:\n' + r.stdout + r.stderr);
  assert.match(r.stdout, /HEALTHY IDLE/);
  assert.match(r.stdout, /source: shards/);
});

test('S5 B: active_chunk RESEARCH + progress quá ngưỡng -> STALLED exit 1 (không bỏ lọt nhờ canonical loader)', () => {
  const r = wdRun([wdFixture(wdStalledMut('A00002')), '--now', '2026-09-30T06:00:00Z']);
  assert.strictEqual(r.status, 1, 'RESEARCH đứng >720p phải FAIL:\n' + r.stdout);
  assert.match(r.stdout, /STALLED/);
});

test('S5 C: active_chunk PASS + progress quá ngưỡng -> STALLED exit 1', () => {
  const r = wdRun([wdFixture(wdStalledMut('A00003')), '--now', '2026-09-30T06:00:00Z']);
  assert.strictEqual(r.status, 1, 'PASS đứng >720p phải FAIL:\n' + r.stdout);
  assert.match(r.stdout, /STALLED/);
});

test('S5 D: thiếu shard ĐẦU dãy (part00) -> contiguity break -> FAIL CLOSED STATE_MISSING', () => {
  const r = wdRun([wdFixture((sb) => fs.rmSync(path.join(sb, 'data', 'content-matrix.csv.part00')))]);
  assert.strictEqual(r.status, 1, 'shard đầu thiếu => FAIL CLOSED:\n' + r.stdout);
  assert.match(r.stdout, /STATE_MISSING/);
  assert.match(r.stdout, /FAIL CLOSED/);
});

test('S5 D2: thiếu shard CUỐI dãy (part01) -> cross-check checkpoint.matrix_rows -> FAIL CLOSED, không giả HEALTHY với row thiếu', () => {
  const r = wdRun([wdFixture((sb) => fs.rmSync(path.join(sb, 'data', 'content-matrix.csv.part01')))]);
  assert.strictEqual(r.status, 1, 'dãy part00 "liền mạch" nhưng thiếu row — phải bị cross-check bắt:\n' + r.stdout);
  assert.match(r.stdout, /STATE_INVALID/);
  assert.match(r.stdout, /checkpoint\.matrix_rows/);
  assert.match(r.stdout, /FAIL CLOSED/);
});

test('S5 E: shard malformed (row thiếu cột) -> FAIL CLOSED STATE_INVALID', () => {
  const r = wdRun([wdFixture((sb) => fs.writeFileSync(path.join(sb, 'data', 'content-matrix.csv.part01'), 'A00006\n'))]);
  assert.strictEqual(r.status, 1, 'shard hỏng => FAIL CLOSED:\n' + r.stdout);
  assert.match(r.stdout, /STATE_INVALID/);
});

test('S5 E2: assembled CSV tồn tại nhưng hỏng -> FAIL CLOSED STATE_INVALID (không fallback im lặng sang shards)', () => {
  const r = wdRun([wdFixture((sb) => fs.writeFileSync(path.join(sb, 'data', 'content-matrix.csv'),
    'wrong,header\nx,y\n'))]);
  assert.strictEqual(r.status, 1, 'assembled hỏng => FAIL CLOSED, không âm thầm dùng shards:\n' + r.stdout);
  assert.match(r.stdout, /STATE_INVALID/);
});

test('S5 F: thiếu checkpoint.json -> FAIL CLOSED STATE_MISSING (không fallback {active:false})', () => {
  const r = wdRun([wdFixture((sb) => fs.rmSync(path.join(sb, 'data', 'state', 'checkpoint.json')))]);
  assert.strictEqual(r.status, 1, 'checkpoint thiếu => FAIL CLOSED:\n' + r.stdout);
  assert.match(r.stdout, /STATE_MISSING/);
  assert.match(r.stdout, /checkpoint\.json/);
});

test('S5 G: transaction.json JSON hỏng -> FAIL CLOSED STATE_INVALID', () => {
  const r = wdRun([wdFixture((sb) => fs.writeFileSync(path.join(sb, 'data', 'state', 'transaction.json'), '{ broken'))]);
  assert.strictEqual(r.status, 1, 'tx hỏng => FAIL CLOSED:\n' + r.stdout);
  assert.match(r.stdout, /STATE_INVALID/);
});

test('S5 G2: transaction.json sai schema tối thiểu -> FAIL CLOSED STATE_INVALID', () => {
  const r = wdRun([wdFixture((sb) => fs.writeFileSync(path.join(sb, 'data', 'state', 'transaction.json'), '{}'))]);
  assert.strictEqual(r.status, 1, 'tx thiếu `active` boolean => FAIL CLOSED:\n' + r.stdout);
  assert.match(r.stdout, /STATE_INVALID/);
});

test('S5 H: thiếu writer-lock.json -> FAIL CLOSED STATE_MISSING', () => {
  const r = wdRun([wdFixture((sb) => fs.rmSync(path.join(sb, 'data', 'state', 'writer-lock.json')))]);
  assert.strictEqual(r.status, 1, 'writer-lock thiếu => FAIL CLOSED:\n' + r.stdout);
  assert.match(r.stdout, /STATE_MISSING/);
});

test('S5 H2: throughput-ledger.json hỏng -> FAIL CLOSED STATE_INVALID', () => {
  const r = wdRun([wdFixture((sb) => fs.writeFileSync(path.join(sb, 'data', 'state', 'throughput-ledger.json'), 'not json'))]);
  assert.strictEqual(r.status, 1, 'ledger hỏng => FAIL CLOSED:\n' + r.stdout);
  assert.match(r.stdout, /STATE_INVALID/);
});

test('S5 K: stale committed drafts -> STALE_DRAFTS WARN (exit 2); draft row hợp lệ -> PASS', () => {
  const ok = wdRun([wdFixture()]);
  assert.strictEqual(ok.status, 0, 'không có _drafts là bình thường:\n' + ok.stdout);
  const pub = wdRun([wdFixture((sb) => {
    fs.mkdirSync(path.join(sb, '_drafts'), { recursive: true });
    fs.writeFileSync(path.join(sb, '_drafts', 'A00005.html'), '<h1>stale published</h1>');
  })]);
  assert.strictEqual(pub.status, 2, 'draft trỏ row PUBLISHED phải WARN (không FAIL):\n' + pub.stdout);
  assert.match(pub.stdout, /STALE_DRAFTS/);
  const weird = wdRun([wdFixture((sb) => {
    fs.mkdirSync(path.join(sb, '_drafts'), { recursive: true });
    fs.writeFileSync(path.join(sb, '_drafts', 'A99999.body.html'), '<h1>weird id</h1>');
  })]);
  assert.strictEqual(weird.status, 2, 'draft id lạ phải WARN:\n' + weird.stdout);
  assert.match(weird.stdout, /STALE_DRAFTS/);
  const fresh = wdRun([wdFixture((sb) => {
    fs.mkdirSync(path.join(sb, '_drafts'), { recursive: true });
    fs.writeFileSync(path.join(sb, '_drafts', 'A00002.html'), '<h1>fresh research row</h1>');
  })]);
  assert.strictEqual(fresh.status, 0, 'draft id RESEARCH hợp lệ => PASS:\n' + fresh.stdout);
});

test('S5 J: watchdog KHÔNG đổi byte nào trong cây nó đọc (read-only tuyệt đối)', () => {
  const sb = wdFixture();
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const q = path.join(d, e.name);
    return e.isDirectory() ? walk(q) : [q];
  });
  const fp = () => walk(sb).map((f) =>
    require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex')).join('.');
  const before = fp();
  const r = wdRun([sb]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(before, fp(), 'watchdog phải byte-identical toàn bộ cây sau khi chạy');
  assert.ok(!fs.existsSync(path.join(sb, 'data', 'content-matrix.csv')),
    'watchdog KHÔNG được ghi assembled CSV xuống production tree');
});

test('S5 static: watchdog source có canonical-shard loader, fail-closed, và KHÔNG có lệnh ghi/mutate nào', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'factory', 'liveness-watchdog.js'), 'utf8');
  assert.match(src, /loadCanonicalMatrix/, 'phải có canonical matrix loader riêng');
  assert.match(src, /content-matrix\.csv\.part/, 'phải đọc canonical shards');
  assert.match(src, /STATE_MISSING/);
  assert.match(src, /STATE_INVALID/);
  assert.ok(!/fs\.(writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|mkdir|mkdirSync|truncate|open|openSync)\s*\(/.test(src),
    'watchdog là READ-ONLY: không được có bất kỳ lệnh ghi/xóa nào');
  assert.ok(!/git\s+push/.test(src), 'watchdog không được push');
});

test('S5 static: watchdog chạy trong production smoke — KHÔNG ghi/mutate, KHÔNG workflow riêng', () => {
  // workflow watchdog riêng đã retire (cùng các tier CI) — watchdog giờ chạy
  // bên trong factory-production.yml smoke; tính read-only của nó nằm ở source
  // (assertions ở test "S5 static: watchdog source..." phía trên) và ở việc
  // smoke KHÔNG commit gì trước khi watchdog chạy.
  const y = wfText('factory-production.yml');
  assert.match(y, /liveness-watchdog\.js/, 'smoke phải chạy watchdog');
  assert.ok(!/git push|git commit/.test(y.split('Light smoke')[1].split('Commit + push')[0]),
    'đoạn smoke (chứa watchdog) không được commit/push');
  assert.ok(!/push --force|push -f/.test(y), 'không force push');
});

test('S5 static: hot loop NHẸ — không soak, không test-suite, không capacity-check, không editorial-audit', () => {
  // workflow soak riêng đã retire (cùng các tier CI). Suite soak vẫn tồn tại
  // như battery dài hạn CHẠY TRỰC TIẾP (local/CI-optional), nhưng KHÔNG BAO
  // GIỜ chạy trong factory-production.yml hot loop; engine changes không
  // trigger gì thêm vì chỉ còn đúng một workflow duy nhất.
  assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'soak', 'factory-soak.js')),
    'suite soak phải tồn tại (battery dài hạn, chạy trực tiếp)');
  const y = wfText('factory-production.yml');
  assert.doesNotMatch(y, /factory-soak/, 'hot loop không chạy soak');
  assert.doesNotMatch(y, /node --test/, 'hot loop không chạy test-suite');
  assert.doesNotMatch(y, /capacity-check/, 'hot loop không chạy capacity-check');
  assert.doesNotMatch(y, /editorial-audit/, 'hot loop không chạy editorial-audit');
});

test('S5 static: factory-production giữ global serialization lab-factory-production, cancel=false, không force push', () => {
  const y = wfText('factory-production.yml');
  assert.match(y, /group:\s*lab-factory-production/);
  assert.match(y, /cancel-in-progress:\s*false/);
  assert.ok(!/lab-factory-production-\$\{\{/.test(y), 'operator group phải là global, không per-ref');
  assert.ok(!/push --force|push -f/.test(y), 'operator không force push');
});

test('S5 docs contract: canonical matrix = shards, watchdog fail-closed, Tier 4 chạy cả push main', () => {
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  const factoryDoc = fs.readFileSync(path.join(ROOT, 'docs', 'CONTENT-FACTORY.md'), 'utf8');
  const proc = fs.readFileSync(path.join(ROOT, 'docs', 'PROC-PUBLISH.md'), 'utf8');
  const recovery = fs.readFileSync(path.join(ROOT, 'docs', 'PROC-RECOVERY.md'), 'utf8');
  // Sửa drift: không còn nói mơ hồ "All tools auto-assemble on load"
  assert.ok(!/All tools auto-assemble on load/.test(factoryDoc),
    'CONTENT-FACTORY không được nói "All tools auto-assemble on load" nếu không đúng — phải ghi chính xác từng tool');
  assert.ok(!/Any tool .*auto-assembles on load and rewrites shards on save/.test(agents),
    'AGENTS không được ghép chung mọi tool vào một hành vi assemble/rewrite');
  for (const [name, t] of [['AGENTS.md', agents], ['docs/CONTENT-FACTORY.md', factoryDoc]]) {
    assert.match(t, /canonical (form|committed form|matrix)[^.]*shard|shards?[^.]*canonical/i,
      name + ' phải ghi canonical matrix = shards');
    assert.match(t, /fails?[\s-]?closed/i, name + ' phải ghi watchdog fail closed khi canonical truth thiếu/hỏng');
    assert.match(t, /STATE_MISSING|STATE_INVALID/, name + ' phải ghi tên finding deterministic của fail-closed');
  }
  for (const [name, t] of [['AGENTS.md', agents], ['docs/PROC-PUBLISH.md', proc], ['docs/PROC-RECOVERY.md', recovery]]) {
    assert.match(t, /Tier 4/i, name + ' phải ghi Tier 4');
    assert.match(t, /push[^.]*main|main[^.]*push/i, name + ' phải ghi Tier 4 chạy cả trên push vào main (path-relevant), không chỉ PR');
    assert.match(t, /liveness|watchdog/i, name + ' phải nhắc liveness/watchdog');
  }
  assert.match(proc, /CI green[^\n]*liveness|liveness[^\n]*CI green/i,
    'PROC-PUBLISH phải ghi rõ: CI green KHÔNG đồng nghĩa liveness green nếu Tier 4 chưa chạy');
});

test('cleanup: remove hardening session 5 sandboxes', () => {
  fs.rmSync(WS5, { recursive: true, force: true });
  fs.rmSync(WS5_REPO, { recursive: true, force: true });
});

// =====================================================================
// SIMPLE PRODUCTION MODE — vanchinh-style hot path (FAST must be FAST).
// The normal content loop is FETCH -> RECOVER -> RESUME -> NEXT 2 ->
// RESEARCH -> WRITE -> WRAP -> QA FAST -> REPAIR -> PUBLISH -> PUSH ->
// CI/PAGES -> NEXT 2. These regressions prove the loop no longer pays for
// whole-engine verification per micro-op while every hard safety gate
// (atomic publish, rollback, QA evidence, critical failures, draft
// isolation, PASS 75 / REVIEW 70) stays exactly as hard as before.
// =====================================================================
const SB7 = path.join(os.tmpdir(), 'lab-simple-prod-' + process.pid);
const sb7Copy = () => {
  fs.rmSync(SB7, { recursive: true, force: true });
  fs.cpSync(ROOT, SB7, { recursive: true, filter: (s) => {
    const rel = path.relative(ROOT, s);
    return rel !== '_drafts' && !rel.startsWith('_drafts' + path.sep)
      && !path.basename(s).startsWith('content-matrix.csv.part');
  } });
};
const OPmod7 = require(path.join(ROOT, 'scripts', 'factory', 'operator.js'));
const stepStr7 = st => st.join(' ');
const csv7 = () => fs.readFileSync(path.join(SB7, 'data', 'content-matrix.csv'), 'utf8');
const ck7 = () => JSON.parse(fs.readFileSync(path.join(SB7, 'data', 'state', 'checkpoint.json'), 'utf8'));

test('simple-prod: FAST verify steps never run test-suite / capacity-check / editorial-audit / build', () => {
  const fastSets = [OPmod7.verifySteps('fast'),
                    OPmod7.verifySteps('fast', ['A00015', 'A00016']),
                    OPmod7.verifyStepsStaged('fast', 'TX-1', ['A00015'])];
  for (const steps of fastSets) {
    for (const st of steps) {
      const s = stepStr7(st);
      assert.ok(!/--test/.test(s), 'FAST must not run the full test-suite: ' + s);
      assert.ok(!/capacity-check/.test(s), 'FAST must not run capacity-check: ' + s);
      assert.ok(!/editorial-audit/.test(s), 'FAST must not run editorial-audit: ' + s);
      assert.ok(!/build-site/.test(s), 'FAST verify must not rebuild the whole site: ' + s);
    }
  }
  // FAST scope = exactly the CURRENT working scope (chunk / selected ids /
  // staged tx) — never a full historical audit.
  assert.match(stepStr7(OPmod7.verifySteps('fast')[0]), /consistency --chunk/);
  assert.match(stepStr7(OPmod7.verifySteps('fast', ['A00015', 'A00016'])[0]), /consistency --ids A00015,A00016/);
  const stagedFast = OPmod7.verifyStepsStaged('fast', 'TX-1', ['A00015', 'A00016']).map(stepStr7);
  assert.ok(stagedFast.some(s => /consistency --staged-tx TX-1/.test(s)), 'FAST publish keeps STAGED consistency');
  assert.ok(stagedFast.some(s => /grounding A00015 A00016/.test(s)), 'FAST publish keeps selected-ID grounding');
});
test('simple-prod: DEEP still runs test-suite + capacity + editorial; FULL adds full grounding + rebuild', () => {
  const deep = OPmod7.verifySteps('deep').map(stepStr7).join(' | ');
  assert.match(deep, /--test tests\/test-suite\.js/, 'DEEP must keep the static suite');
  assert.match(deep, /capacity-check/, 'DEEP must keep capacity-check');
  assert.match(deep, /editorial-audit/, 'DEEP must keep editorial-audit');
  const stagedDeep = OPmod7.verifyStepsStaged('deep', 'TX-1', ['A00015']).map(stepStr7).join(' | ');
  assert.match(stagedDeep, /capacity-check\.js --staged-tx TX-1/, 'DEEP publish keeps staged capacity-check');
  assert.match(stagedDeep, /editorial-audit/, 'DEEP publish keeps editorial-audit');
  const full = OPmod7.verifySteps('full').map(stepStr7).join(' | ');
  assert.match(full, /--test tests\/test-suite\.js/);
  assert.match(full, /grounding/);
  assert.match(full, /build-site/);
});
test('simple-prod: FAST prepare-next / research / qa succeed even while test-suite, capacity-check and editorial-audit would FAIL (they are not in the fast path)', () => {
  sb7Copy();
  // Sabotage the heavy gates. If FAST still ran any of them, these ops fail.
  for (const rel of ['tests/test-suite.js', 'scripts/factory/capacity-check.js', 'scripts/factory/editorial-audit.js']) {
    const p = path.join(SB7, rel);
    fs.writeFileSync(p, 'process.exit(1);\n' + fs.readFileSync(p, 'utf8'));
  }
  // NEXT 2 — the standard production pair (the FIRST two PLANNED rows)
  const plannedOf7 = () => csv7().split('\n').slice(1).filter(x => x.trim())
    .map(l => parseLine4(l)).filter(c => c[24] === 'PLANNED').map(c => c[0]);
  const expectedPair = plannedOf7().slice(0, 2);
  let r = OP(['prepare-next', '--count', '2'], SB7);
  assert.strictEqual(r.status, 0, 'FAST prepare-next must never run the sabotaged suite:\nSTDOUT ' + r.stdout + '\nSTDERR ' + r.stderr);
  assert.match(r.stdout, /VERIFY PASS \(scope=fast\)/);
  const pair = ck7().active_chunk;
  assert.strictEqual(pair.length, 2, 'the standard chunk is a 2-article pair');
  assert.deepStrictEqual(pair, expectedPair, 'claims exactly the first two PLANNED rows in repository order');
  // RESEARCH — light packet per the row contract (requires_official_sources=0)
  for (const id of pair) {
    fs.writeFileSync(path.join(SB7, 'data', 'research', id + '.json'), JSON.stringify({
      article_id: id, primary_keyword: 'thue xe may ' + id, search_intent: 'informational',
      research_date: '2026-09-30', questions_found: ['q1'], official_sources: [],
      supporting_sources: [], unique_angle: 'sandbox light packet' }));
  }
  r = OP(['research', '--ids', pair.join(',')], SB7);
  assert.strictEqual(r.status, 0, 'FAST research must never run the sabotaged suite:\nSTDOUT ' + r.stdout + '\nSTDERR ' + r.stderr);
  assert.match(r.stdout, /VERIFY PASS \(scope=fast\)/);
  // QA FAST — drafts exist; scores may land wherever they land (repair path is
  // part of the loop); the op must complete WITHOUT the heavy gates.
  for (const id of pair) {
    fs.mkdirSync(path.join(SB7, '_drafts'), { recursive: true });
    fs.writeFileSync(path.join(SB7, '_drafts', id + '.html'),
      '<h1>x</h1><p>Giới thiệu nội dung kiểm thử cho quy trình sản xuất đơn giản.</p>');
  }
  r = OP(['qa', '--ids', pair.join(',')], SB7);
  assert.strictEqual(r.status, 0, 'FAST qa must never run the sabotaged suite:\nSTDOUT ' + r.stdout + '\nSTDERR ' + r.stderr);
  assert.match(r.stdout, /VERIFY PASS \(scope=fast\)/);
  // engine truth moved exactly as the loop expects: RESEARCH -> WRITING -> QA/REPAIR
  const states = {};
  for (const l of csv7().split('\n').slice(1).filter(x => x.trim())) {
    const c = parseLine4(l);
    if (pair.includes(c[0])) states[c[0]] = c[24];
  }
  for (const id of pair) assert.match(states[id], /^(QA|REVIEW|REPAIR|PASS|BLOCKED)$/, id + ' must be scored (got ' + states[id] + ')');
});
test('simple-prod: FAST publish stays ATOMIC and is NOT blocked by editorial-audit; DEEP publish still is', () => {
  sb7Copy();
  // a PASS pair with hash-bound evidence (the wrap+qa outcome of the loop)
  const shaOf = s => require('crypto').createHash('sha256').update(s).digest('hex');
  const html = id => '<header class="site-head"><nav class="menu"><a href="/lab/">Trang chủ</a></nav></header>\n<main><h1>Bài ' + id + '</h1><p>Nội dung kiểm thử deterministic cho quy trình atomic publish của bài ' + id + ' theo đường sản xuất đơn giản hai bài mỗi lượt.</p></main>\n<footer class="site-foot"><p>Chân trang kiểm thử.</p></footer>';
  // the first two PLANNED rows (production truth moves forward over time)
  const pair = csv7().split('\n').slice(1).filter(x => x.trim())
    .map(l => parseLine4(l)).filter(c => c[24] === 'PLANNED').map(c => c[0]).slice(0, 2);
  const lines = csv7().split('\n');
  const out = [lines[0]];
  for (const l of lines.slice(1).filter(x => x.trim())) {
    const c = parseLine4(l);
    if (pair.includes(c[0])) { c[24] = 'PASS'; c[26] = '100'; }
    out.push(c.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','));
  }
  fs.writeFileSync(path.join(SB7, 'data', 'content-matrix.csv'), out.join('\n'));
  fs.mkdirSync(path.join(SB7, '_drafts'), { recursive: true });
  fs.mkdirSync(path.join(SB7, 'data', 'qa'), { recursive: true });
  for (const id of pair) {
    const h = html(id);
    fs.writeFileSync(path.join(SB7, '_drafts', id + '.html'), h);
    fs.writeFileSync(path.join(SB7, '_drafts', id + '.body.html'), '<h1>B ' + id + '</h1>');
    fs.writeFileSync(path.join(SB7, 'data', 'qa', id + '.json'),
      JSON.stringify({ article_id: id, score: 100, words: 30, result: 'PASS', fails: [], draft_sha256: shaOf(h), matrix_status_after: 'PASS' }));
  }
  // sabotage editorial-audit + capacity-check: FAST must not care
  for (const rel of ['scripts/factory/editorial-audit.js', 'scripts/factory/capacity-check.js']) {
    const p = path.join(SB7, rel);
    fs.writeFileSync(p, 'process.exit(1);\n' + fs.readFileSync(p, 'utf8'));
  }
  const auditBefore = fs.readFileSync(path.join(SB7, 'reports', 'editorial', 'audit-after.json'), 'utf8');
  const r = OP(['publish', '--ids', pair.join(','), '--scope', 'fast'], SB7);
  assert.strictEqual(r.status, 0, 'editorial-audit must NOT block a normal FAST publish:\nSTDOUT ' + r.stdout + '\nSTDERR ' + r.stderr);
  assert.match(r.stdout, new RegExp('PUBLISHED \\(atomic, build\\+verify PASS\\) 2: ' + pair.join(', ')));
  // atomic truth: rows PUBLISHED, drafts removed, exactly one ledger event, tx/lock clean
  const states = {};
  for (const l of csv7().split('\n').slice(1).filter(x => x.trim())) {
    const c = parseLine4(l);
    if (pair.includes(c[0])) states[c[0]] = c[24];
  }
  assert.deepStrictEqual(states, Object.fromEntries(pair.map(id => [id, 'PUBLISHED'])));
  for (const id of pair) {
    assert.ok(!fs.existsSync(path.join(SB7, '_drafts', id + '.html')), 'draft removed at commit');
    assert.ok(!fs.existsSync(path.join(SB7, '_drafts', id + '.body.html')), 'body draft removed at commit');
    assert.ok(fs.existsSync(path.join(SB7, 'data', 'published', id + '.html')), 'durable archive written');
  }
  const ledger = JSON.parse(fs.readFileSync(path.join(SB7, 'data', 'state', 'throughput-ledger.json'), 'utf8'));
  const events = ledger.events.filter(e => e.op === 'publish' && JSON.stringify(e.ids) === JSON.stringify(pair));
  assert.strictEqual(events.length, 1, 'exactly one real publish event');
  const tx = JSON.parse(fs.readFileSync(path.join(SB7, 'data', 'state', 'transaction.json'), 'utf8'));
  assert.strictEqual(tx.active, false, 'transaction cleared after commit');
  // sitemap sanity for the staged ids (public surface)
  for (const id of pair) {
    const row = (function(){ for (const l of csv7().split('\n').slice(1).filter(x=>x.trim())) { const c=parseLine4(l); if (c[0]===id) return { out: c[22], canon: c[23] }; } return null; })();
    assert.ok(fs.existsSync(path.join(SB7, row.out.replace(/^\//,''), 'index.html')), 'public page promoted for ' + id);
    assert.ok(fs.readdirSync(SB7).filter(f=>/^sitemap-.*\.xml$/.test(f)&&f!=='sitemap-index.xml')
      .some(f=>fs.readFileSync(path.join(SB7,f),'utf8').includes(row.canon)), 'canonical in sitemap for ' + id);
  }
  // FAST publish does NOT regenerate the editorial report (deep/full artifact)
  assert.strictEqual(auditBefore, fs.readFileSync(path.join(SB7, 'reports', 'editorial', 'audit-after.json'), 'utf8'),
    'FAST publish must not run the editorial audit');
  // DEEP still gates: with editorial-audit sabotaged, a deep publish rolls back.
  // (The next PLANNED row becomes the probe; restore capacity sabotage only for the probe row.)
  const probe = csv7().split('\n').slice(1).filter(x => x.trim())
    .map(l => parseLine4(l)).find(c => c[24] === 'PLANNED')[0];
  const h17 = html(probe);
  const lines2 = csv7().split('\n');
  const out2 = [lines2[0]];
  for (const l of lines2.slice(1).filter(x => x.trim())) {
    const c = parseLine4(l);
    if (c[0] === probe) { c[24] = 'PASS'; c[26] = '100'; }
    out2.push(c.map(v => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join(','));
  }
  fs.writeFileSync(path.join(SB7, 'data', 'content-matrix.csv'), out2.join('\n'));
  fs.writeFileSync(path.join(SB7, '_drafts', probe + '.html'), h17);
  fs.writeFileSync(path.join(SB7, 'data', 'qa', probe + '.json'),
    JSON.stringify({ article_id: probe, score: 100, words: 30, result: 'PASS', fails: [], draft_sha256: shaOf(h17), matrix_status_after: 'PASS' }));
  const rd = OP(['publish', '--ids', probe, '--scope', 'deep'], SB7);
  assert.notStrictEqual(rd.status, 0, 'DEEP publish must still fail when editorial-audit fails');
  assert.match(rd.stderr, /NOT committed|Rolling back/);
  let st17 = null;
  for (const l of csv7().split('\n').slice(1).filter(x => x.trim())) { const c = parseLine4(l); if (c[0] === probe) st17 = c[24]; }
  assert.strictEqual(st17, 'PASS', 'rolled back to pre-publish truth');
  assert.ok(fs.existsSync(path.join(SB7, '_drafts', probe + '.html')), 'draft intact after rollback');
  assert.ok(!fs.existsSync(path.join(SB7, 'data', 'published', probe + '.html')), 'staged archive removed by rollback');
});
test('simple-prod: ONE lightweight production path — factory-production.yml is the only workflow and its hot loop stays light', () => {
  // single-workflow architecture: ci-validate/factory-validate/capacity-
  // validate were retired — the ONLY workflow left is factory-production.yml,
  // and its hot loop must stay light (the publish op itself runs the staged
  // consistency + selected-ID grounding internally).
  assert.ok(!fs.existsSync(path.join(ROOT, '.github', 'workflows', 'ci-validate.yml')), 'ci-validate.yml must stay retired');
  assert.ok(!fs.existsSync(path.join(ROOT, '.github', 'workflows', 'factory-validate.yml')), 'factory-validate.yml must stay retired');
  assert.ok(!fs.existsSync(path.join(ROOT, '.github', 'workflows', 'factory-capacity-validate.yml')), 'factory-capacity-validate.yml must stay retired');
  const y = wfText('factory-production.yml').replace(/^\s*#.*$/gm, ''); // strip comments: assert on EXECUTED steps only
  assert.ok(!/node --test/.test(y), 'the hot loop must not run the full test-suite');
  assert.ok(!/capacity-check/.test(y), 'the hot loop must not run capacity-check');
  assert.ok(!/editorial-audit/.test(y), 'the hot loop must not run editorial-audit');
  assert.ok(!/factory-soak/.test(y), 'the hot loop must not run soak');
  assert.match(y, /factory\.js consistency/, 'the smoke keeps scoped consistency');
  assert.match(y, /liveness-watchdog\.js/, 'the smoke keeps liveness');
  assert.match(y, /operator\.js publish --ids/, 'publish goes through the operator (staged consistency + grounding inside)');
});
test('simple-prod: rubric stays owner-approved (PASS >= 75, REVIEW 70–74) — never 90, never lowered', () => {
  const rub = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'article-rubric.json'), 'utf8'));
  assert.strictEqual(rub.pass_min, 75);
  assert.strictEqual(rub.review_min, 70);
  assert.strictEqual(rub.max_repair_attempts, 3);
});
test('cleanup: remove simple-prod sandbox', () => { fs.rmSync(SB7, { recursive: true, force: true }); });
