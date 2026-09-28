/** shell.js — canonical premium editorial shell (header, footer, buttons, article chrome).
 * Shared by scripts/site/build-site.js and scripts/factory/wrap-drafts.js so every
 * generated page consumes the same markup. Child hub URLs are stable and never change. */
'use strict';

// IA layer: 4 parent groups over the 8 existing child hubs. No new URLs are created.
const GROUPS = [
  { id: 'thue-xe-hanh-trinh', label: 'Thuê xe & Hành trình', desc: 'Thuê xe máy và kinh nghiệm di chuyển bằng xe hai bánh.', children: [
    { slug: 'thue-xe-may', nav: 'Thuê xe máy', icon: '🏍️', desc: 'Giá, thủ tục và kinh nghiệm thuê xe' },
    { slug: 'kinh-nghiem', nav: 'Kinh nghiệm', icon: '🧭', desc: 'Lái xe an toàn, vận hành dài hạn' } ] },
  { id: 'cuu-ho-bao-duong', label: 'Cứu hộ & Bảo dưỡng', desc: 'Xử lý sự cố trên đường và giữ xe luôn tốt.', children: [
    { slug: 'cuu-ho-xe-may', nav: 'Cứu hộ', icon: '🆘', desc: 'Chọn cứu hộ nhanh, an toàn khi sự cố' },
    { slug: 'sua-xe-may', nav: 'Sửa chữa & bảo dưỡng', icon: '🔧', desc: 'Bảo dưỡng định kỳ, sửa chữa xe máy' } ] },
  { id: 'phap-ly-giay-to', label: 'Pháp lý & Giấy tờ', desc: 'Giấy phép lái xe và thủ tục đăng ký xe máy.', children: [
    { slug: 'bang-lai-xe-may', nav: 'Bằng lái', icon: '📜', desc: 'Thi bằng A1, đổi và cấp lại GPLX' },
    { slug: 'dang-ky-xe-may', nav: 'Đăng ký xe', icon: '🏷️', desc: 'Đăng ký, sang tên, lệ phí, biển số' } ] },
  { id: 'xe-dien-phu-tung', label: 'Xe điện & Phụ tùng', desc: 'Xe máy điện và phụ tùng, linh kiện thay thế.', children: [
    { slug: 'xe-may-dien', nav: 'Xe máy điện', icon: '⚡', desc: 'Giá, pin, trạm sạc, chi phí xe điện' },
    { slug: 'phu-tung', nav: 'Phụ tùng', icon: '⚙️', desc: 'Lốp, ắc quy, bugi, nhông xích, dầu' } ] },
];
const BRAND_FULL = 'Bản Đồ Xe 2 Bánh Việt Nam';
const BRAND_SHORT = 'Bản Đồ Xe 2 Bánh';
const EYEBROW = 'CẨM NANG XE 2 BÁNH VIỆT NAM';

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const groupOf = slug => GROUPS.find(g => g.children.some(c => c.slug === slug)) || null;

function headerHtml() {
  const groups = GROUPS.map(g => `
    <div class="nav-group" data-hub="${g.id}">
      <button class="nav-drop" type="button" aria-expanded="false" aria-controls="dd-${g.id}">${esc(g.label)}<span class="chev" aria-hidden="true">▾</span></button>
      <div class="dropdown glass-menu" id="dd-${g.id}" role="group" aria-label="${esc(g.label)}">
        ${g.children.map(c => `<a class="dd-link" data-hub="${g.id}" href="/lab/${c.slug}/"><span class="dd-title"><span class="dd-icon" aria-hidden="true">${c.icon}</span>${esc(c.nav)}</span><span class="dd-desc">${esc(c.desc)}</span></a>`).join('')}
      </div>
    </div>`).join('');
  const drawer = GROUPS.map(g => `
    <div class="dr-group">
      <p class="dr-label">${esc(g.label.toUpperCase())}</p>
      ${g.children.map(c => `<a class="dr-link" data-hub="${g.id}" href="/lab/${c.slug}/"><span class="dd-icon" aria-hidden="true">${c.icon}</span>${esc(c.nav)}</a>`).join('')}
    </div>`).join('');
  return `<header class="site-head">
<div class="wrap nav-shell glass-nav">
  <a class="brand" href="/lab/">${BRAND_SHORT}</a>
  <nav class="main-nav" aria-label="Chuyên mục chính">${groups}
    <a class="nav-link" href="/lab/ve-chung-toi/">Giới thiệu</a>
    <a class="nav-link" href="/lab/lien-he/">Liên hệ</a>
  </nav>
  <div class="nav-actions">
    <a class="btn-icon" href="/lab/#q" aria-label="Tìm bài viết" title="Tìm bài viết"><span aria-hidden="true">🔎</span></a>
    <button class="btn-icon menu-toggle" type="button" aria-expanded="false" aria-controls="drawer" aria-label="Mở menu"><span aria-hidden="true">☰</span></button>
  </div>
</div>
<div class="drawer glass-menu" id="drawer" role="dialog" aria-modal="true" aria-label="Menu chuyên mục" hidden>
  <div class="drawer-head">
    <span class="dr-brand">${BRAND_SHORT}</span>
    <button class="btn-icon drawer-close" type="button" aria-label="Đóng menu"><span aria-hidden="true">✕</span></button>
  </div>
  <nav class="drawer-nav" aria-label="Chuyên mục">${drawer}</nav>
  <div class="drawer-foot">
    <a class="dr-link" href="/lab/ve-chung-toi/">Giới thiệu</a>
    <a class="dr-link" href="/lab/lien-he/">Liên hệ</a>
  </div>
</div>
</header>`;
}

