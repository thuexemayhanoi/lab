#!/usr/bin/env node
/** build-site.js — deterministic static site builder.
 * Generates: homepage (SEO super hub, 4 parent groups), topic hubs (with sibling
 * links), geo hubs, contact/about, sitemap-index.xml + shards (PUBLISHED only),
 * robots.txt, search index (PUBLISHED only), and restores published article pages
 * from data/published/ archive — injecting the canonical Liquid Glass shell so
 * articles share the same header/footer/menu as the rest of the site.
 * Article URLs, canonicals, schema and body content are never modified. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'site');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'business-facts.json'), 'utf8'));
// editorial deep-content (canonical copy source for homepage / about / hub intros)
const EDIT=JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'editorial.json'), 'utf8'));
const EDIT_HUBS=JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'editorial-hubs.json'), 'utf8')).hubs;
const secBlock=sec=>`<h2>${esc(sec.h)}</h2>\n${(sec.ps||[]).map(p=>`<p>${p}</p>`).join('\n')}`;
const faqBlock=list=>`<h2>Câu hỏi thường gặp</h2>\n${(list||[]).map(f=>`<details class="faq glass"><summary>${esc(f.q)}</summary><p>${f.a}</p></details>`).join('\n')}`;
const editorialBlock=o=>[(o.sections||[]).map(secBlock).join('\n'),o.faq?faqBlock(o.faq):''].filter(Boolean).join('\n');
const shell = require(path.join(__dirname, 'shell.js'));
const { GROUPS, BRAND_FULL, EYEBROW, esc, headerHtml, footerHtml } = shell;
function parseCSV(text){const L=text.split('\n');const H=parseLine(L[0]);return L.slice(1).filter(l=>l.trim()).map(l=>{const c=parseLine(l);const o={};H.forEach((h,i)=>o[h]=c[i]||'');return o;});}
function parseLine(line){const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];
 if(q){if(c==='"'){if(line[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=c;}
 else{if(c==='"')q=true;else if(c===','){out.push(cur);cur='';}else cur+=c;}} 
 out.push(cur);return out;}
const parts=fs.readdirSync(path.join(ROOT,'data')).filter(f=>/^content-matrix\.csv\.part/.test(f)).sort();
let csvText=fs.readFileSync(path.join(ROOT,'data','content-matrix.csv'),'utf8');
if(parts.length)csvText=parts.map(p=>fs.readFileSync(path.join(ROOT,'data',p),'utf8')).join('');
const rows=parseCSV(csvText);
const published=rows.filter(r=>r.status==='PUBLISHED')
 .sort((a,b)=>(b.published_date||'').localeCompare(a.published_date||'')||b.article_id.localeCompare(a.article_id)); // newest first
const CLUSTER_VI={RENTAL:'Thuê xe máy',RESCUE:'Cứu hộ xe máy',REPAIR:'Sửa chữa & bảo dưỡng',LICENCE:'Bằng lái xe máy',REGISTRATION:'Đăng ký xe máy',ELECTRIC:'Xe máy điện',PARTS:'Phụ tùng xe máy'};
const clipWords=(s,max)=>{s=s.trim();if(s.length<=max)return s;const cut=s.slice(0,max);const sp=cut.lastIndexOf(' ');return (sp>max*0.6?cut.slice(0,sp):cut).trim();};
// reader-facing title + short description extracted from the durable published archive
const archiveHtml={};
published.forEach(r=>{archiveHtml[r.article_id]=fs.readFileSync(path.join(ROOT,'data','published',r.article_id+'.html'),'utf8');});
const titleOf=r=>{const m=(archiveHtml[r.article_id]||'').match(/<h1[^>]*>([\s\S]*?)<\/h1>/);return m?m[1].replace(/<[^>]+>/g,'').trim():r.primary_keyword;};
const descOf=r=>{const m=(archiveHtml[r.article_id]||'').match(/<p[^>]*>([\s\S]*?)<\/p>/);return m?clipWords(m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' '),140):'';};
const HUBS=GROUPS.flatMap(g=>g.children.map(c=>({
 slug:c.slug,title:c.nav,nav:c.nav,group:g.id,groupLabel:g.label,desc:c.desc||'',
 fullTitle:c.fullTitle||c.nav})));
const CLUSTER_SLUGS=['thue-xe-may','cuu-ho-xe-may','sua-xe-may','bang-lai-xe-may','dang-ky-xe-may','xe-may-dien','phu-tung'];
const HUB_TITLE={'thue-xe-may':'Thuê xe máy','cuu-ho-xe-may':'Cứu hộ xe máy','sua-xe-may':'Sửa chữa & bảo dưỡng xe máy','bang-lai-xe-may':'Bằng lái xe máy','dang-ky-xe-may':'Đăng ký xe máy','xe-may-dien':'Xe máy điện','phu-tung':'Phụ tùng xe máy','kinh-nghiem':'Kinh nghiệm xe máy'};
const HUB_DESC={'thue-xe-may':'Kinh nghiệm, giá và hướng dẫn thuê xe máy tại các tỉnh thành Việt Nam.','cuu-ho-xe-may':'Cách tìm và chọn cứu hộ xe máy nhanh, an toàn khi gặp sự cố trên đường.','sua-xe-may':'Hướng dẫn sửa chữa, bảo dưỡng xe máy các dòng phổ thông và xe điện.','bang-lai-xe-may':'Hồ sơ, lệ phí, quy trình thi bằng lái xe máy A1 và thủ tục đổi/cấp lại.','dang-ky-xe-may':'Thủ tục đăng ký, sang tên, lệ phí trước bạ và biển số xe máy theo quy định hiện hành.','xe-may-dien':'Xe máy điện Việt Nam: giá, pin, trạm sạc, chi phí và so sánh với xe xăng.','phu-tung':'Cách chọn lốp, ắc quy, bugi, nhông xích, dầu máy và phụ tùng xe điện.','kinh-nghiem':'Kinh nghiệm sử dụng, lái xe an toàn và vận hành xe máy dài hạn.'};
// articles belonging to a child hub (kinh-nghiem = catch-all for non-cluster slugs)
const hubArts=slug=>published.filter(r=>r.output_path.startsWith(slug+'/')||(slug==='kinh-nghiem'&&!CLUSTER_SLUGS.some(x=>r.output_path.startsWith(x+'/'))));
const layout=(title,content,canonical,extra,desc)=>{
 return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc||title)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc||title)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">
${extra||''}
<link rel="stylesheet" href="/lab/assets/style.css">
</head>
<body>
${headerHtml()}
<main class="wrap" id="main-content">${content}</main>
${footerHtml(facts)}
<script src="/lab/assets/menu.js" defer></script>
</body>
</html>`;
};
fs.rmSync(SITE,{recursive:true,force:true});
fs.mkdirSync(SITE,{recursive:true});
fs.mkdirSync(path.join(SITE,'assets'),{recursive:true});
fs.writeFileSync(path.join(SITE,'assets','style.css'),CSS());
// inject the canonical shell into archived article pages (body/schema/canonical untouched)
const SHELL_RE={head:/<header class="site-head">[\s\S]*?<\/header>/,foot:/<footer class="site-foot">[\s\S]*?<\/footer>/};
// OG metadata derived from the archive's own canonical head (title/description/canonical).
const ogFor=html=>{
 const t=(html.match(/<title>([\s\S]*?)<\/title>/)||[])[1]||'';
 const d=(html.match(/<meta name="description" content="([^"]*)"/)||[])[1]||t;
 const u=(html.match(/<link rel="canonical" href="([^"]*)"/)||[])[1]||'';
 return `<meta property="og:title" content="${esc(t)}">\n<meta property="og:description" content="${esc(d)}">\n<meta property="og:url" content="${u}">\n<meta property="og:type" content="article">\n`;
};
const withShell=html=>html
 .replace(SHELL_RE.head,headerHtml().replace(/\n\s+/g,'\n  '))
 .replace(SHELL_RE.foot,footerHtml(facts).replace(/\n\s+/g,'\n  '))
 .replace(/<main(?![^>]*\bid=)/,'<main id="main-content"')
 .replace('</head>',ogFor(html)+'</head>')
 .replace('</body>','<script src="/lab/assets/menu.js" defer></script>\n</body>');
// Homepage — SEO super hub: 4 parent groups, crawlable child links + latest articles
const artCard=(r,label)=>`<li class="card"><a class="article-chip" href="/lab/${r.output_path.split('/')[0]}/">${esc(CLUSTER_VI[r.cluster]||r.cluster)}</a><a class="card-title" href="/lab/${r.output_path}">${esc(titleOf(r))}</a><p class="meta">${esc(descOf(r))}</p><div class="meta"><time datetime="${esc(r.published_date)}">${esc(r.published_date)}</time>${r.province?' · '+esc(r.province):''}</div><a class="read-more" href="/lab/${r.output_path}">Đọc bài →</a></li>`;
const hubSections=GROUPS.map(g=>{
 const kids=g.children.map(c=>{
   const arts=hubArts(c.slug);
   return `<a class="child-chip glass" href="/lab/${c.slug}/"><span class="chip-title">${esc(c.nav)}</span><span class="chip-count">${arts.length} bài viết</span></a>`;}).join('');
 const arts=published.filter(r=>g.children.some(c=>r.output_path.startsWith(c.slug+'/'))||(g.id==='thue-xe-hanh-trinh'&&r.output_path.startsWith('kinh-nghiem/'))).slice(0,3);
 return `<section class="hub-card glass-strong" aria-labelledby="hub-${g.id}">
<p class="hub-label">${esc(g.label.toUpperCase())}</p>
<h2 id="hub-${g.id}">${esc(g.label)}</h2>
<p class="hub-desc">${esc(g.desc)}</p>
<div class="child-chips">${kids}</div>
${arts.length?`<h3 class="hub-sub">Bài viết mới nhất</h3>
<ul class="cards">${arts.map(r=>artCard(r)).join('')}</ul>`:''}
<div class="hub-cta"><a class="btn btn-secondary" href="/lab/${g.children[0].slug}/">Xem chủ đề →</a></div>
</section>`;}).join('\n');
const hqCards=published.map(r=>artCard(r)).join('\n');
const home=layout('Bản Đồ Xe 2 Bánh Việt Nam — hướng dẫn xe máy Việt Nam',`
<section class="hero glass-strong">
<p class="eyebrow">${EYEBROW}</p>
<h1>${BRAND_FULL}</h1>
<p class="lead">Blog thông tin về hệ sinh thái xe máy Việt Nam: hướng dẫn <strong>thuê xe máy</strong>, cứu hộ khi gặp sự cố, sửa chữa &amp; bảo dưỡng, bằng lái, đăng ký xe, xe máy điện và phụ tùng — viết từ nghiên cứu thực tế, cập nhật theo quy định hiện hành.</p>
<input id="q" class="searchbox" type="search" placeholder="Tìm bài viết… (ví dụ: thuê xe máy Hà Nội)" oninput="doSearch(this.value)" aria-label="Tìm bài viết">
<ul id="search-results"></ul>
</section>
<div class="hub-grid">
${hubSections}
</div>
<h2>Bài viết mới</h2>
<ul class="cards">${hqCards}</ul>
<section class="editorial" aria-label="Giới thiệu về cẩm nang">
${editorialBlock(EDIT.home)}
</section>
<script src="/lab/assets/search.js" defer></script>`,cfg.base_url,
`<script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"WebSite",name:BRAND_FULL,url:cfg.base_url,inLanguage:'vi'})}</script>`,
'Hướng dẫn, kinh nghiệm và thông tin thực tế về thuê xe máy, cứu hộ, sửa chữa, bằng lái, đăng ký xe, xe máy điện và phụ tùng tại Việt Nam.');
fs.writeFileSync(path.join(SITE,'index.html'),home);
// Topic hubs (child hubs — URLs unchanged) with sibling + home links
HUBS.forEach(h=>{
 const arts=hubArts(h.slug);
 const cards=arts.map(r=>artCard(r,CLUSTER_VI[r.cluster]+(r.province?' · '+r.province:''))).join('\n')||'<li class="card">Chủ đề này sẽ sớm có bài viết mới.</li>';
 const group=GROUPS.find(g=>g.id===h.group);
 const sibs=group.children.filter(c=>c.slug!==h.slug);
 const title=HUB_TITLE[h.slug]||h.title;
 const desc=HUB_DESC[h.slug]||h.desc;
 const ed=EDIT_HUBS[h.slug]||{};
 const html=layout(title+' — Bản Đồ Xe 2 Bánh Việt Nam',`<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › ${esc(title)}</nav>
<h1>${esc(title)}</h1><p>${esc(ed.lead||desc)}</p>
<p class="siblings">Cùng nhóm <strong>${esc(group.label)}</strong>: ${sibs.map(s=>`<a class="sib-link" href="/lab/${s.slug}/">${esc(s.nav)}</a>`).join('')}</p>
<h2>Bài viết</h2><ul class="cards">${cards}</ul>
<section class="editorial" aria-label="Hướng dẫn chủ đề">${editorialBlock(ed)}</section>`,cfg.base_url+h.slug+'/',
`<script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"CollectionPage",name:title,description:desc,url:cfg.base_url+h.slug+'/'})}</script>`+(arts.length?`\n<script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"ItemList",itemListElement:arts.map((r,i)=>({"@type":"ListItem",position:i+1,name:titleOf(r),url:cfg.base_url+r.output_path}))})}</script>`:''),desc);
 fs.mkdirSync(path.join(SITE,h.slug),{recursive:true});
 fs.writeFileSync(path.join(SITE,h.slug,'index.html'),html);
});
// Geo hubs only where published content exists
const byProv={};published.forEach(r=>{if(r.province){(byProv[r.province]=byProv[r.province]||[]).push(r);}});
Object.entries(byProv).forEach(([prov,arts])=>{
 const slug=prov.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/[^a-z0-9]+/gi,'-').toLowerCase().replace(/^-+|-+$/g,'');
 const dir=path.join(SITE,'dia-phuong',slug);
 fs.mkdirSync(dir,{recursive:true});
 const cards=arts.map(r=>`<li class="card"><a href="/lab/${r.output_path}">${esc(r.primary_keyword)}</a></li>`).join('\n');
 fs.writeFileSync(path.join(dir,'index.html'),layout('Xe máy tại '+prov,`<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › Địa phương › ${esc(prov)}</nav><h1>Xe máy tại ${esc(prov)}</h1><p>Các bài viết về hệ sinh thái xe máy tại ${esc(prov)} trên ${BRAND_FULL}.</p><ul class="cards">${cards}</ul>`,cfg.base_url+'dia-phuong/'+slug+'/'));
});
// Privacy & Terms (utility pages — exempt from long-form word range)
fs.mkdirSync(path.join(SITE,'chinh-sach-bao-mat'),{recursive:true});
fs.writeFileSync(path.join(SITE,'chinh-sach-bao-mat','index.html'),layout('Chính sách bảo mật',`
<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › Chính sách bảo mật</nav>
<h1>Chính sách bảo mật</h1>
<p>${BRAND_FULL} là trang thông tin tĩnh, không có tài khoản người dùng, không có biểu mẫu đăng ký và không bán bất kỳ sản phẩm nào qua trang này. Chính sách dưới đây mô tả đúng cách trang hoạt động ở thời điểm cập nhật.</p>
<h2>Thông tin chúng tôi thu thập</h2>
<p>Trang không có hệ thống phân tích (analytics), không dùng cookie theo dõi và không thu thập dữ liệu cá nhân của bạn khi đọc bài viết. Các tệp tĩnh của trang (HTML, CSS, JS) được phục vụ bởi hạ tầng GitHub Pages.</p>
<h2>Tra cứu và tìm kiếm</h2>
<p>Chức năng tìm bài viết trên trang chủ chạy hoàn toàn trong trình duyệt của bạn: dữ liệu tìm kiếm được tải xuống một tệp chỉ mục tĩnh và việc lọc diễn ra trên thiết bị, không gửi từ khóa tìm kiếm về máy chủ nào.</p>
<h2>Liên kết ngoài</h2>
<p>Bài viết có thể dẫn tới các nguồn chính thức (ví dụ: cổng thông tin điện tử Chính phủ, cơ quan quản lý nhà nước) để bạn kiểm chứng thông tin pháp lý. Khi bạn nhấp sang một trang ngoài, việc truy cập đó tuân theo chính sách riêng của trang đích.</p>
<h2>Nội dung AI cục bộ</h2>
<p>Trang có một trợ lý đọc dùng mô hình ngôn ngữ AI chạy <strong>cục bộ ngay trong trình duyệt của bạn</strong> khi bạn chủ động bật chế độ AI. Nội dung trò chuyện không được gửi tới dịch vụ suy luận (inference API) nào. Tệp mô hình chỉ được tải xuống khi bạn chủ động bật chế độ AI, có thể được trình duyệt lưu trong bộ nhớ đệm (cache) của thiết bị và tải lại lần sau không cần tải đầy. Vì tệp mô hình được phân phối qua một kho mô hình công khai, việc bật chế độ AI sẽ phát sinh yêu cầu mạng tới kho mô hình đó — trang không cam kết "không có bất kỳ yêu cầu mạng nào" cho tính năng này. Chi tiết vận hành của trợ lý được mô tả ngay trong bảng trò chuyện.</p>
<h2>Cập nhật chính sách</h2>
<p>Nếu cách vận hành của trang thay đổi, chính sách này sẽ được cập nhật tại đúng địa chỉ hiện tại. Ngày cập nhật gần nhất ghi cuối trang. Mọi câu hỏi về quyền riêng tư, vui lòng liên hệ qua trang <a href="/lab/lien-he/">Liên hệ</a>.</p>
<h2>Thông tin liên hệ</h2>
<div class="nap-block">
<p><strong>${esc(facts.business_name)}</strong><br>
${esc(facts.address)}<br>
Điện thoại: <a href="tel:${esc(facts.phone_tel)}">${esc(facts.phone)}</a><br>
Email: <a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a><br>
Website: <a href="${esc(facts.website)}" target="_blank" rel="noopener">${esc(facts.website)}</a><br>
Giờ hoạt động: ${esc(facts.opening_hours)}</p>
</div>
<p class="fine">Cập nhật lần cuối: 2026-09-28.</p>`,cfg.base_url+'chinh-sach-bao-mat/',null,
'Chính sách bảo mật của Bản Đồ Xe 2 Bánh Việt Nam: không có analytics, không theo dõi, trợ lý AI chạy cục bộ trong trình duyệt.'));
fs.mkdirSync(path.join(SITE,'dieu-khoan-su-dung'),{recursive:true});
fs.writeFileSync(path.join(SITE,'dieu-khoan-su-dung','index.html'),layout('Điều khoản sử dụng',`
<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › Điều khoản sử dụng</nav>
<h1>Điều khoản sử dụng</h1>
<p>Cảm ơn bạn đã đọc ${BRAND_FULL}. Khi sử dụng trang, bạn đồng ý với các điều khoản dưới đây.</p>
<h2>Mục đích của nội dung</h2>
<p>Toàn bộ bài viết trên trang mang tính <strong>thông tin — tham khảo</strong> về hệ sinh thái xe hai bánh tại Việt Nam: thuê xe, cứu hộ, bảo dưỡng, giấy tờ pháp lý, xe điện và phụ tùng. Trang không phải cơ quan nhà nước, không phải văn phòng tư vấn pháp lý và không thay thế hướng dẫn chính thức của cơ quan có thẩm quyền.</p>
<h2>Thông tin pháp lý có thể thay đổi</h2>
<p>Quy định về giấy tờ, lệ phí, kỹ thuật và an toàn giao thông có thể thay đổi theo văn bản pháp luật mới. Chúng tôi cố gắng ghi rõ nguồn chính thức trong từng bài và cập nhật khi phát hiện thay đổi, song bạn nên kiểm tra văn bản gốc trước khi thực hiện thủ tục.</p>
<h2>Trách nhiệm của người đọc</h2>
<p>Bạn chịu trách nhiệm với quyết định của mình khi vận hành phương tiện, thực hiện thủ tục hay lựa chọn dịch vụ. Các bài viết địa phương ngoài khu vực xác thực chỉ mang tính hướng dẫn, không phải lời chào mời dịch vụ.</p>
<h2>Bản quyền</h2>
<p>Nội dung do ${BRAND_FULL} biên soạn theo phương pháp nghiên cứu có nguồn. Đăng lại toàn văn cần ghi rõ nguồn và liên kết về trang gốc.</p>
<h2>Cập nhật nội dung</h2>
<p>Bài viết được bổ sung, hiệu đính và cập nhật theo thời gian; ngày đăng và nội dung cập nhật được ghi trong từng bài.</p>
<h2>Liên hệ</h2>
<p>Thắc mắc về nội dung hoặc điều khoản: xin dùng thông tin trên trang <a href="/lab/lien-he/">Liên hệ</a>.</p>
<p class="fine">Cập nhật lần cuối: 2026-09-28.</p>`,cfg.base_url+'dieu-khoan-su-dung/',null,
'Điều khoản sử dụng của Bản Đồ Xe 2 Bánh Việt Nam: nội dung thông tin, nguồn chính thức, trách nhiệm người đọc.'));
// Contact page — canonical trust/NAP page built from verified business facts
// (config/business-facts.json is the single source of truth; nothing invented here).
fs.mkdirSync(path.join(SITE,'lien-he'));
const napAddr = String(facts.address||'').split(',').map(s=>s.trim());
const napSchema = JSON.stringify({
 "@context":"https://schema.org",
 "@type":"LocalBusiness",
 name:facts.business_name,
 telephone:facts.phone_tel,
 email:facts.email,
 url:facts.website,
 address:{"@type":"PostalAddress",streetAddress:napAddr[0]||'',
  addressLocality:(napAddr[1]&&napAddr[2]?napAddr[1]+', '+napAddr[2]:''),addressRegion:napAddr[3]||'',addressCountry:"VN"},
 openingHoursSpecification:[{"@type":"OpeningHoursSpecification",
  dayOfWeek:["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],
  opens:"09:00",closes:"21:00"}]
});
const mapPin = '<svg class="ico ico-sm" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';
fs.writeFileSync(path.join(SITE,'lien-he','index.html'),layout('Liên hệ',`
<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › Liên hệ</nav>
<h1>Liên hệ</h1>
<p class="lead">Thông tin liên hệ chính thức của ${esc(facts.business_name)}.</p>
<section class="nap-card glass-strong" aria-labelledby="nap-h">
  <h2 id="nap-h">Thông tin liên hệ</h2>
  <dl class="nap-list">
    <div class="nap-row"><dt>Địa chỉ</dt><dd>${esc(facts.address)}</dd></div>
    <div class="nap-row"><dt>Điện thoại</dt><dd><a href="tel:${esc(facts.phone_tel)}">${esc(facts.phone)}</a></dd></div>
    <div class="nap-row"><dt>Email</dt><dd><a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></dd></div>
    <div class="nap-row"><dt>Giờ hoạt động</dt><dd>${esc(facts.opening_hours)}</dd></div>
    <div class="nap-row"><dt>Website</dt><dd><a href="${esc(facts.website)}" target="_blank" rel="noopener">${esc(facts.website)}</a></dd></div>
  </dl>
  <div class="nap-actions">
    <a class="btn" href="tel:${esc(facts.phone_tel)}">Gọi điện</a>
    <a class="btn" href="${esc(facts.website)}" target="_blank" rel="noopener">Mở website</a>
    <a class="btn btn-secondary" href="${esc(facts.maps_url)}" target="_blank" rel="noopener">Xem trên Google Maps</a>
  </div>
</section>
<section class="map-card glass" aria-labelledby="map-h">
  <h2 id="map-h">Vị trí</h2>
  <p class="map-line">${mapPin} ${esc(facts.address)}</p>
  <p class="fine">Bản đồ chi tiết vị trí được mở trong Google Maps — dùng nút “Xem trên Google Maps” phía trên.</p>
  <a class="btn btn-secondary" href="${esc(facts.maps_url)}" target="_blank" rel="noopener">Mở Google Maps</a>
</section>
<section aria-labelledby="pre-h">
  <h2 id="pre-h">Thông tin trước khi liên hệ</h2>
  <ul class="checklist">
    <li>Giờ hoạt động: ${esc(facts.opening_hours)} mỗi ngày.</li>
    <li>Nên liên hệ trước để kiểm tra tình trạng xe.</li>
    <li>Thông tin trên trang này là thông tin liên hệ chính thức của ${esc(facts.business_name)}.</li>
  </ul>
</section>`,cfg.base_url+'lien-he/',
`<script type="application/ld+json">${napSchema}</script>`,
'Thông tin liên hệ chính thức của Thuê Xe Máy Nguyễn Tú tại Long Biên, Hà Nội: địa chỉ, điện thoại, email, giờ hoạt động, website và Google Maps.'));
fs.mkdirSync(path.join(SITE,'ve-chung-toi'));
fs.writeFileSync(path.join(SITE,'ve-chung-toi','index.html'),layout('Về chúng tôi',`
<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › Về chúng tôi</nav>
<h1>Về chúng tôi</h1>
<p class="about-lead">${BRAND_FULL} là trang thông tin nghiên cứu độc lập về hệ sinh thái xe hai bánh Việt Nam, vận hành bởi ${esc(facts.business_name)} (${esc(facts.location_summary)}).</p>
${editorialBlock(EDIT.about)}
<p class="fine">Thí nghiệm SEO hiện tại: baseline zero-backlink — xem <a href="/lab/reports/experiments/baseline.md">báo cáo baseline</a> thí nghiệm.</p>`,cfg.base_url+'ve-chung-toi/',null,
'Về Bản Đồ Xe 2 Bánh Việt Nam: phương pháp nghiên cứu, chính sách nguồn, thí nghiệm zero-backlink và cách cập nhật nội dung.'));
// publish experiment baseline report (linked from About page)
const baselineSrc=path.join(ROOT,'reports','experiments','baseline.md');
if(fs.existsSync(baselineSrc)){
 fs.mkdirSync(path.join(SITE,'reports','experiments'),{recursive:true});
 fs.copyFileSync(baselineSrc,path.join(SITE,'reports','experiments','baseline.md'));
}
// restore published article pages from durable archive (shell injected, content intact)
published.forEach(r=>{
 const src=path.join(ROOT,'data','published',r.article_id+'.html');
 const dest=path.join(SITE,r.output_path.replace(/^\//,''),'index.html');
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 if(!fs.existsSync(src)) throw new Error('PUBLISHED but no archived article: '+r.article_id);
 const html=fs.readFileSync(src,'utf8');
 if(!SHELL_RE.head.test(html)||!SHELL_RE.foot.test(html)) throw new Error('archive shell not recognized: '+r.article_id);
 const hubSlug=r.output_path.split('/')[0];
 const grp=shell.groupOf(hubSlug)||shell.GROUPS[0];
 const words=((archiveHtml[r.article_id].replace(/<[^>]+>/g,' ').match(/[A-Za-zÀ-ỹ0-9]+/g)||[]).length);
 const sameHub=published.filter(x=>x.output_path.split('/')[0]===hubSlug&&x.article_id!==r.article_id).slice(0,4);
 const i=published.findIndex(x=>x.article_id===r.article_id);
 const pn={prev:i>0?{href:published[i-1].output_path,title:titleOf(published[i-1])}:null,
           next:i<published.length-1?{href:published[i+1].output_path,title:titleOf(published[i+1])}:null};
 const opt={category:CLUSTER_VI[r.cluster]||r.cluster,hubSlug,hubTitle:HUB_TITLE[hubSlug]||hubSlug,
  groupLabel:grp.label,readingMin:Math.max(1,Math.round(words/300)),
  related:sameHub.map(x=>({href:x.output_path,title:titleOf(x),
   meta:(x.published_date||'')+(x.province?' · '+x.province:''),category:CLUSTER_VI[x.cluster]||x.cluster,hubSlug:x.output_path.split('/')[0]})),
  prev:pn.prev,next:pn.next};
 fs.writeFileSync(dest,shell.decorateArticle(withShell(html),opt));
});
// sitemap: index + shards
const shards={static:[]};
published.forEach(r=>{const c=r.cluster.toLowerCase();(shards[c]=shards[c]||[]).push(r);});
let shardFiles=[];
Object.entries(shards).forEach(([name,list])=>{
 // Each URL appears in EXACTLY ONE sitemap: category shards own only their own
 // published canonicals; the static sitemap owns the homepage (see extraUrls).
 const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${list.map(r=>r.canonical).map(u=>`<url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`;
 const fn='sitemap-'+name+'.xml';
 fs.writeFileSync(path.join(SITE,fn),xml);
 shardFiles.push(fn);
});
const extraUrls=[cfg.base_url,cfg.base_url+'lien-he/',cfg.base_url+'ve-chung-toi/',cfg.base_url+'chinh-sach-bao-mat/',cfg.base_url+'dieu-khoan-su-dung/',...HUBS.map(h=>cfg.base_url+h.slug+'/')];
fs.writeFileSync(path.join(SITE,'sitemap-static.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${extraUrls.map(u=>`<url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`);
if(!shardFiles.includes('sitemap-static.xml'))shardFiles.push('sitemap-static.xml');
fs.writeFileSync(path.join(SITE,'sitemap-index.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${shardFiles.map(f=>`<sitemap><loc>${cfg.base_url+f}</loc></sitemap>`).join('\n')}\n</sitemapindex>`);
fs.writeFileSync(path.join(SITE,'robots.txt'),`User-agent: *\nAllow: /\nDisallow: /lab/_drafts/\nSitemap: ${cfg.base_url}sitemap-index.xml\n`);
// 404 page — shared shell, noindex, useful way back. No canonical and no og:url:
// a 404 must never be indexed or given an alternate representation.
fs.writeFileSync(path.join(SITE,'404.html'),`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Không tìm thấy trang — ${esc(BRAND_FULL)}</title>
<meta name="description" content="Trang bạn tìm không tồn tại hoặc đã được di chuyển.">
<meta name="robots" content="noindex, follow">
<link rel="stylesheet" href="/lab/assets/style.css">
</head>
<body>
${headerHtml()}
<main class="wrap" id="main-content">
<section class="hero glass-strong" aria-labelledby="nf-h">
<p class="eyebrow">LỖI 404</p>
<h1 id="nf-h">Không tìm thấy trang</h1>
<p class="lead">Trang bạn tìm không tồn tại hoặc đã được di chuyển. Nội dung của cẩm nang vẫn đủ trên trang chủ và các chuyên mục.</p>
<div class="cta-row">
<a class="btn btn-primary" href="/lab/">Về trang chủ</a>
<a class="btn btn-secondary" href="/lab/thue-xe-may/">Thuê xe máy</a>
<a class="btn btn-secondary" href="/lab/lien-he/">Liên hệ</a>
</div>
</section>
</main>
${footerHtml(facts)}
<script src="/lab/assets/menu.js" defer></script>
</body>
</html>`);
// search index (PUBLISHED only, minimal fields)
const idx=published.map(r=>({t:r.primary_keyword,d:r.secondary_keywords||r.primary_keyword,c:r.cluster,p:r.province,l:r.locality,poi:r.poi,b:r.brand,m:r.model,v:r.vehicle_type,u:r.output_path}));
fs.writeFileSync(path.join(SITE,'assets','search-index.json'),JSON.stringify(idx));
fs.writeFileSync(path.join(SITE,'assets','search.js'),`let IDX=null;
fetch('/lab/assets/search-index.json').then(r=>r.json()).then(d=>IDX=d);
var CLV={RENTAL:'Thuê xe máy',RESCUE:'Cứu hộ xe máy',REPAIR:'Sửa chữa & bảo dưỡng',LICENCE:'Bằng lái xe máy',REGISTRATION:'Đăng ký xe máy',ELECTRIC:'Xe máy điện',PARTS:'Phụ tùng xe máy'};
function doSearch(q){
 q=(q||'').toLowerCase().trim();
 const el=document.getElementById('search-results');
 if(!q||!IDX){el.innerHTML='';return;}
 const hits=IDX.filter(x=>(x.t+' '+x.d+' '+x.p+' '+x.l+' '+x.m).toLowerCase().includes(q)).slice(0,10);
 el.innerHTML=hits.length?hits.map(h=>'<li class="sr-card"><span class="article-chip">'+(CLV[h.c]||h.c)+'</span><a class="sr-title" href="/lab/'+h.u+'">'+h.t+'</a><span class="sr-meta">'+(h.p||'')+'</span></li>').join(''):'<li class="sr-meta">Không tìm thấy bài đã xuất bản nào.</li>';
}
`);
// minimal vanilla menu interactions: dropdowns (mouse/keyboard/focus/touch) + mobile drawer
fs.writeFileSync(path.join(SITE,'assets','menu.js'),MENU_JS());
// ---------- local reading assistant: knowledge index (PUBLISHED content only) + assets ----------
// Chunks come from published article archives, hub editorial content, homepage and about
// editorial sections. Drafts, blocked pages and factory internals are never indexed.
const KB_DATE='2026-09-28';
const stripTags=h=>h.replace(/<script[\s\S]*?<\/script>/g,' ').replace(/<style[\s\S]*?<\/style>/g,' ')
 .replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"')
 .replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
const kbChunk=t=>(t.length>720?t.slice(0,717)+'…':t);
function kbArticleChunks(html){
 const mainM=html.match(/<main[^>]*>([\s\S]*?)<\/main>/);
 const body=mainM?mainM[1]:html;
 const out=[];let h='';const re=/<h[23][^>]*>([\s\S]*?)<\/h[23]>|<summary[^>]*>([\s\S]*?)<\/summary>|<p[^>]*>([\s\S]*?)<\/p>/gi;let m;
 while((m=re.exec(body))){
  if(m[1]!==undefined){h=stripTags(m[1]);continue;}
  if(m[2]!==undefined){h='Hỏi: '+stripTags(m[2]);continue;} // FAQ question as chunk heading
  const t=stripTags(m[3]);
  if(t.length>=60)out.push({h,t:kbChunk(t)});
 }
 return out;
}
const KB=[];
published.forEach(r=>{
 const chunks=kbArticleChunks(archiveHtml[r.article_id]);
 if(chunks.length)KB.push({t:titleOf(r),u:r.output_path,topic:CLUSTER_VI[r.cluster]||r.cluster,updated:r.published_date||'',chunks});
});
HUBS.forEach(h=>{
 const ed=EDIT_HUBS[h.slug];if(!ed)return;
 const chunks=[];
 if(ed.lead)chunks.push({h:'',t:kbChunk(stripTags(ed.lead))});
 (ed.sections||[]).forEach(s=>(s.ps||[]).forEach(p=>chunks.push({h:s.h,t:kbChunk(stripTags(p))})));
 (ed.faq||[]).forEach(f=>chunks.push({h:'Hỏi: '+f.q,t:kbChunk(stripTags(f.a))}));
 if(chunks.length)KB.push({t:HUB_TITLE[h.slug]||h.title,u:h.slug+'/',topic:h.title,updated:'',chunks});
});
const kbPage=(t,u,topic,ed)=>{
 const chunks=[];
 (ed.sections||[]).forEach(s=>(s.ps||[]).forEach(p=>chunks.push({h:s.h,t:kbChunk(stripTags(p))})));
 (ed.faq||[]).forEach(f=>chunks.push({h:'Hỏi: '+f.q,t:kbChunk(stripTags(f.a))}));
 if(chunks.length)KB.push({t,u,topic,updated:'',chunks});
};
kbPage(BRAND_FULL,'',BRAND_FULL,EDIT.home);
kbPage('Về chúng tôi — '+BRAND_FULL,'ve-chung-toi/','Giới thiệu',EDIT.about);
fs.writeFileSync(path.join(SITE,'assets','knowledge-index.json'),JSON.stringify({version:1,generated:KB_DATE,records:KB}));
// assistant runtime is authored as canonical sources and copied verbatim into assets
fs.copyFileSync(path.join(ROOT,'scripts','site','chatbot.js'),path.join(SITE,'assets','chatbot.js'));
fs.copyFileSync(path.join(ROOT,'scripts','site','chatbot-worker.js'),path.join(SITE,'assets','chatbot-worker.js'));
// copy experiment baseline report for public link
fs.mkdirSync(path.join(SITE,'reports','experiments'),{recursive:true});
if(fs.existsSync(path.join(ROOT,'reports','experiments','baseline.md')))
 fs.copyFileSync(path.join(ROOT,'reports','experiments','baseline.md'),path.join(SITE,'reports','experiments','baseline.md'));
// ---------- branch-pages promotion: public build outputs -> repository root ----------
// Pages is served from branch main / (root). site/ is a LOCAL, GITIGNORED intermediate.
// Only explicit public outputs are promoted; source directories (scripts/, config/,
// data/, tests/, docs/, .github/, reports/) are never written. Deterministic: every
// build regenerates the same deployable root tree.
fs.writeFileSync(path.join(SITE,'.nojekyll'),'');
const PUB_FILES=['index.html','404.html','robots.txt','.nojekyll','sitemap-index.xml',...shardFiles];
const PUB_DIRS=['assets','thue-xe-may','kinh-nghiem','cuu-ho-xe-may','sua-xe-may','bang-lai-xe-may',
 'dang-ky-xe-may','xe-may-dien','phu-tung','ve-chung-toi','lien-he','chinh-sach-bao-mat',
 'dieu-khoan-su-dung','dia-phuong'];
const SRC_GUARD=new Set(['scripts','config','data','tests','docs','.github','reports','_drafts']);
let promoted=0;
const promoteFile=rel=>{ fs.mkdirSync(path.dirname(path.join(ROOT,rel)),{recursive:true});
 fs.copyFileSync(path.join(SITE,rel),path.join(ROOT,rel)); promoted++; };
const promoteDir=dir=>{ (function walk(rel){ fs.readdirSync(path.join(SITE,rel),{withFileTypes:true}).forEach(e=>{
 const r=rel?rel+'/'+e.name:e.name;
 if(e.isDirectory()){ if(SRC_GUARD.has(e.name)) throw new Error('promotion guard hit source dir: '+r); walk(r); }
 else promoteFile(r); }); })(dir); };
PUB_FILES.forEach(f=>{ if(fs.existsSync(path.join(SITE,f))) promoteFile(f); });
PUB_DIRS.forEach(d=>{ if(fs.existsSync(path.join(SITE,d))) promoteDir(d); });
console.log('SITE BUILT. published='+published.length+' shards='+shardFiles.join(','));
console.log('ROOT PROMOTED: '+promoted+' public files mirrored to repository root (branch Pages: main / (root)).');

// ---------- premium editorial stylesheet (deterministic) ----------
function CSS(){ /* canonical source: scripts/site/style.css (single shared editorial design system) */
 return fs.readFileSync(path.join(__dirname,'style.css'),'utf8');}
function MENU_JS(){ /* canonical source: scripts/site/menu.js */
 return fs.readFileSync(path.join(__dirname,'menu.js'),'utf8');}
