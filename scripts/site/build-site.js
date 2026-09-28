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
${extra||''}
<link rel="stylesheet" href="/lab/assets/style.css">
</head>
<body>
${headerHtml()}
<main class="wrap">${content}</main>
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
const withShell=html=>html
 .replace(SHELL_RE.head,headerHtml().replace(/\n\s+/g,'\n  '))
 .replace(SHELL_RE.foot,footerHtml(facts).replace(/\n\s+/g,'\n  '))
 .replace('</body>','<script src="/lab/assets/menu.js" defer></script>\n</body>');
// Homepage — SEO super hub: 4 parent groups, crawlable child links + latest articles
const artCard=(r,label)=>`<li class="card"><a href="/lab/${r.output_path}">${esc(titleOf(r))}</a><p class="meta">${esc(descOf(r))}</p><div class="meta"><time datetime="${esc(r.published_date)}">${esc(r.published_date)}</time> · ${esc(label||CLUSTER_VI[r.cluster]||r.cluster)}</div></li>`;
const hubSections=GROUPS.map(g=>{
 const kids=g.children.map(c=>{
   const arts=hubArts(c.slug);
   return `<a class="child-chip glass" href="/lab/${c.slug}/"><span class="chip-title">${esc(c.nav)}</span><span class="chip-count">${arts.length} bài viết</span></a>`;}).join('');
 const arts=published.filter(r=>g.children.some(c=>r.output_path.startsWith(c.slug+'/'))||(g.id==='thue-xe-hanh-trinh'&&r.output_path.startsWith('kinh-nghiem/'))).slice(0,3);
 return `<section class="hub-card glass-strong" aria-labelledby="hub-${g.id}">
<h2 id="hub-${g.id}">${esc(g.label)}</h2>
<p class="hub-desc">${esc(g.desc)}</p>
<div class="child-chips">${kids}</div>
${arts.length?`<h3 class="hub-sub">Bài viết mới nhất</h3>
<ul class="cards">${arts.map(r=>artCard(r)).join('')}</ul>`:''}
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
<script src="/lab/assets/search.js"></script>`,cfg.base_url,
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
 const html=layout(title+' — Bản Đồ Xe 2 Bánh Việt Nam',`<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › ${esc(title)}</nav>
<h1>${esc(title)}</h1><p>${esc(desc)}</p>
<p class="siblings">Cùng nhóm <strong>${esc(group.label)}</strong>: ${sibs.map(s=>`<a class="sib-link" href="/lab/${s.slug}/">${esc(s.nav)}</a>`).join('')}</p>
<h2>Bài viết</h2><ul class="cards">${cards}</ul>`,cfg.base_url+h.slug+'/',
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
// Contact & About
fs.mkdirSync(path.join(SITE,'lien-he'));
fs.writeFileSync(path.join(SITE,'lien-he','index.html'),layout('Liên hệ',`<h1>Liên hệ</h1>
<p><strong>${esc(facts.business_name)}</strong></p>
<p>Email: <a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></p>
<p>Khu vực: ${esc(facts.location_summary)}</p>
<p class="fine">Số điện thoại, địa chỉ chính xác và giờ mở cửa chỉ hiển thị sau khi chủ sở hữu xác nhận. ${BRAND_FULL} không bịa thông tin NAP.</p>`,cfg.base_url+'lien-he/'));
fs.mkdirSync(path.join(SITE,'ve-chung-toi'));
fs.writeFileSync(path.join(SITE,'ve-chung-toi','index.html'),layout('Về chúng tôi',`<h1>Về chúng tôi</h1>
<p>${BRAND_FULL} là trang thông tin nghiên cứu về hệ sinh thái xe máy Việt Nam, vận hành bởi ${esc(facts.business_name)} (${esc(facts.location_summary)}). Dịch vụ cho thuê xe máy thực tế của chủ sở hữu hoạt động tại Hà Nội.</p>
<p>Trang này không phải trang kinh doanh và không có chi nhánh toàn quốc. Bài viết về địa phương ngoài Hà Nội mang tính hướng dẫn, không phải lời chào dịch vụ.</p>
<p>Thí nghiệm SEO hiện tại: baseline zero-backlink — xem <a href="/lab/reports/experiments/baseline.md">báo cáo baseline</a> trong repo.</p>`,cfg.base_url+'ve-chung-toi/'));
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
 fs.writeFileSync(dest,withShell(html));
});
// sitemap: index + shards
const shards={static:[]};
published.forEach(r=>{const c=r.cluster.toLowerCase();(shards[c]=shards[c]||[]).push(r);});
let shardFiles=[];
Object.entries(shards).forEach(([name,list])=>{
 const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[cfg.base_url].concat(list.map(r=>r.canonical)).map(u=>`<url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`;
 const fn='sitemap-'+name+'.xml';
 fs.writeFileSync(path.join(SITE,fn),xml);
 shardFiles.push(fn);
});
const extraUrls=[cfg.base_url+'lien-he/',cfg.base_url+'ve-chung-toi/',...HUBS.map(h=>cfg.base_url+h.slug+'/')];
fs.writeFileSync(path.join(SITE,'sitemap-static.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${extraUrls.map(u=>`<url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`);
if(!shardFiles.includes('sitemap-static.xml'))shardFiles.push('sitemap-static.xml');
fs.writeFileSync(path.join(SITE,'sitemap-index.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${shardFiles.map(f=>`<sitemap><loc>${cfg.base_url+f}</loc></sitemap>`).join('\n')}\n</sitemapindex>`);
fs.writeFileSync(path.join(SITE,'robots.txt'),`User-agent: *\nAllow: /\nDisallow: /lab/_drafts/\nSitemap: ${cfg.base_url}sitemap-index.xml\n`);
// search index (PUBLISHED only, minimal fields)
const idx=published.map(r=>({t:r.primary_keyword,d:r.secondary_keywords||r.primary_keyword,c:r.cluster,p:r.province,l:r.locality,poi:r.poi,b:r.brand,m:r.model,v:r.vehicle_type,u:r.output_path}));
fs.writeFileSync(path.join(SITE,'assets','search-index.json'),JSON.stringify(idx));
fs.writeFileSync(path.join(SITE,'assets','search.js'),`let IDX=null;
fetch('/lab/assets/search-index.json').then(r=>r.json()).then(d=>IDX=d);
function doSearch(q){
 q=(q||'').toLowerCase().trim();
 const el=document.getElementById('search-results');
 if(!q||!IDX){el.innerHTML='';return;}
 const hits=IDX.filter(x=>(x.t+' '+x.d+' '+x.p+' '+x.l+' '+x.m).toLowerCase().includes(q)).slice(0,10);
 el.innerHTML=hits.length?hits.map(h=>'<li><a href="/lab/'+h.u+'">'+h.t+'</a></li>').join(''):'<li>Không tìm thấy bài đã xuất bản nào.</li>';
}
`);
// minimal vanilla menu interactions: dropdowns (mouse/keyboard/focus/touch) + mobile drawer
fs.writeFileSync(path.join(SITE,'assets','menu.js'),MENU_JS());
// copy experiment baseline report for public link
fs.mkdirSync(path.join(SITE,'reports','experiments'),{recursive:true});
if(fs.existsSync(path.join(ROOT,'reports','experiments','baseline.md')))
 fs.copyFileSync(path.join(ROOT,'reports','experiments','baseline.md'),path.join(SITE,'reports','experiments','baseline.md'));
console.log('SITE BUILT. published='+published.length+' shards='+shardFiles.join(','));

// ---------- Liquid Glass stylesheet (deterministic) ----------
function CSS(){return `:root{
--bg:#f6f9f7;--text:#17222e;--muted:#54616e;--accent:#0b5c3b;--accent-soft:rgba(11,92,59,.12);
--ambient-green:rgba(72,178,130,.16);--ambient-blue:rgba(92,152,220,.14);--ambient-warm:rgba(216,186,140,.10);
--glass:rgba(255,255,255,.60);--glass-strong:rgba(255,255,255,.78);--glass-soft:rgba(255,255,255,.45);
--glass-border:rgba(255,255,255,.70);--glass-highlight:rgba(255,255,255,.85);--hairline:rgba(24,34,48,.08);
--glass-blur:blur(18px) saturate(150%);--glass-blur-strong:blur(22px) saturate(155%);
--glass-shadow:0 1px 2px rgba(24,34,48,.05),0 8px 24px -12px rgba(24,34,48,.14),inset 0 1px 0 var(--glass-highlight);
--glass-shadow-lift:0 2px 4px rgba(24,34,48,.06),0 16px 40px -14px rgba(24,34,48,.22),inset 0 1px 0 var(--glass-highlight);
--radius:18px;--radius-lg:22px;--radius-xl:28px}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text);line-height:1.72;
background:
 radial-gradient(720px 460px at 8% -6%,var(--ambient-green),transparent 62%),
 radial-gradient(780px 500px at 102% -2%,var(--ambient-blue),transparent 58%),
 radial-gradient(900px 640px at 50% 112%,var(--ambient-warm),transparent 60%),
 var(--bg);
background-attachment:fixed;color-scheme:light;overflow-wrap:break-word}
.wrap{max-width:860px;margin:0 auto;padding:0 16px}
@supports not ((backdrop-filter:blur(2px)) or (-webkit-backdrop-filter:blur(2px))){
 .glass,.glass-strong,.glass-nav,.glass-menu,.glass-footer,.hero,.card,.breadcrumb{background:rgba(255,255,255,.95)!important}}
/* ---------- reusable glass primitives ---------- */
.glass{background:var(--glass);border:1px solid var(--glass-border);outline:1px solid var(--hairline);
 border-radius:var(--radius);box-shadow:var(--glass-shadow);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}
.glass-strong{background:var(--glass-strong);border:1px solid var(--glass-border);outline:1px solid var(--hairline);
 border-radius:var(--radius-lg);box-shadow:var(--glass-shadow-lift);backdrop-filter:var(--glass-blur-strong);-webkit-backdrop-filter:var(--glass-blur-strong);position:relative;overflow:hidden}
.glass-strong::before{content:"";position:absolute;inset:0 0 auto 0;height:56px;pointer-events:none;
 background:linear-gradient(180deg,rgba(255,255,255,.65),rgba(255,255,255,0))}
main{padding:22px 0 40px;overflow-wrap:anywhere}
h1{line-height:1.22;font-size:1.75rem;letter-spacing:-.015em}
h2{margin-top:1.6em;line-height:1.3;font-size:1.3rem;letter-spacing:-.01em}
h3{line-height:1.35;font-size:1.08rem}
h1,h2,h3{scroll-margin-top:92px}
a{color:var(--accent)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
/* ---------- floating liquid-glass header ---------- */
.site-head{position:sticky;top:10px;z-index:50;padding:0 10px}
.nav-shell{max-width:1080px;display:flex;align-items:center;gap:10px;min-height:58px;
 padding:8px 14px 8px 18px;border-radius:20px;position:relative;overflow:visible}
.nav-shell::before{content:"";position:absolute;inset:0 0 auto 0;height:26px;border-radius:20px 20px 0 0;pointer-events:none;
 background:linear-gradient(180deg,rgba(255,255,255,.6),rgba(255,255,255,0))}
.brand{font-weight:700;color:var(--accent);text-decoration:none;font-size:1.05rem;letter-spacing:-.01em;white-space:nowrap;margin-right:auto}
.main-nav{display:none;align-items:center;gap:2px}
.nav-link{color:var(--muted);text-decoration:none;font-size:.92rem;padding:8px 10px;border-radius:10px;transition:color .18s,background .18s}
.nav-link:hover{color:var(--accent);background:rgba(11,92,59,.08)}
.nav-group{position:relative}
.nav-drop{display:flex;align-items:center;gap:5px;background:0;border:0;cursor:pointer;font:inherit;
 color:var(--muted);font-size:.92rem;padding:8px 10px;border-radius:10px;transition:color .18s,background .18s}
.nav-drop:hover,.nav-drop[aria-expanded="true"]{color:var(--accent);background:rgba(11,92,59,.08)}
.nav-drop .chev{font-size:.7rem;transition:transform .2s}
.nav-drop[aria-expanded="true"] .chev{transform:rotate(180deg)}
.nav-drop:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.dropdown{position:absolute;top:calc(100% + 8px);left:0;min-width:250px;padding:8px;z-index:60;
 opacity:0;visibility:hidden;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease,visibility .18s;
 border-radius:20px}
.nav-group.open .dropdown{opacity:1;visibility:visible;transform:translateY(0)}
.dd-link{display:block;text-decoration:none;padding:10px 14px;border-radius:12px;transition:background .16s}
.dd-link:hover{background:rgba(11,92,59,.08)}
.dd-title{display:block;color:var(--text);font-weight:600;font-size:.95rem}
.dd-desc{display:block;color:var(--muted);font-size:.8rem;margin-top:2px}
.nav-actions{display:flex;align-items:center;gap:4px}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;font-size:1.05rem;
 color:var(--text);text-decoration:none;background:0;border:0;border-radius:12px;cursor:pointer;transition:background .18s}
.icon-btn:hover{background:rgba(11,92,59,.08)}
.icon-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
/* mobile liquid-glass drawer */
.drawer{position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;padding:14px;
 background:var(--glass-strong);backdrop-filter:var(--glass-blur-strong);-webkit-backdrop-filter:var(--glass-blur-strong)}
.drawer[hidden]{display:none}
.drawer-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.dr-brand{font-weight:700;color:var(--accent)}
.drawer-nav{overflow-y:auto;flex:1}
.dr-label{font-size:.72rem;font-weight:700;letter-spacing:.08em;color:var(--muted);margin:16px 0 4px;text-transform:uppercase}
.dr-link{display:flex;align-items:center;min-height:44px;padding:6px 12px;color:var(--text);text-decoration:none;
 font-size:.98rem;border-radius:12px;transition:background .16s}
.dr-link:hover{background:rgba(11,92,59,.08)}
.drawer-foot{border-top:1px solid var(--hairline);padding-top:8px;margin-top:12px}
@media(min-width:1024px){
 .main-nav{display:flex}
 .menu-toggle{display:none}
 .drawer[hidden]{display:none}}
@media(max-width:1023px){.main-nav{display:none}}
/* ---------- hero ---------- */
.hero{position:relative;padding:30px 26px 26px;margin-top:8px;border-radius:var(--radius-xl)}
.hero::before{content:"";position:absolute;inset:0 0 auto 0;height:64px;border-radius:var(--radius-xl) var(--radius-xl) 0 0;
 background:linear-gradient(180deg,rgba(255,255,255,.75),rgba(255,255,255,0));pointer-events:none}
.hero::after{content:"";position:absolute;top:-36%;left:-12%;width:52%;height:120%;transform:rotate(18deg);pointer-events:none;
 background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent)}
.eyebrow{margin:0 0 6px;font-size:.78rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.lead{font-size:1.05rem;color:#2b3a49;margin:.4em 0 1.2em}
.hero .searchbox{margin-top:6px}
.postmeta{color:var(--muted);font-size:.85rem;margin-bottom:18px}
/* ---------- parent hub cards (strongest depth) ---------- */
.hub-grid{display:grid;grid-template-columns:1fr;gap:14px;margin:18px 0}
.hub-card{padding:22px 22px 20px}
.hub-card h2{margin:0 0 6px;font-size:1.18rem}
.hub-desc{color:var(--muted);margin:0 0 12px;font-size:.95rem}
.hub-sub{font-size:.85rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 8px}
.child-chips{display:flex;flex-wrap:wrap;gap:8px}
.child-chip{display:flex;flex-direction:column;gap:2px;padding:12px 16px;text-decoration:none;border-radius:14px;
 transition:transform .18s ease,box-shadow .18s ease;min-width:150px}
.child-chip:hover{transform:translateY(-2px)}
.chip-title{color:var(--text);font-weight:600}
.chip-count{color:var(--muted);font-size:.78rem}
@media(min-width:768px){.hub-grid{grid-template-columns:1fr 1fr}}
/* sibling links on child hubs */
.siblings{font-size:.9rem;color:var(--muted);margin:.6em 0 1.4em}
.sib-link{display:inline-block;padding:6px 14px;margin-right:6px;background:var(--glass-soft);border:1px solid var(--glass-border);
 border-radius:999px;text-decoration:none;font-weight:600}
/* ---------- breadcrumb glass pill ---------- */
.breadcrumb{font-size:.83rem;color:var(--muted);margin:0 0 14px;display:inline-block;background:rgba(255,255,255,.55);
 border:1px solid var(--glass-border);border-radius:999px;padding:5px 14px;box-shadow:var(--glass-shadow)}
/* ---------- tables ---------- */
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;border-radius:12px}
th,td{border:1px solid var(--hairline);padding:9px 12px;text-align:left;background:rgba(255,255,255,.6);overflow-wrap:anywhere}
th{background:rgba(255,255,255,.85);font-weight:600}
.quick{position:relative;background:linear-gradient(180deg,rgba(236,250,242,.92),rgba(255,255,255,.8));
 border:1px solid rgba(11,92,59,.16);border-left:4px solid var(--accent);border-radius:14px;padding:14px 18px;margin:18px 0;
 box-shadow:0 4px 16px -8px rgba(11,92,59,.18)}
blockquote{margin:1.2em 0;padding:10px 18px;border-left:3px solid var(--accent);background:rgba(255,255,255,.6);border-radius:0 12px 12px 0}
/* ---------- article cards (lighter editorial surface) ---------- */
ul.cards{list-style:none;padding:0;display:grid;grid-template-columns:1fr;gap:10px}
.card{position:relative;border-radius:var(--radius);padding:16px 18px;background:var(--glass-soft);
 border:1px solid var(--glass-border);outline:1px solid var(--hairline);box-shadow:0 1px 2px rgba(24,34,48,.04),0 6px 18px -10px rgba(24,34,48,.12);
 backdrop-filter:blur(10px) saturate(140%);-webkit-backdrop-filter:blur(10px) saturate(140%);
 transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.card::before{content:"";position:absolute;inset:0 0 auto 0;height:40%;border-radius:var(--radius) var(--radius) 0 0;
 background:linear-gradient(180deg,rgba(255,255,255,.5),rgba(255,255,255,0));pointer-events:none}
.card:hover{transform:translateY(-2px);box-shadow:var(--glass-shadow-lift);border-color:rgba(11,92,59,.22)}
.card a{font-weight:600;text-decoration:none}
.card .meta{color:var(--muted);font-size:.85rem;margin-top:4px}
@media(min-width:640px){ul.cards{grid-template-columns:1fr 1fr}}
/* ---------- article reading surface ---------- */
.wrap.article,.article .wrap{max-width:780px;margin-top:8px;padding:26px 22px 30px;border-radius:var(--radius-lg);
 background:var(--glass-strong);border:1px solid var(--glass-border);outline:1px solid var(--hairline);
 box-shadow:var(--glass-shadow);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);position:relative;overflow:hidden}
.wrap.article::before,.article .wrap::before{content:"";position:absolute;inset:0 0 auto 0;height:50px;pointer-events:none;
 background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,0))}
.article h1,.wrap.article h1{margin-top:0}
article p,main p{font-size:1.0625rem;line-height:1.78}
/* ---------- search ---------- */
.searchbox{width:100%;padding:12px 16px;font-size:1rem;color:var(--text);border-radius:999px;
 border:1px solid var(--glass-border);outline:1px solid var(--hairline);background:rgba(255,255,255,.72);
 box-shadow:inset 0 1px 2px rgba(24,34,48,.05),var(--glass-shadow);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 transition:box-shadow .18s ease,border-color .18s ease}
.searchbox::placeholder{color:var(--muted)}
.searchbox:focus{outline:none;border-color:rgba(11,92,59,.45);box-shadow:0 0 0 3px rgba(11,92,59,.18),var(--glass-shadow)}
#search-results{margin-top:10px}
#search-results li{margin:6px 0}
/* ---------- liquid-glass footer ---------- */
.site-foot{padding:14px 0 34px;margin-top:12px}
.foot-shell{border-radius:var(--radius-xl);padding:26px 26px 18px;position:relative;overflow:hidden;
 background:var(--glass-strong);border:1px solid var(--glass-border);outline:1px solid var(--hairline);
 box-shadow:var(--glass-shadow-lift);backdrop-filter:var(--glass-blur-strong);-webkit-backdrop-filter:var(--glass-blur-strong)}
.foot-shell::before{content:"";position:absolute;inset:0 0 auto 0;height:48px;pointer-events:none;
 background:linear-gradient(180deg,rgba(255,255,255,.6),rgba(255,255,255,0))}
.foot-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px 18px;position:relative}
.foot-brand{font-weight:700;color:var(--accent);margin:0 0 6px;font-size:1.02rem;letter-spacing:-.01em}
.foot-desc{color:var(--muted);font-size:.9rem;margin:0 0 10px}
.foot-label{font-size:.72rem;font-weight:700;letter-spacing:.08em;color:var(--muted);margin:0 0 6px;text-transform:uppercase}
.foot-links{list-style:none;padding:0;margin:0 0 14px}
.foot-links li{margin:0}
.foot-links a{display:inline-block;color:var(--text);text-decoration:none;font-size:.9rem;padding:5px 0;transition:color .16s}
.foot-links a:hover{color:var(--accent)}
.foot-bottom{border-top:1px solid var(--hairline);margin-top:4px;padding-top:12px;color:var(--muted);font-size:.85rem;position:relative}
.foot-bottom p{margin:0 0 3px}
.fine{font-size:.8rem}
.foot-brand-col{grid-column:1/-1}
@media(min-width:768px){
 .foot-grid{grid-template-columns:1.3fr 1fr 1fr 1fr}
 .foot-brand-col{grid-column:auto}}
/* ---------- motion & misc ---------- */
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}
 .card:hover,.child-chip:hover{transform:none}}
`;}
function MENU_JS(){return `// menu.js — tiny vanilla menu interactions (dropdowns + mobile drawer). No frameworks.
(function(){
'use strict';
var groups=[].slice.call(document.querySelectorAll('.nav-group'));
function closeGroup(g){g.classList.remove('open');var b=g.querySelector('.nav-drop');if(b)b.setAttribute('aria-expanded','false');}
function toggleGroup(g){
 var open=!g.classList.contains('open');
 groups.forEach(closeGroup);
 if(open){g.classList.add('open');var b=g.querySelector('.nav-drop');if(b)b.setAttribute('aria-expanded','true');}
}
groups.forEach(function(g){
 var btn=g.querySelector('.nav-drop');
 if(!btn)return;
 btn.addEventListener('click',function(e){e.stopPropagation();toggleGroup(g);});
 btn.addEventListener('keydown',function(e){
  if(e.key==='ArrowDown'||e.key==='Enter'||e.key===' '){e.preventDefault();toggleGroup(g);
   if(g.classList.contains('open')){var f=g.querySelector('.dd-link');if(f)f.focus();}}
 });
 // hover-intent open for fine pointers (click still works for touch/keyboard)
 g.addEventListener('mouseenter',function(){if(window.matchMedia('(hover:hover) and (pointer:fine)').matches){
  groups.forEach(closeGroup);g.classList.add('open');btn.setAttribute('aria-expanded','true');}});
 g.addEventListener('mouseleave',function(){if(window.matchMedia('(hover:hover) and (pointer:fine)').matches)closeGroup(g);});
 g.querySelectorAll('.dd-link').forEach(function(a){
  a.addEventListener('keydown',function(e){if(e.key==='Escape'){closeGroup(g);btn.focus();}});
 });
});
document.addEventListener('click',function(e){groups.forEach(function(g){if(!g.contains(e.target))closeGroup(g);});});
document.addEventListener('keydown',function(e){if(e.key==='Escape')groups.forEach(closeGroup);});
// mobile drawer
var toggle=document.querySelector('.menu-toggle'),drawer=document.getElementById('drawer');
function setDrawer(open){
 if(!drawer)return;
 if(open){drawer.hidden=false;drawer.setAttribute('aria-hidden','false');}
 else{drawer.hidden=true;drawer.setAttribute('aria-hidden','true');}
 if(toggle)toggle.setAttribute('aria-expanded',String(open));
 if(open){var c=drawer.querySelector('.drawer-close');if(c)c.focus();}
 else if(toggle)toggle.focus();
}
if(toggle&&drawer){
 toggle.addEventListener('click',function(){setDrawer(drawer.hidden);});
 var close=drawer.querySelector('.drawer-close');
 if(close)close.addEventListener('click',function(){setDrawer(false);});
 drawer.addEventListener('click',function(e){if(e.target===drawer)setDrawer(false);});
 document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!drawer.hidden)setDrawer(false);});
}
// deep link to homepage search
if(location.pathname==='/lab/'&&location.hash==='#q'){
 var q=document.getElementById('q');if(q){q.focus();}
}
})();`;}
