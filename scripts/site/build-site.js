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
<p>Thí nghiệm SEO hiện tại: baseline zero-backlink — xem <a href="/lab/reports/experiments/baseline.md">báo cáo baseline</a> thí nghiệm.</p>`,cfg.base_url+'ve-chung-toi/'));
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
// copy experiment baseline report for public link
fs.mkdirSync(path.join(SITE,'reports','experiments'),{recursive:true});
if(fs.existsSync(path.join(ROOT,'reports','experiments','baseline.md')))
 fs.copyFileSync(path.join(ROOT,'reports','experiments','baseline.md'),path.join(SITE,'reports','experiments','baseline.md'));
console.log('SITE BUILT. published='+published.length+' shards='+shardFiles.join(','));

// ---------- premium editorial stylesheet (deterministic) ----------
function CSS(){return `:root{
--bg:#f6f9f7;--surface:rgba(255,255,255,.66);--surface-strong:rgba(255,255,255,.86);
--text:#17222e;--muted:#54616e;--accent:#0b5c3b;--accent-soft:rgba(11,92,59,.10);
--ambient-green:rgba(72,178,130,.15);--ambient-blue:rgba(92,152,220,.13);--ambient-warm:rgba(216,186,140,.09);
--glass:rgba(255,255,255,.66);--glass-strong:rgba(255,255,255,.84);--glass-soft:rgba(255,255,255,.5);
--glass-border:rgba(255,255,255,.72);--glass-highlight:rgba(255,255,255,.9);--hairline:rgba(24,34,48,.08);
--glass-blur:blur(18px) saturate(150%);--glass-blur-strong:blur(22px) saturate(155%);
--glass-shadow:0 1px 2px rgba(24,34,48,.05),0 8px 24px -12px rgba(24,34,48,.13),inset 0 1px 0 var(--glass-highlight);
--glass-shadow-lift:0 2px 4px rgba(24,34,48,.06),0 16px 40px -14px rgba(24,34,48,.2),inset 0 1px 0 var(--glass-highlight);
--radius-sm:10px;--radius:16px;--radius-lg:20px;--radius-xl:26px;
--transition-fast:160ms ease;--transition-normal:200ms ease;
--space-1:6px;--space-2:10px;--space-3:16px;--space-4:22px;--space-5:30px}
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
 .glass,.glass-strong,.glass-nav,.glass-menu,.glass-footer,.hero,.card,.breadcrumb,.toc{background:rgba(255,255,255,.96)!important}}
/* ---------- glass primitives (20-30% of surfaces; reading surfaces stay opaque) ---------- */
.glass{background:var(--glass);border:1px solid var(--glass-border);outline:1px solid var(--hairline);
 border-radius:var(--radius);box-shadow:var(--glass-shadow);backdrop-filter:var(--glass-blur);-webkit-backdrop-filter:var(--glass-blur)}
.glass-strong{background:var(--glass-strong);border:1px solid var(--glass-border);outline:1px solid var(--hairline);
 border-radius:var(--radius-lg);box-shadow:var(--glass-shadow-lift);backdrop-filter:var(--glass-blur-strong);-webkit-backdrop-filter:var(--glass-blur-strong);position:relative;overflow:hidden}
.glass-strong::before{content:"";position:absolute;inset:0 0 auto 0;height:52px;pointer-events:none;
 background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,0))}
main{padding:22px 0 40px;overflow-wrap:anywhere}
a{color:var(--accent)}
a:focus-visible,.btn:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
/* ---------- header nav pills ---------- */
.site-head{position:sticky;top:10px;z-index:50;padding:0 10px}
.nav-shell{max-width:1120px;display:flex;align-items:center;gap:var(--space-1);min-height:58px;
 padding:8px 12px 8px 18px;border-radius:var(--radius-lg);position:relative}
.nav-shell::before{content:"";position:absolute;inset:0 0 auto 0;height:24px;border-radius:var(--radius-lg) var(--radius-lg) 0 0;pointer-events:none;
 background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,0))}
