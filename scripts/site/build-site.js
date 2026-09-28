#!/usr/bin/env node
/** build-site.js — deterministic static site builder.
 * Generates: homepage, topic hubs, geo hubs (with content), contact/about,
 * sitemap-index.xml + shards (PUBLISHED only), robots.txt, search index (PUBLISHED only),
 * and restores published article pages from data/published/ archive. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'site');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'site.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'business-facts.json'), 'utf8'));
function parseCSV(text){const L=text.split('\n');const H=parseLine(L[0]);return L.slice(1).filter(l=>l.trim()).map(l=>{const c=parseLine(l);const o={};H.forEach((h,i)=>o[h]=c[i]||'');return o;});}
function parseLine(line){const out=[];let cur='',q=false;for(let i=0;i<line.length;i++){const c=line[i];
 if(q){if(c==='"'){if(line[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=c;}
 else{if(c==='"')q=true;else if(c===','){out.push(cur);cur='';}else cur+=c;}}
 out.push(cur);return out;}
const parts=fs.readdirSync(path.join(ROOT,'data')).filter(f=>/^content-matrix\.csv\.part/.test(f)).sort();
let csvText=fs.readFileSync(path.join(ROOT,'data','content-matrix.csv'),'utf8');
if(parts.length)csvText=parts.map(p=>fs.readFileSync(path.join(ROOT,'data',p),'utf8')).join('');
const rows=parseCSV(csvText);
const published=rows.filter(r=>r.status==='PUBLISHED');
const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const HUBS=[
 {slug:'thue-xe-may',title:'Thuê xe máy',desc:'Kinh nghiệm, giá và hướng dẫn thuê xe máy tại các tỉnh thành Việt Nam.'},
 {slug:'cuu-ho-xe-may',title:'Cứu hộ xe máy',desc:'Cách tìm và chọn cứu hộ xe máy nhanh, an toàn khi gặp sự cố trên đường.'},
 {slug:'sua-xe-may',title:'Sửa chữa & bảo dưỡng xe máy',desc:'Hướng dẫn sửa chữa, bảo dưỡng xe máy các dòng phổ thông và xe điện.'},
 {slug:'bang-lai-xe-may',title:'Bằng lái xe máy',desc:'Hồ sơ, lệ phí, quy trình thi bằng lái xe máy A1 và thủ tục đổi/cấp lại.'},
 {slug:'dang-ky-xe-may',title:'Đăng ký xe máy',desc:'Thủ tục đăng ký, sang tên, lệ phí trước bạ và biển số xe máy theo quy định hiện hành.'},
 {slug:'xe-may-dien',title:'Xe máy điện',desc:'Xe máy điện Việt Nam: giá, pin, trạm sạc, chi phí và so sánh với xe xăng.'},
 {slug:'phu-tung',title:'Phụ tùng xe máy',desc:'Cách chọn lốp, ắc quy, bugi, nhông xích, dầu máy và phụ tùng xe điện.'},
 {slug:'kinh-nghiem',title:'Kinh nghiệm xe máy',desc:'Kinh nghiệm sử dụng, lái xe an toàn và vận hành xe máy dài hạn.'},
];
const layout=(title,content,canonical,extra)=>{
 const nav=HUBS.map(h=>`<a href="/lab/${h.slug}/">${h.title}</a>`).join('');
 return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(title)} — Motorbike SEO Lab">
<link rel="canonical" href="${canonical}">
${extra||''}
<link rel="stylesheet" href="/lab/assets/style.css">
</head>
<body>
<header class="site-head"><div class="wrap"><a class="brand" href="/lab/">Motorbike SEO Lab</a><nav>${nav}<a href="/lab/lien-he/">Liên hệ</a><a href="/lab/ve-chung-toi/">Về chúng tôi</a></nav></div></header>
<main class="wrap">${content}</main>
<footer class="site-foot"><div class="wrap">
<p>${esc(facts.business_name)} — ${esc(facts.location_summary)}</p>
<p><a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></p>
<p class="fine">Trang thông tin nghiên cứu về hệ sinh thái xe máy Việt Nam. Không phải trang dịch vụ toàn quốc.</p>
</div></footer>
</body>
</html>`;
};
fs.rmSync(SITE,{recursive:true,force:true});
fs.mkdirSync(SITE,{recursive:true});
fs.mkdirSync(path.join(SITE,'assets'),{recursive:true});
fs.writeFileSync(path.join(SITE,'assets','style.css'),`:root{--ink:#1a202c;--mut:#5a6572;--line:#e2e8f0;--acc:#0b5c3b}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);line-height:1.7}
.wrap{max-width:860px;margin:0 auto;padding:0 16px}
.site-head{border-bottom:1px solid var(--line);padding:14px 0}
.brand{font-weight:700;color:var(--acc);text-decoration:none;font-size:1.15rem}
nav{margin-top:6px;display:flex;flex-wrap:wrap;gap:12px}nav a{color:var(--mut);text-decoration:none;font-size:.95rem}
main{padding:24px 0}h1{line-height:1.25}h2{margin-top:1.6em}
a{color:var(--acc)}
.site-foot{border-top:1px solid var(--line);padding:20px 0;color:var(--mut);font-size:.9rem}
.fine{font-size:.8rem}
.breadcrumb{font-size:.85rem;color:var(--mut);margin-bottom:8px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:8px;text-align:left}
.quick{background:#f0fdf4;border-left:4px solid var(--acc);padding:12px 16px;margin:16px 0}
ul.cards{list-style:none;padding:0}ul.cards li{border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:8px 0}
.card a{font-weight:600;text-decoration:none}.card .meta{color:var(--mut);font-size:.85rem}
.searchbox{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:1rem}
#search-results li{margin:6px 0}
`);
// Homepage
const hqCards=published.map(r=>`<li class="card"><a href="/lab/${r.output_path}">${esc(r.primary_keyword)}</a><div class="meta">${r.cluster} · QA ${esc(r.qa_score)} · ${esc(r.published_date)}</div></li>`).join('\n');
const home=layout('Việt Nam Motorbike SEO Lab — nghiên cứu hệ sinh thái xe máy toàn quốc',`
<h1>Việt Nam Motorbike SEO Lab</h1>
<p>Nghiên cứu thực địa về hệ sinh thái xe máy Việt Nam: <strong>thuê xe máy</strong>, cứu hộ, sửa chữa, bằng lái, đăng ký, xe máy điện và phụ tùng — tại 34 tỉnh thành hiện hành.</p>
<input id="q" class="searchbox" type="search" placeholder="Tìm bài viết… (ví dụ: thuê xe máy Hà Nội)" oninput="doSearch(this.value)">
<ul id="search-results"></ul>
<h2>Chủ đề</h2>
<ul class="cards">${HUBS.map(h=>`<li class="card"><a href="/lab/${h.slug}/">${h.title}</a><div class="meta">${h.desc}</div></li>`).join('')}</ul>
<h2>Bài viết mới</h2>
<ul class="cards">${hqCards}</ul>
<script src="/lab/assets/search.js"></script>`,cfg.base_url,
`<script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"WebSite",name:"Việt Nam Motorbike SEO Lab",url:cfg.base_url})}</script>`);
fs.writeFileSync(path.join(SITE,'index.html'),home);
// Topic hubs
HUBS.forEach(h=>{
 const arts=published.filter(r=>r.output_path.startsWith(h.slug+'/')||(h.slug==='kinh-nghiem'&&!HUBS.slice(0,7).some(x=>r.output_path.startsWith(x.slug+'/'))));
 const cards=arts.map(r=>`<li class="card"><a href="/lab/${r.output_path}">${esc(r.primary_keyword)}</a><div class="meta">${r.cluster} · ${esc(r.province||'toàn quốc')}</div></li>`).join('\n')||'<li class="card">Chưa có bài PUBLISHED — sẽ ra mắt theo lộ trình nhà máy nội dung.</li>';
 const upcoming=rows.filter(r=>r.output_path.startsWith(h.slug+'/')).length;
 const html=layout(h.title+' — Motorbike SEO Lab',`<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › ${h.title}</nav>
<h1>${h.title}</h1><p>${h.desc}</p>
<h2>Bài viết đã xuất bản</h2><ul class="cards">${cards}</ul>
<p class="fine">${upcoming} bài trong chủ đề này nằm trong lộ trình biên tập.</p>`,cfg.base_url+h.slug+'/',
`<script type="application/ld+json">${JSON.stringify({"@context":"https://schema.org","@type":"CollectionPage",name:h.title,description:h.desc,url:cfg.base_url+h.slug+'/'})}</script>`);
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
 fs.writeFileSync(path.join(dir,'index.html'),layout('Xe máy tại '+prov,`<nav class="breadcrumb"><a href="/lab/">Trang chủ</a> › Địa phương › ${esc(prov)}</nav><h1>Xe máy tại ${esc(prov)}</h1><p>Các bài viết về hệ sinh thái xe máy tại ${esc(prov)} trên Lab.</p><ul class="cards">${cards}</ul>`,cfg.base_url+'dia-phuong/'+slug+'/'));
});
// Contact & About
fs.mkdirSync(path.join(SITE,'lien-he'));
fs.writeFileSync(path.join(SITE,'lien-he','index.html'),layout('Liên hệ',`<h1>Liên hệ</h1>
<p><strong>${esc(facts.business_name)}</strong></p>
<p>Email: <a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></p>
<p>Khu vực: ${esc(facts.location_summary)}</p>
<p class="fine">Số điện thoại, địa chỉ chính xác và giờ mở cửa chỉ hiển thị sau khi chủ sở hữu xác nhận (xem config/business-facts.json — status REQUIRES_VERIFICATION). Lab không bịa thông tin NAP.</p>`,cfg.base_url+'lien-he/'));
fs.mkdirSync(path.join(SITE,'ve-chung-toi'));
fs.writeFileSync(path.join(SITE,'ve-chung-toi','index.html'),layout('Về chúng tôi',`<h1>Về chúng tôi</h1>
<p>Motorbike SEO Lab là trang thông tin nghiên cứu về hệ sinh thái xe máy Việt Nam, vận hành bởi ${esc(facts.business_name)} (${esc(facts.location_summary)}). Dịch vụ cho thuê xe máy thực tế của chủ sở hữu hoạt động tại Hà Nội.</p>
<p>Trang này không phải trang kinh doanh và không có chi nhánh toàn quốc. Bài viết về địa phương ngoài Hà Nội mang tính hướng dẫn, không phải lời chào dịch vụ.</p>
<p>Thí nghiệm SEO hiện tại: baseline zero-backlink — xem <a href="/lab/reports/experiments/baseline.md">báo cáo baseline</a> trong repo.</p>`,cfg.base_url+'ve-chung-toi/'));
// Restore published article pages from durable archive
published.forEach(r=>{
 const src=path.join(ROOT,'data','published',r.article_id+'.html');
 const dest=path.join(SITE,r.output_path.replace(/^\//,''),'index.html');
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 if(!fs.existsSync(src)) throw new Error('PUBLISHED but no archived article: '+r.article_id);
 fs.writeFileSync(dest,fs.readFileSync(src,'utf8'));
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
// copy experiment baseline report for public link
fs.mkdirSync(path.join(SITE,'reports','experiments'),{recursive:true});
if(fs.existsSync(path.join(ROOT,'reports','experiments','baseline.md')))
 fs.copyFileSync(path.join(ROOT,'reports','experiments','baseline.md'),path.join(SITE,'reports','experiments','baseline.md'));
console.log('SITE BUILT. published='+published.length+' shards='+shardFiles.join(','));
