/** shell.js — canonical Liquid Glass site shell (header, footer, nav data).
 * Shared by scripts/site/build-site.js and scripts/factory/wrap-drafts.js so every
 * generated page (home, hubs, contact, about, articles, drafts) consumes the same
 * header/footer markup. Child hub URLs are stable and never change here. */
'use strict';

// IA layer: 4 parent groups over the 8 existing child hubs. No new URLs are created.
const GROUPS = [
  { id: 'thue-xe-hanh-trinh', label: 'Thuê xe & Hành trình', desc: 'Thuê xe máy và kinh nghiệm di chuyển bằng xe hai bánh.', children: [
    { slug: 'thue-xe-may', nav: 'Thuê xe máy', desc: 'Giá, giấy tờ và kinh nghiệm thuê xe tại các tỉnh thành.' },
    { slug: 'kinh-nghiem', nav: 'Kinh nghiệm', desc: 'Kinh nghiệm sử dụng, lái xe an toàn, vận hành dài hạn.' } ] },
  { id: 'cuu-ho-bao-duong', label: 'Cứu hộ & Bảo dưỡng', desc: 'Xử lý sự cố trên đường và giữ xe luôn tốt.', children: [
    { slug: 'cuu-ho-xe-may', nav: 'Cứu hộ', desc: 'Chọn cứu hộ nhanh, an toàn khi gặp sự cố.' },
    { slug: 'sua-xe-may', nav: 'Sửa chữa & bảo dưỡng', desc: 'Bảo dưỡng định kỳ, sửa chữa các dòng phổ thông.' } ] },
  { id: 'phap-ly-giay-to', label: 'Pháp lý & Giấy tờ', desc: 'Giấy phép lái xe và thủ tục đăng ký xe máy.', children: [
    { slug: 'bang-lai-xe-may', nav: 'Bằng lái', desc: 'Thi bằng A1, đổi và cấp lại giấy phép lái xe.' },
    { slug: 'dang-ky-xe-may', nav: 'Đăng ký xe', desc: 'Đăng ký, sang tên, lệ phí trước bạ, biển số.' } ] },
  { id: 'xe-dien-phu-tung', label: 'Xe điện & Phụ tùng', desc: 'Xe máy điện và phụ tùng, linh kiện thay thế.', children: [
    { slug: 'xe-may-dien', nav: 'Xe máy điện', desc: 'Giá, pin, trạm sạc, chi phí sở hữu xe điện.' },
    { slug: 'phu-tung', nav: 'Phụ tùng', desc: 'Lốp, ắc quy, bugi, nhông xích, dầu máy.' } ] },
];
const BRAND_FULL = 'Bản Đồ Xe 2 Bánh Việt Nam';
const BRAND_SHORT = 'Bản Đồ Xe 2 Bánh';
const EYEBROW = 'CẨM NANG XE 2 BÁNH VIỆT NAM';

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function headerHtml() {
  const groups = GROUPS.map(g => `
    <div class="nav-group">
      <button class="nav-drop" type="button" aria-expanded="false" aria-controls="dd-${g.id}">${esc(g.label)}<span class="chev" aria-hidden="true">▾</span></button>
      <div class="dropdown glass-menu" id="dd-${g.id}" role="group" aria-label="${esc(g.label)}">
        ${g.children.map(c => `<a class="dd-link" href="/lab/${c.slug}/"><span class="dd-title">${esc(c.nav)}</span><span class="dd-desc">${esc(c.desc)}</span></a>`).join('')}
      </div>
    </div>`).join('');
  const drawer = GROUPS.map(g => `
    <div class="dr-group">
      <p class="dr-label">${esc(g.label.toUpperCase())}</p>
      ${g.children.map(c => `<a class="dr-link" href="/lab/${c.slug}/">${esc(c.nav)}</a>`).join('')}
    </div>`).join('');
  return `<header class="site-head">
<div class="wrap nav-shell glass-nav">
  <a class="brand" href="/lab/">${BRAND_SHORT}</a>
  <nav class="main-nav" aria-label="Chuyên mục chính">${groups}
    <a class="nav-link" href="/lab/ve-chung-toi/">Giới thiệu</a>
    <a class="nav-link" href="/lab/lien-he/">Liên hệ</a>
  </nav>
  <div class="nav-actions">
    <a class="icon-btn" href="/lab/#q" aria-label="Tìm bài viết" title="Tìm bài viết"><span aria-hidden="true">🔎</span></a>
    <button class="icon-btn menu-toggle" type="button" aria-expanded="false" aria-controls="drawer" aria-label="Mở menu"><span aria-hidden="true">☰</span></button>
  </div>
</div>
<div class="drawer glass-menu" id="drawer" role="dialog" aria-modal="true" aria-label="Menu chuyên mục" hidden>
  <div class="drawer-head">
    <span class="dr-brand">${BRAND_SHORT}</span>
    <button class="icon-btn drawer-close" type="button" aria-label="Đóng menu"><span aria-hidden="true">✕</span></button>
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
</div>
</div></footer>`;
}

module.exports = { GROUPS, BRAND_FULL, BRAND_SHORT, EYEBROW, esc, headerHtml, footerHtml };
