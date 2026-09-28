/** shell.js — canonical premium editorial shell (header, footer, buttons, article chrome).
 * Shared by scripts/site/build-site.js and scripts/factory/wrap-drafts.js so every
 * generated page consumes the same markup. Child hub URLs are stable and never change.
 * Icon system: single inline-SVG set (18–20px, currentColor, stroke 1.8, aria-hidden).
 * Semantics: real destinations are <a>; dropdown/group controls are <button type="button">. */
'use strict';

// IA layer: 4 parent groups over the 8 existing child hubs. No new URLs are created.
const GROUPS = [
  { id: 'thue-xe-hanh-trinh', label: 'Thuê xe & Hành trình', desc: 'Thuê xe máy và kinh nghiệm di chuyển bằng xe hai bánh.', children: [
    { slug: 'thue-xe-may', nav: 'Thuê xe máy', icon: 'motorbike', desc: 'Giá, thủ tục và kinh nghiệm thuê xe' },
    { slug: 'kinh-nghiem', nav: 'Kinh nghiệm', icon: 'compass', desc: 'Lái xe an toàn, vận hành dài hạn' } ] },
  { id: 'cuu-ho-bao-duong', label: 'Cứu hộ & Bảo dưỡng', desc: 'Xử lý sự cố trên đường và giữ xe luôn tốt.', children: [
    { slug: 'cuu-ho-xe-may', nav: 'Cứu hộ', icon: 'life-ring', desc: 'Chọn cứu hộ nhanh, an toàn khi sự cố' },
    { slug: 'sua-xe-may', nav: 'Sửa chữa & bảo dưỡng', icon: 'wrench', desc: 'Bảo dưỡng định kỳ, sửa chữa xe máy' } ] },
  { id: 'phap-ly-giay-to', label: 'Pháp lý & Giấy tờ', desc: 'Giấy phép lái xe và thủ tục đăng ký xe máy.', children: [
    { slug: 'bang-lai-xe-may', nav: 'Bằng lái', icon: 'card', desc: 'Thi bằng A1, đổi và cấp lại GPLX' },
    { slug: 'dang-ky-xe-may', nav: 'Đăng ký xe', icon: 'file-check', desc: 'Đăng ký, sang tên, lệ phí, biển số' } ] },
  { id: 'xe-dien-phu-tung', label: 'Xe điện & Phụ tùng', desc: 'Xe máy điện và phụ tùng, linh kiện thay thế.', children: [
    { slug: 'xe-may-dien', nav: 'Xe máy điện', icon: 'bolt', desc: 'Giá, pin, trạm sạc, chi phí xe điện' },
    { slug: 'phu-tung', nav: 'Phụ tùng', icon: 'gear', desc: 'Lốp, ắc quy, bugi, nhông xích, dầu' } ] },
];
const BRAND_FULL = 'Bản Đồ Xe 2 Bánh Việt Nam';
const BRAND_SHORT = 'Bản Đồ Xe 2 Bánh';
const EYEBROW = 'CẨM NANG XE 2 BÁNH VIỆT NAM';
// Utility destinations (real pages, real anchors)
const INFO_LINKS = [
  { slug: 'lien-he', nav: 'Liên hệ', icon: 'mail', href: '/lab/lien-he/' },
  { slug: 'chinh-sach-bao-mat', nav: 'Chính sách bảo mật', icon: 'shield', href: '/lab/chinh-sach-bao-mat/' },
  { slug: 'dieu-khoan-su-dung', nav: 'Điều khoản sử dụng', icon: 'file-text', href: '/lab/dieu-khoan-su-dung/' },
];
// Main destinations (Trang chủ / Giới thiệu) — consumed by header AND footer.
const MAIN_LINKS = [
  { slug: 'trang-chu', nav: 'Trang chủ', icon: 'home', href: '/lab/' },
  { slug: 've-chung-toi', nav: 'Giới thiệu', icon: 'info', href: '/lab/ve-chung-toi/' },
];
// CANONICAL NAV REGISTRY — the single label+href source for every generated
// link target. Header and footer both resolve through NAV_BY_SLUG, so a second
// hardcoded navigation URL map cannot exist and the two can never drift.
const NAV_BY_SLUG = (() => {
  const m = {};
  GROUPS.forEach(g => g.children.forEach(c => { m[c.slug] = { nav: c.nav, href: '/lab/' + c.slug + '/' }; }));
  INFO_LINKS.forEach(c => { m[c.slug] = { nav: c.nav, href: c.href }; });
  MAIN_LINKS.forEach(c => { m[c.slug] = { nav: c.nav, href: c.href }; });
  m['sitemap-index'] = { nav: 'Sitemap', href: '/lab/sitemap-index.xml' };
  return m;
})();
// Compact footer mini-sitemap layout — slugs only; labels and hrefs are always
// resolved via NAV_BY_SLUG at render time (no duplicate URL data here).
const FOOTER_NAV = [
  { label: 'Khám phá', slugs: ['thue-xe-may', 'kinh-nghiem', 'cuu-ho-xe-may', 'sua-xe-may'] },
  { label: 'Pháp lý & Phương tiện', slugs: ['bang-lai-xe-may', 'dang-ky-xe-may', 'xe-may-dien', 'phu-tung'] },
  { label: 'Thông tin', slugs: ['ve-chung-toi', 'lien-he', 'chinh-sach-bao-mat', 'dieu-khoan-su-dung', 'sitemap-index'] },
];