function footerHtml(facts) {
  const groupCol = g => `<p class="foot-label">${esc(g.label.toUpperCase())}</p>
<ul class="foot-links">${g.children.map(c => `<li><a href="/lab/${c.slug}/">${esc(c.nav)}</a></li>`).join('')}</ul>`;
  return `<footer class="site-foot"><div class="wrap">
<div class="foot-shell glass-footer">
  <div class="foot-grid">
    <div class="foot-col foot-brand-col">
      <p class="foot-brand">${BRAND_FULL}</p>
      <p class="foot-desc">Cẩm nang xe máy, xe điện và hệ sinh thái xe hai bánh Việt Nam.</p>
      <ul class="foot-links">
        <li><a href="/lab/">Trang chủ</a></li>
        <li><a href="/lab/ve-chung-toi/">Giới thiệu</a></li>
        <li><a href="/lab/lien-he/">Liên hệ</a></li>
      </ul>
    </div>
    <div class="foot-col">${groupCol(GROUPS[0])}${groupCol(GROUPS[1])}</div>
    <div class="foot-col">${groupCol(GROUPS[2])}${groupCol(GROUPS[3])}</div>
    <div class="foot-col">
      <p class="foot-label">KHÁM PHÁ</p>
      <ul class="foot-links">
        <li><a href="/lab/#q">Tìm bài viết</a></li>
        <li><a href="/lab/sitemap-index.xml">Sitemap</a></li>
        <li><a href="/lab/ve-chung-toi/">Về chúng tôi</a></li>
        <li><a href="/lab/lien-he/">Liên hệ</a></li>
      </ul>
    </div>
  </div>
  <div class="foot-bottom">
    <p>© ${new Date().getFullYear()} ${BRAND_FULL} · ${esc(facts.business_name)} — ${esc(facts.location_summary)}</p>
    <p class="fine">Trang thông tin nghiên cứu về hệ sinh thái xe hai bánh Việt Nam. Không phải trang dịch vụ toàn quốc.</p>
  </div>
  <button class="to-top" id="to-top" type="button" aria-label="Lên đầu trang" title="Lên đầu trang">↑</button>
</div>
</div></footer>`;
}

/** Article chrome shared by build-site (published restore) and wrap-drafts.
 * Wraps breadcrumb + H1 + lead + postmeta in a premium article hero, adds a
 * category chip, a deterministic TOC, and appends related / hub-CTA / prev-next
 * blocks before </main>. Purely visual wrappers: canonical, schema and body
 * text are untouched. inner = full page HTML; returns full page HTML. */