.brand{font-weight:700;color:var(--accent);text-decoration:none;font-size:1.05rem;letter-spacing:-.01em;white-space:nowrap;margin-right:auto}
.main-nav{display:none;align-items:center;gap:2px}
.nav-link,.nav-drop{display:inline-flex;align-items:center;gap:5px;color:var(--muted);font:inherit;font-size:.92rem;
 padding:9px 12px;border-radius:999px;border:1px solid transparent;background:0;cursor:pointer;text-decoration:none;
 transition:color var(--transition-fast),background var(--transition-fast),border-color var(--transition-fast)}
.nav-link:hover,.nav-drop:hover{color:var(--accent);background:rgba(11,92,59,.07);border-color:rgba(11,92,59,.14)}
.nav-drop .chev{font-size:.65rem;transition:transform var(--transition-normal)}
.nav-drop[aria-expanded="true"] .chev{transform:rotate(180deg)}
.nav-drop.active,.nav-link.active{color:var(--accent);border-color:rgba(11,92,59,.28);background:var(--accent-soft)}
.nav-drop.active::after{content:"";position:absolute;left:50%;bottom:3px;transform:translateX(-50%);width:18px;height:3px;border-radius:2px;background:var(--accent)}
.nav-group{position:relative}
.nav-group.open .dropdown{opacity:1;visibility:visible;transform:translateY(0)}
.dropdown{position:absolute;top:calc(100% + 8px);left:0;min-width:260px;padding:8px;z-index:60;border-radius:var(--radius-lg);
 opacity:0;visibility:hidden;transform:translateY(6px);
 transition:opacity var(--transition-fast),transform var(--transition-fast),visibility var(--transition-fast)}
.dd-link{display:block;text-decoration:none;padding:10px 12px;border-radius:var(--radius);transition:background var(--transition-fast)}
.dd-link:hover{background:var(--accent-soft)}
.dd-link.active{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.dd-title{display:flex;align-items:center;gap:8px;color:var(--text);font-weight:600;font-size:.95rem}
.dd-icon{font-size:1rem;opacity:.9}
.dd-desc{display:block;color:var(--muted);font-size:.8rem;margin-top:2px}
.nav-actions{display:flex;align-items:center;gap:4px}
/* ---------- buttons ---------- */
.btn{display:inline-flex;align-items:center;gap:6px;min-height:42px;padding:10px 18px;border-radius:999px;
 font:inherit;font-size:.92rem;font-weight:600;text-decoration:none;cursor:pointer;border:1px solid transparent;
 transition:transform var(--transition-fast),box-shadow var(--transition-fast),border-color var(--transition-fast),background var(--transition-fast)}
.btn-primary{color:#fff;background:linear-gradient(180deg,rgba(23,142,94,.95),rgba(11,92,59,.95));
 border-color:rgba(11,92,59,.5);box-shadow:0 2px 10px -4px rgba(11,92,59,.5),inset 0 1px 0 rgba(255,255,255,.25)}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 6px 18px -6px rgba(11,92,59,.55),inset 0 1px 0 rgba(255,255,255,.25)}
.btn-secondary{color:var(--accent);background:var(--glass-soft);border-color:var(--glass-border);
 backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.btn-secondary:hover{transform:translateY(-1px);border-color:rgba(11,92,59,.3);background:rgba(255,255,255,.72)}
.btn-ghost{color:var(--accent);background:0;padding:10px 12px}
.btn-ghost:hover{background:var(--accent-soft)}
.btn-icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;font-size:1.05rem;
 color:var(--text);text-decoration:none;background:0;border:0;border-radius:12px;cursor:pointer;transition:background var(--transition-fast)}
.btn-icon:hover{background:var(--accent-soft)}
/* ---------- chips ---------- */
.hub-label{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;
 color:var(--accent);background:var(--accent-soft);border:1px solid rgba(11,92,59,.18);border-radius:999px;padding:4px 12px}