// ---------- inline SVG icon set (no emoji, no icon font, no external request) ----------
const ICON = {
  home: '<path d="M3 9.5 12 3l9 6.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22v-8h6v8"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  motorbike: '<circle cx="5.5" cy="17.5" r="3"/><circle cx="18.5" cy="17.5" r="3"/><path d="M5.5 17.5h6.5l2.5-7h3.5"/><path d="M9 10.5h4l1.5 4"/><path d="M13 6.5h3l1 4"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/>',
  'life-ring': '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m9.17 14.83-4.24 4.24"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  'file-check': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  'map-pin': '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
};
const svg = (n, size) => `<svg class="ico ico-${size === 'lg' ? 'lg' : 'sm'}" viewBox="0 0 24 24" width="${size === 'lg' ? 20 : 18}" height="${size === 'lg' ? 20 : 18}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const groupOf = slug => GROUPS.find(g => g.children.some(c => c.slug === slug)) || null;

function headerHtml() {
  // desktop dropdown groups (real child anchors; parent = semantic button)
  const groups = GROUPS.map(g => `
    <div class="nav-group" data-hub="${g.id}">
      <button class="nav-drop" type="button" aria-expanded="false" aria-controls="dd-${g.id}">${esc(g.label)}<span class="chev" aria-hidden="true">▾</span></button>
      <div class="dropdown glass-menu" id="dd-${g.id}" role="group" aria-label="${esc(g.label)}">
        ${g.children.map(c => `<a class="dd-link" data-hub="${g.id}" href="/lab/${c.slug}/"><span class="dd-title"><span class="dd-icon">${svg(c.icon)}</span>${esc(c.nav)}</span><span class="dd-desc">${esc(c.desc)}</span></a>`).join('')}
      </div>
    </div>`).join('');
  // "Thông tin" dropdown (utility destinations — real anchors)
  const infoGroup = `
    <div class="nav-group nav-group-info" data-hub="thong-tin">
      <button class="nav-drop" type="button" aria-expanded="false" aria-controls="dd-thong-tin">Thông tin<span class="chev" aria-hidden="true">▾</span></button>
      <div class="dropdown glass-menu" id="dd-thong-tin" role="group" aria-label="Thông tin">
        ${INFO_LINKS.map(c => `<a class="dd-link" data-hub="thong-tin" href="${c.href}"><span class="dd-title"><span class="dd-icon">${svg(c.icon)}</span>${esc(c.nav)}</span><span class="dd-desc">Trang ${esc(c.nav.toLowerCase())}</span></a>`).join('')}
      </div>
    </div>`;
  // mobile drawer: exact utility IA
  const drawerGroups = GROUPS.map(g => `
    <div class="dr-group">
      <p class="dr-label">${esc(g.label.toUpperCase())}</p>
      ${g.children.map(c => `<a class="dr-link" data-hub="${g.id}" href="${NAV_BY_SLUG[c.slug].href}"><span class="dd-icon">${svg(c.icon, 'lg')}</span><span class="dr-text">${esc(c.nav)}</span><span class="dr-arrow" aria-hidden="true">›</span></a>`).join('')}
    </div>`).join('');
  const drMain = MAIN_LINKS.map(c => `<a class="dr-link dr-main-link" href="${c.href}"><span class="dd-icon">${svg(c.icon, 'lg')}</span><span class="dr-text">${esc(c.nav)}</span><span class="dr-arrow" aria-hidden="true">›</span></a>`).join('');
  const drUtility = INFO_LINKS.map(c => `<a class="dr-link" href="${c.href}"><span class="dd-icon">${svg(c.icon, 'lg')}</span><span class="dr-text">${esc(c.nav)}</span><span class="dr-arrow" aria-hidden="true">›</span></a>`).join('');
  return `<a class="skip-link" href="#main-content">Bỏ qua đến nội dung chính</a>