function decorateArticle(inner, opt) {
  // opt: { category, hubSlug, hubTitle, groupLabel, related:[{href,title,meta,category,hubSlug}], prev, next, readingMin }
  const m = inner.match(/^([\s\S]*?)(<main[^>]*>)([\s\S]*?)(<\/main>)([\s\S]*)$/);
  if (!m) return inner;
  const [, head, open, bodyMain, close, tail] = m;
  const bm = bodyMain.match(/<nav class="breadcrumb">[\s\S]*?<\/nav>/);
  if (!bm) return inner;
  const pm = bodyMain.match(/<p class="postmeta">[\s\S]*?<\/p>/);
  const before = bodyMain.slice(0, bm.index);
  let after = bodyMain.slice(bm.index + bm[0].length).replace(pm ? pm[0] : '', '');
  const h1m = after.match(/<h1[\s\S]*?<\/h1>/);
  let rest = after, h1 = '', lead = '';
  if (h1m) {
    h1 = h1m[0];
    rest = after.slice(h1m.index + h1m[0].length);
    const leadm = rest.match(/^\s*<p[\s\S]*?<\/p>/);
    if (leadm) { lead = `<p class="article-lead">${leadm[0].slice(3, -4)}</p>`; rest = rest.slice(leadm[0].length); }
  }
  // deterministic TOC from H2/H3 with generated ids
  const heads = [];
  rest = rest.replace('<strong>Trả lời nhanh:</strong>', '<strong class="quick-label">Trả lời nhanh:</strong>');
  rest = rest.replace(/<(h[23])>([^<]+)<\/\1>/g, (all, tag, txt) => {
    const id = 'sec-' + (heads.length + 1);
    heads.push({ id, tag, txt: txt.trim() });
    return `<${tag} id="${id}">${txt}</${tag}>`;
  });
  const toc = heads.length >= 3 ? `\n<details class="toc glass" open>
<summary>Trong bài này</summary>
<ol class="toc-list">${heads.map(h => h.tag === 'h2'
  ? `<li><a href="#${h.id}">${esc(h.txt)}</a></li>`
  : `<li class="toc-sub"><a href="#${h.id}">${esc(h.txt)}</a></li>`).join('')}</ol>
</details>` : '';
  const related = (opt.related || []).length ? `\n<section class="related" aria-labelledby="related-h">
<h2 class="section-label" id="related-h">Bài liên quan</h2>
<ul class="cards">${opt.related.map(r => `<li class="card"><a class="article-chip" href="/lab/${esc(r.hubSlug)}/">${esc(r.category)}</a><a class="card-title" href="/lab/${esc(r.href)}">${esc(r.title)}</a><p class="meta">${esc(r.meta)}</p></li>`).join('')}</ul>
</section>` : '';
  const hubCta = `\n<section class="article-hub-cta glass" aria-labelledby="hubcta-h">
<h2 class="section-label" id="hubcta-h">Chủ đề của bài viết</h2>
<p class="cta-line">Bài viết thuộc <strong>${esc(opt.category)}</strong> · nhóm <strong>${esc(opt.groupLabel)}</strong>.</p>
<div class="cta-row">
<a class="btn btn-primary" href="/lab/${esc(opt.hubSlug)}/">Xem ${esc(opt.hubTitle)}</a>
<a class="btn btn-secondary" href="/lab/">Khám phá thêm</a>
</div>
</section>`;
  const prev = opt.prev ? `<a class="pn-card glass" href="/lab/${esc(opt.prev.href)}" rel="prev"><span class="pn-label">← Bài trước</span><span class="pn-title">${esc(opt.prev.title)}</span></a>` : '<span class="pn-card empty" aria-hidden="true"></span>';
  const next = opt.next ? `<a class="pn-card glass pn-next" href="/lab/${esc(opt.next.href)}" rel="next"><span class="pn-label">Bài tiếp theo →</span><span class="pn-title">${esc(opt.next.title)}</span></a>` : '<span class="pn-card empty" aria-hidden="true"></span>';
  const pn = (opt.prev || opt.next) ? `\n<nav class="pn-row" aria-label="Điều hướng bài viết">${prev}${next}</nav>` : '';
  const hero = `<header class="article-hero glass-strong">
${bm[0]}
<p class="article-chips"><a class="category-chip" href="/lab/${esc(opt.hubSlug)}/">${esc(opt.category)}</a></p>
${h1}
${lead}
${pm ? pm[0].replace(/<\/p>$/, ` · ~${opt.readingMin || '?'} phút đọc</p>`) : ''}
</header>`;
  return `${head}${open}${before}${hero}${toc}${rest}${related}${hubCta}${pn}${close}${tail}`;
}

module.exports = { GROUPS, BRAND_FULL, BRAND_SHORT, EYEBROW, esc, groupOf, headerHtml, footerHtml, decorateArticle };