.category-chip,.article-chip{display:inline-block;font-size:.75rem;font-weight:600;color:var(--accent);text-decoration:none;
 background:var(--glass-soft);border:1px solid var(--glass-border);border-radius:999px;padding:3px 11px;
 backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
.article-chip{align-self:flex-start;margin-bottom:8px}
.category-chip:hover,.article-chip:hover{background:var(--accent-soft);border-color:rgba(11,92,59,.28)}
.meta-chip{display:inline-block;font-size:.75rem;color:var(--muted);background:rgba(24,34,48,.05);
 border-radius:999px;padding:3px 10px}
/* ---------- mobile drawer ---------- */
.drawer{position:fixed;inset:0;z-index:80;display:flex;flex-direction:column;padding:14px;
 background:var(--glass-strong);backdrop-filter:var(--glass-blur-strong);-webkit-backdrop-filter:var(--glass-blur-strong)}
.drawer[hidden]{display:none}
.drawer-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.dr-brand{font-weight:700;color:var(--accent)}
.drawer-nav{overflow-y:auto;flex:1}
.dr-label{font-size:.7rem;font-weight:700;letter-spacing:.09em;color:var(--muted);margin:14px 0 2px;text-transform:uppercase}
.dr-link{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 12px;color:var(--text);text-decoration:none;
 font-size:.98rem;border-radius:var(--radius-sm);transition:background var(--transition-fast)}
.dr-link:hover,.dr-link.active{background:var(--accent-soft);color:var(--accent)}
.drawer-foot{border-top:1px solid var(--hairline);padding-top:6px;margin-top:10px}
@media(min-width:1024px){.main-nav{display:flex}.menu-toggle{display:none}}
/* ---------- hero ---------- */
.hero{position:relative;padding:32px 28px 28px;margin-top:8px;border-radius:var(--radius-xl)}
.hero::before{content:"";position:absolute;inset:0 0 auto 0;height:64px;border-radius:var(--radius-xl) var(--radius-xl) 0 0;
 background:linear-gradient(180deg,rgba(255,255,255,.6),rgba(255,255,255,0));pointer-events:none}
.hero::after{content:"";position:absolute;top:-36%;left:-12%;width:52%;height:120%;transform:rotate(18deg);pointer-events:none;
 background:linear-gradient(90deg,transparent,rgba(255,255,255,.3),transparent)}
.eyebrow{margin:0 0 6px;font-size:.78rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.lead{font-size:1.05rem;color:#2b3a49;margin:.4em 0 1.2em}
.hero .searchbox{margin-top:6px}
.postmeta{color:var(--muted);font-size:.85rem;margin:0}
/* ---------- hub cards ---------- */
.hub-grid{display:grid;grid-template-columns:1fr;gap:14px;margin:18px 0}
.hub-card{padding:24px 24px 20px}
.hub-card h2{margin:8px 0 6px;font-size:1.2rem}
.hub-desc{color:var(--muted);margin:0 0 12px;font-size:.95rem}
.hub-sub{font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 0 8px}
.child-chips{display:flex;flex-wrap:wrap;gap:8px}
.child-chip{display:flex;flex-direction:column;gap:2px;padding:12px 16px;text-decoration:none;border-radius:var(--radius);
 transition:transform var(--transition-fast),box-shadow var(--transition-fast)}
.child-chip:hover{transform:translateY(-1px)}
.chip-title{color:var(--text);font-weight:600}
.chip-count{color:var(--muted);font-size:.78rem}
.hub-cta{margin-top:14px}
@media(min-width:768px){.hub-grid{grid-template-columns:1fr 1fr}}
/* ---------- section labels / siblings ---------- */
.section-label{font-size:.85rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:26px 0 10px}
.siblings{font-size:.9rem;color:var(--muted);margin:.6em 0 1.4em}
.sib-link{display:inline-block;padding:6px 14px;margin-right:6px;background:var(--glass-soft);border:1px solid var(--glass-border);
 border-radius:999px;text-decoration:none;font-weight:600;transition:background var(--transition-fast)}
.sib-link:hover{background:var(--accent-soft)}
/* ---------- breadcrumb ---------- */
.breadcrumb{font-size:.83rem;color:var(--muted);margin:0 0 14px;display:inline-block;background:rgba(255,255,255,.55);
 border:1px solid var(--glass-border);border-radius:999px;padding:5px 14px;box-shadow:var(--glass-shadow)}
/* ---------- article hero ---------- */
.article-hero{padding:26px 26px 22px;margin-bottom:16px;border-radius:var(--radius-xl)}
.article-hero .breadcrumb{margin-bottom:14px}
.article-hero h1{margin:10px 0 10px;font-size:clamp(1.55rem,4.5vw,2.1rem);line-height:1.28;letter-spacing:-.015em}
.article-lead{font-size:1.02rem;color:#2b3a49;margin:0 0 12px}
.wrap.article,.article .wrap{max-width:780px;margin-top:8px;padding:0;border:0;background:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
.article h1,.wrap.article h1{margin-top:0}
/* ---------- reading surface: near-solid ---------- */
.article-body,.wrap.article>*,.article .wrap>*{position:relative}
main.wrap.article{background:var(--surface-strong);border:1px solid var(--glass-border);border-radius:var(--radius-xl);
 box-shadow:var(--glass-shadow);padding:26px 24px 30px}
article p,main p{font-size:1.0625rem;line-height:1.8}
/* H2/H3 editorial accents */
h2{margin-top:1.8em;line-height:1.3;font-size:1.28rem;letter-spacing:-.01em;position:relative;padding-left:14px}
h2::before{content:"";position:absolute;left:0;top:.28em;width:4px;height:1em;border-radius:2px;background:var(--accent);opacity:.85}
h3{line-height:1.35;font-size:1.08rem;padding-left:14px}
h1,h2,h3{scroll-margin-top:96px}
h1{line-height:1.22;letter-spacing:-.015em}
h1::before,h1::after{content:none}
.article-hero h1,.hub-card h2,.toc h2,.related h2,.article-hub-cta h2,.foot-shell h2{padding-left:0}
.article-hero h1::before,.hub-card h2::before,.toc h2::before,.related h2::before,.article-hub-cta h2::before{content:none}
/* ---------- TOC ---------- */
.toc{margin:0 0 18px;padding:12px 16px;border-radius:var(--radius)}
.toc summary{cursor:pointer;font-weight:700;font-size:.9rem;color:var(--accent);padding:4px 2px}
.toc-list{margin:8px 0 4px;padding-left:20px;font-size:.92rem}
.toc-list li{margin:4px 0}
.toc-sub{font-size:.85rem;color:var(--muted)}
/* ---------- callouts ---------- */
.quick{position:relative;background:var(--surface-strong);border:1px solid rgba(11,92,59,.16);border-left:4px solid var(--accent);
 border-radius:var(--radius);padding:14px 18px;margin:18px 0;box-shadow:0 4px 16px -8px rgba(11,92,59,.18)}
.quick .quick-label::before{content:"⚡ "}
blockquote{margin:1.2em 0;padding:10px 18px;border-left:3px solid var(--accent);background:rgba(255,255,255,.72);border-radius:0 var(--radius-sm) var(--radius-sm) 0}
/* ---------- tables ---------- */
.table-scroll{overflow-x:auto;border-radius:var(--radius-sm);border:1px solid var(--hairline);-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;border-radius:var(--radius-sm)}
th,td{border:1px solid var(--hairline);padding:9px 12px;text-align:left;background:rgba(255,255,255,.85);overflow-wrap:anywhere}
th{background:rgba(240,246,243,.95);font-weight:600;position:sticky;top:0}
tbody tr:nth-child(even) td{background:rgba(246,250,248,.85)}
/* ---------- article cards ---------- */
ul.cards{list-style:none;padding:0;display:grid;grid-template-columns:1fr;gap:10px}
.card{position:relative;display:flex;flex-direction:column;border-radius:var(--radius);padding:16px 18px;background:var(--glass-soft);
 border:1px solid var(--glass-border);outline:1px solid var(--hairline);box-shadow:0 1px 2px rgba(24,34,48,.04),0 6px 18px -10px rgba(24,34,48,.12);
 backdrop-filter:blur(10px) saturate(140%);-webkit-backdrop-filter:blur(10px) saturate(140%);
 transition:transform var(--transition-fast),box-shadow var(--transition-normal),border-color var(--transition-fast)}
.card::before{content:"";position:absolute;inset:0 0 auto 0;height:40%;border-radius:var(--radius) var(--radius) 0 0;
 background:linear-gradient(180deg,rgba(255,255,255,.4),rgba(255,255,255,0));pointer-events:none}
.card:hover{transform:translateY(-2px);box-shadow:var(--glass-shadow-lift);border-color:rgba(11,92,59,.22)}
.card a{font-weight:600;text-decoration:none}
.card-title{color:var(--text);font-weight:700;text-decoration:none;font-size:1rem;line-height:1.4}
.card-title:hover{color:var(--accent)}
.card .meta{color:var(--muted);font-size:.85rem;margin-top:6px}
.card .read-more{margin-top:auto;align-self:flex-start;margin-top:10px;font-size:.88rem;font-weight:600;color:var(--accent);text-decoration:none}
.card .read-more:hover{text-decoration:underline}
@media(min-width:640px){ul.cards{grid-template-columns:1fr 1fr}.related ul.cards{grid-template-columns:1fr 1fr}}
/* ---------- related / prev-next / hub CTA ---------- */
.related{margin-top:26px}
.article-hub-cta{margin-top:18px;padding:18px 20px;border-radius:var(--radius-lg)}
.cta-line{margin:0 0 12px;font-size:.95rem}
.cta-row{display:flex;flex-wrap:wrap;gap:10px}
.pn-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}
.pn-card{display:flex;flex-direction:column;gap:3px;padding:12px 16px;text-decoration:none;border-radius:var(--radius);
 min-height:44px;transition:transform var(--transition-fast),border-color var(--transition-fast)}
.pn-card:hover{transform:translateY(-1px);border-color:rgba(11,92,59,.28)}
.pn-card.empty{visibility:hidden}
.pn-next{text-align:right}
.pn-label{font-size:.75rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--accent)}
.pn-title{font-size:.85rem;color:var(--muted);line-height:1.4}
/* ---------- search ---------- */
.searchbox{width:100%;padding:12px 16px;font-size:1rem;color:var(--text);border-radius:999px;
 border:1px solid var(--glass-border);outline:1px solid var(--hairline);background:rgba(255,255,255,.8);
 box-shadow:inset 0 1px 2px rgba(24,34,48,.05),var(--glass-shadow);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 transition:box-shadow var(--transition-fast),border-color var(--transition-fast)}
.searchbox::placeholder{color:var(--muted)}
.searchbox:focus{outline:none;border-color:rgba(11,92,59,.45);box-shadow:0 0 0 3px rgba(11,92,59,.18),var(--glass-shadow)}
#search-results{margin:12px 0 0;padding:0;list-style:none;display:grid;gap:8px}
#search-results .sr-card{display:flex;flex-direction:column;gap:4px;padding:12px 16px;border-radius:var(--radius);
 background:var(--glass-soft);border:1px solid var(--glass-border);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
 transition:transform var(--transition-fast),border-color var(--transition-fast)}
#search-results .sr-card:hover{transform:translateY(-1px);border-color:rgba(11,92,59,.28)}
#search-results .sr-title{font-weight:700;color:var(--text);text-decoration:none;font-size:.95rem}
#search-results .sr-title:hover{color:var(--accent)}
#search-results .sr-meta{font-size:.78rem;color:var(--muted)}
/* ---------- footer ---------- */
.site-foot{padding:14px 0 34px;margin-top:12px}
.foot-shell{border-radius:var(--radius-xl);padding:26px 26px 18px;position:relative}
.foot-shell::before{content:"";position:absolute;inset:0 0 auto 0;height:44px;pointer-events:none;
 background:linear-gradient(180deg,rgba(255,255,255,.5),rgba(255,255,255,0))}
.foot-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px 18px;position:relative}
.foot-brand{font-weight:700;color:var(--accent);margin:0 0 6px;font-size:1rem;letter-spacing:-.01em}
.foot-desc{color:var(--muted);font-size:.9rem;margin:0 0 10px}
.foot-label{font-size:.7rem;font-weight:700;letter-spacing:.09em;color:var(--muted);margin:0 0 6px;text-transform:uppercase}
.foot-label::before{content:"";display:inline-block;width:12px;height:2px;border-radius:1px;background:var(--accent);opacity:.6;margin-right:6px;vertical-align:middle}
.foot-links{list-style:none;padding:0;margin:0 0 14px}
.foot-links a{display:inline-flex;align-items:center;color:var(--text);text-decoration:none;font-size:.9rem;padding:5px 0;transition:color var(--transition-fast)}
.foot-links a::before{content:"";display:inline-block;width:0;height:2px;border-radius:1px;background:var(--accent);margin-right:0;transition:width var(--transition-fast),margin-right var(--transition-fast)}
.foot-links a:hover{color:var(--accent)}
.foot-links a:hover::before{width:10px;margin-right:6px}
.foot-bottom{border-top:1px solid var(--hairline);margin-top:4px;padding-top:12px;color:var(--muted);font-size:.85rem;position:relative}
.foot-bottom p{margin:0 0 3px}
.fine{font-size:.8rem}
.to-top{position:absolute;right:20px;bottom:16px;width:40px;height:40px;border-radius:12px;border:1px solid var(--glass-border);
 background:var(--glass-soft);color:var(--accent);font-size:1rem;cursor:pointer;
 transition:background var(--transition-fast),transform var(--transition-fast)}
.to-top:hover{background:var(--accent-soft);transform:translateY(-1px)}
.foot-brand-col{grid-column:1/-1}
@media(min-width:768px){.foot-grid{grid-template-columns:1.3fr 1fr 1fr 1fr}.foot-brand-col{grid-column:auto}}
/* ---------- progress bar ---------- */
.progress{position:fixed;top:0;left:0;height:3px;width:0;background:linear-gradient(90deg,rgba(23,142,94,.9),rgba(11,92,59,.9));
 z-index:100;border-radius:0 2px 2px 0;pointer-events:none;transition:width 60ms linear}
/* ---------- motion ---------- */
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}
 .card:hover,.child-chip:hover,.btn:hover,.pn-card:hover{transform:none}}