<header class="site-head">
<div class="wrap nav-shell glass-nav">
  <a class="brand" href="/lab/">${BRAND_SHORT}</a>
  <nav class="main-nav" aria-label="Chuyên mục chính">
${MAIN_LINKS.map(c => `    <a class="nav-link" href="${c.href}">${esc(c.nav)}</a>`).join('\n')}
${groups}
    ${infoGroup}
  </nav>
  <div class="nav-actions">
    <a class="btn-icon" href="/lab/#q" aria-label="Tìm bài viết" title="Tìm bài viết">${svg('search')}</a>
    <button class="btn-icon menu-toggle" type="button" aria-expanded="false" aria-controls="drawer" aria-label="Mở menu">${svg('menu')}</button>
  </div>
</div>
<div class="drawer" id="drawer" role="dialog" aria-modal="true" aria-label="Menu chuyên mục" hidden>
  <div class="drawer-panel">
    <div class="drawer-head">
      <span class="dr-brand">${BRAND_FULL}</span>
      <button class="btn-icon drawer-close" type="button" aria-label="Đóng menu">${svg('close', 'lg')}</button>
    </div>
    <nav class="drawer-nav" aria-label="Chuyên mục">
      <div class="dr-group dr-group-main">${drMain}</div>
      <div class="dr-divider" role="separator"></div>
      ${drawerGroups}
      <div class="dr-divider" role="separator"></div>
      <div class="dr-group dr-utility">
        <p class="dr-label">Thông tin</p>
        ${drUtility}
      </div>
    </nav>
  </div>
</div>
</header>`;
}

function footerHtml(facts) {
  // Compact footer mini-sitemap. Every link resolves through NAV_BY_SLUG — the
  // SAME canonical registry the header consumes — so footer labels/hrefs are
  // always identical to header navigation and no second URL map can drift.
  // No NAP in the global footer; the verified NAP lives on /lab/lien-he/.
  void facts;
  const cols = FOOTER_NAV.map(col => {
    const items = col.slugs.map(s => {
      const link = NAV_BY_SLUG[s];
      return `<li><a href="${link.href}">${esc(link.nav)}</a></li>`;
    }).join('');
    return `<div class="foot-col">
  <p class="foot-label">${esc(col.label)}</p>
  <ul class="foot-links">${items}</ul>
</div>`;
  }).join('\n');
  return `<footer class="site-foot"><div class="wrap">
<div class="foot-shell glass-footer">
  <div class="foot-top">
    <p class="foot-brand">${BRAND_FULL}</p>
    <p class="foot-desc">Cẩm nang nghiên cứu thực tế về xe máy, hành trình, bảo dưỡng, pháp lý và phương tiện hai bánh tại Việt Nam.</p>
    <nav class="foot-nav" aria-label="Sơ đồ trang">${cols}</nav>
  </div>
  <div class="foot-bottom">
    <p>© ${new Date().getFullYear()} ${BRAND_FULL}</p>
    <p class="fine">Dữ liệu &amp; nội dung được biên tập theo nguồn đã kiểm chứng.</p>
    <button class="to-top" id="to-top" type="button" aria-label="Lên đầu trang" title="Lên đầu trang">↑</button>
  </div>
</div>
</div></footer>
${chatbotHtml()}`;
}

/** Trợ lý đọc bản địa — shell markup shared by every generated page (build-site + wrap-drafts).
 * Retrieval-first; optional on-device AI (WebLLM/Qwen) is lazy-loaded by chatbot.js
 * only after an explicit user action. No inference API, no key, no NAP promotion. */
function chatbotHtml() {
  return `<button class="chat-launcher" id="chat-launcher" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="chat-panel" aria-label="Mở trợ lý đọc" title="Trợ lý đọc">${svg('chat', 'lg')}</button>