`;}
function MENU_JS(){return `// menu.js — tiny vanilla interactions: dropdowns, drawer, active nav, progress bar. No frameworks.
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
   if(g.classList.contains('open')){var f=g.querySelector('.dd-link');if(f)f.focus();}}});
 g.addEventListener('mouseenter',function(){if(window.matchMedia('(hover:hover) and (pointer:fine)').matches){
  groups.forEach(closeGroup);g.classList.add('open');btn.setAttribute('aria-expanded','true');}});
 g.addEventListener('mouseleave',function(){if(window.matchMedia('(hover:hover) and (pointer:fine)').matches)closeGroup(g);});
 [].forEach.call(g.querySelectorAll('.dd-link'),function(a){
  a.addEventListener('keydown',function(e){if(e.key==='Escape'){closeGroup(g);btn.focus();}});
 });
});
document.addEventListener('click',function(e){groups.forEach(function(g){if(!g.contains(e.target))closeGroup(g);});});
document.addEventListener('keydown',function(e){if(e.key==='Escape')groups.forEach(closeGroup);});
// mobile drawer
var toggle=document.querySelector('.menu-toggle'),drawer=document.getElementById('drawer');
function setDrawer(open){
 if(!drawer)return;
 drawer.hidden=!open;
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
// active nav state from current path
(function(){
 var path=location.pathname;
 [].forEach.call(document.querySelectorAll('[data-hub]'),function(el){
  var hub=el.getAttribute('data-hub');
  var link=el.getAttribute('href');
  if(!link)return;
  var seg=link.split('/').filter(Boolean).slice(1).join('/');
  if(seg&&('/lab/'+seg+'/')===path)el.classList.add('active');
 });
 [].forEach.call(document.querySelectorAll('.dr-link[href],.nav-link[href]'),function(el){
  if(el.getAttribute('href')==='/lab/'&&path==='/lab/')el.classList.add('active');
 });
 // highlight hub dropdown + drawer group containing the active child
 var active=document.querySelector('.dd-link.active');
 if(active){var g=active.closest('.nav-group');if(g){g.querySelector('.nav-drop').classList.add('active');}
  var dg=document.querySelector('.drawer [data-hub="'+active.getAttribute('data-hub')+'"]');
 }
})();
// reading progress bar (article pages)
(function(){
 var bar=document.createElement('div');bar.className='progress';bar.setAttribute('aria-hidden','true');
 var hasArticle=document.querySelector('.wrap.article, main article');
 if(!hasArticle)return;
 document.body.appendChild(bar);
 var raf=null;
 function update(){
  var h=document.documentElement;
  var max=h.scrollHeight-h.clientHeight;
  bar.style.width=(max>0?(h.scrollTop/max)*100:0)+'%';
  raf=null;
 }
 window.addEventListener('scroll',function(){if(!raf)raf=requestAnimationFrame(update);},{passive:true});
 update();
})();
// back to top
(function(){
 var btn=document.getElementById('to-top');
 if(btn)btn.addEventListener('click',function(){
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)window.scrollTo(0,0);
  else window.scrollTo({top:0,behavior:'smooth'});});
})();
})();`;}