<section class="chat-panel" id="chat-panel" role="dialog" aria-modal="false" aria-label="Trợ lý Bản Đồ Xe 2 Bánh" hidden>
  <div class="chat-handle" aria-hidden="true"></div>
  <div class="chat-head">
    <div class="chat-title">
      <span class="chat-title-ico">${svg('chat')}</span>
      <span class="chat-title-txt">
        <span class="chat-title-name">Trợ lý Bản Đồ Xe 2 Bánh</span>
        <span class="chat-title-sub">Dựa trên nội dung đã xuất bản</span>
      </span>
    </div>
    <div class="chat-head-actions">
      <button class="chat-ai-toggle" id="chat-ai-toggle" type="button" aria-pressed="false" aria-label="Bật AI cục bộ"><span class="ai-txt">Bật AI cục bộ</span></button>
      <div class="chat-more" id="chat-more">
        <button class="chat-more-btn" id="chat-more-btn" type="button" aria-expanded="false" aria-haspopup="menu" aria-label="Tùy chọn trợ lý" title="Tùy chọn trợ lý">${svg('more')}</button>
        <div class="chat-menu" id="chat-menu" role="menu" hidden>
          <button class="chat-clear" id="chat-clear" type="button" role="menuitem" aria-label="Xóa hội thoại" title="Xóa hội thoại">${svg('trash')}<span>Xóa hội thoại</span></button>
        </div>
      </div>
      <button class="btn-icon chat-close" id="chat-close" type="button" aria-label="Đóng trợ lý">${svg('close')}</button>
    </div>
  </div>
  <div class="chat-mode-row"><span class="chat-mode" id="chat-mode" role="status" title="Chế độ tra cứu nội dung — trả lời từ nội dung đã xuất bản của trang.">Tra cứu nội dung</span></div>
  <div class="chat-log" id="chat-log" role="log" aria-live="polite" aria-label="Hội thoại với trợ lý"></div>
  <p class="chat-status" id="chat-status" role="status" aria-live="polite"></p>
  <form class="chat-input" id="chat-form" autocomplete="off">
    <textarea id="chat-q" rows="1" placeholder="Hỏi về thuê xe, cứu hộ, giấy tờ…" aria-label="Câu hỏi cho trợ lý"></textarea>
    <button class="chat-send" id="chat-send" type="submit" aria-label="Gửi câu hỏi">${svg('send')}</button>
  </form>
  <p class="chat-note">Trợ lý chỉ dựa trên nội dung đã xuất bản của trang; nếu chưa có thông tin đủ, trợ lý sẽ nói rõ. AI (khi bạn bật) chạy cục bộ trên thiết bị, không gửi hội thoại tới dịch vụ suy luận nào.</p>
</section>
<script src="/lab/assets/chatbot.js" defer></script>`;
}

/** Article chrome shared by build-site (published restore) and wrap-drafts.
 * Wraps breadcrumb + H1 + lead + postmeta in a premium article hero, adds a
 * category chip, a deterministic TOC, and appends related / hub-CTA / prev-next
 * blocks before </main>. Purely visual wrappers: canonical, schema and body
 * text are untouched. inner = full page HTML; returns full page HTML. */
function decorateArticle(inner, opt) {
  // opt: { category, hubSlug, hubTitle, groupLabel, related:[{href,title,meta,category,hubSlug}], prev, next, readingMin }
  if (/<header class="article-hero"/.test(inner)) return inner; // already decorated — idempotent
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
    const leadm = rest.match(/^\s*<p[^>]*>([\s\S]*?)<\/p>/);
    if (leadm) { lead = `<p class="article-lead">${leadm[1]}</p>`; rest = rest.slice(leadm[0].length); }
  }
  // deterministic TOC from H2/H3 with generated ids
  const heads = [];
  rest = rest.replace('<strong>Trả lời nhanh:</strong>', '<strong class="quick-label">Trả lời nhanh:</strong>');
  // responsive tables: every bare <table> gets a scroll wrapper (keyboard-focusable
  // region). Writers never add CSS — this is shared article chrome.
  rest = rest.replace(/<table>([\s\S]*?)<\/table>/g,
    '<div class="table-scroll" role="region" aria-label="Bảng dữ liệu — cuộn ngang trên màn hình nhỏ" tabindex="0"><table>$1</table></div>');
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

module.exports = { GROUPS, BRAND_FULL, BRAND_SHORT, EYEBROW, INFO_LINKS, MAIN_LINKS, NAV_BY_SLUG, FOOTER_NAV, ICON, svg, esc, groupOf, headerHtml, footerHtml, chatbotHtml, decorateArticle };
