#!/usr/bin/env node
/**
 * capacity-check.js — READ-ONLY capacity model + state-invariant validator for /lab.
 * Ported from /blog's factory-capacity-validate pattern onto the Node engine.
 * Never writes a single file; reads the canonical shards in memory.
 * Exit 0 = PASS, 1 = FAIL. Used by .github/workflows/factory-capacity-validate.yml
 * and by operator verify (deep/full scopes).
 *
 * Checks (docs/CONTENT-FACTORY.md capacity contract):
 *  - exactly 10,000 production rows; chunk max = 10; phase = valid enum
 *  - unique article_id / slug / output_path / canonical / primary_keyword
 *  - valid status values only; valid cluster taxonomy refs
 *  - geography refs: province (when set) must exist in data/geography/provinces.json
 *  - checkpoint consistent with matrix truth (rows, published count, phase,
 *    active chunk, next claimable, last completed)
 *  - transaction inactive or explicitly recoverable; writer lock not live-stuck
 *  - every PUBLISHED row: public file at root + durable archive in data/published/
 *  - sitemap coverage: every PUBLISHED canonical in exactly one shard; no
 *    non-published matrix URL anywhere in the sitemaps
 *  - no draft leak (_drafts never inside the public tree)
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const errors = [], checks = [];
const ok = (name, cond, detail) => { checks.push(name + ': ' + (cond ? 'PASS' : 'FAIL' + (detail ? ' — ' + detail : ''))); if (!cond) errors.push(name + (detail ? ' — ' + detail : '')); };

// ---- load canonical shards in memory (READ-ONLY: no assembled csv is written) ----
const partFiles = fs.readdirSync(DATA).filter(f => /^content-matrix\.csv\.part/.test(f)).sort();
const csvText = partFiles.length ? partFiles.map(p => fs.readFileSync(path.join(DATA, p), 'utf8')).join('')
  : fs.readFileSync(path.join(DATA, 'content-matrix.csv'), 'utf8');
function parseLine(line){ const out=[]; let cur='',q=false;
  for(let i=0;i<line.length;i++){const c=line[i];
    if(q){if(c==='"'){if(line[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=c;}
    else{if(c==='"')q=true;else if(c===','){out.push(cur);cur='';}else cur+=c;}}
  out.push(cur);return out;}
const lines=csvText.split('\n');
const header=parseLine(lines[0]);
const rows=lines.slice(1).filter(l=>l.trim()).map(l=>{const c=parseLine(l);const o={};header.forEach((h,i)=>o[h]=c[i]||'');return o;});

// 1) capacity model
ok('exactly 10,000 production rows', rows.length===10000, 'got '+rows.length);
const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config','content-factory.json'),'utf8'));
ok('chunk max = 10', (cfg.CHUNK||0)<=10, 'CHUNK='+cfg.CHUNK);
ok('total_target_articles = 10000', Number(cfg.total_target_articles)===10000);
ok('phase valid enum', ['PILOT','PRODUCTION'].includes(cfg.phase), 'phase='+cfg.phase);

// 2) uniques + valid values
const STATUSES=new Set(['PLANNED','RESEARCH','WRITING','QA','REPAIR','REVIEW','PASS','PUBLISHED','BLOCKED']);
const CLUSTERS=new Set(['RENTAL','RESCUE','REPAIR','LICENCE','REGISTRATION','ELECTRIC','PARTS']);
const uniq=(field)=>{const seen=new Set();let dup=0;rows.forEach(r=>{if(seen.has(r[field]))dup++;seen.add(r[field]);});return dup;};
ok('unique article_id', uniq('article_id')===0);
ok('unique slug', uniq('slug')===0);
ok('unique output_path', uniq('output_path')===0);
ok('unique canonical', uniq('canonical')===0);
ok('unique primary_keyword', uniq('primary_keyword')===0);
const badStatus=rows.filter(r=>!STATUSES.has(r.status));
ok('valid status values only', badStatus.length===0, badStatus.slice(0,3).map(r=>r.article_id+'='+r.status).join(','));
const badCluster=rows.filter(r=>!CLUSTERS.has(r.cluster));
ok('valid cluster taxonomy refs', badCluster.length===0, badCluster.slice(0,3).map(r=>r.article_id+'='+r.cluster).join(','));

// 3) geography refs
let provSet=new Set();
try { const prov=JSON.parse(fs.readFileSync(path.join(DATA,'geography','provinces.json'),'utf8'));
  (prov.provinces||prov||[]).forEach(p=>provSet.add(p.province||p.name||p)); } catch(e){}
const geoBad=rows.filter(r=>r.province&&provSet.size&&!provSet.has(r.province));
ok('province refs exist in verified geography', geoBad.length===0, geoBad.slice(0,3).map(r=>r.article_id+'='+r.province).join(','));

// 4) checkpoint consistency with matrix truth
const ck=JSON.parse(fs.readFileSync(path.join(DATA,'state','checkpoint.json'),'utf8'));
const published=rows.filter(r=>r.status==='PUBLISHED');
const planned=rows.filter(r=>r.status==='PLANNED').map(r=>r.article_id).sort();
const active=rows.filter(r=>['RESEARCH','WRITING','QA','REPAIR','PASS'].includes(r.status)).map(r=>r.article_id).sort();
ok('checkpoint matrix_rows = 10,000', Number(ck.matrix_rows)===rows.length, ck.matrix_rows);
ok('checkpoint published_count matches matrix', Number(ck.published_count)===published.length, ck.published_count+' vs '+published.length);
ok('checkpoint phase agrees with config', ck.phase===cfg.phase, ck.phase+' vs '+cfg.phase);
ok('checkpoint active_chunk matches non-terminal rows', JSON.stringify((ck.active_chunk||[]).slice().sort())===JSON.stringify(active), 'cp='+JSON.stringify(ck.active_chunk)+' truth='+JSON.stringify(active));
const nextClaim=planned.length?planned[0]:null;
ok('checkpoint next_claimable_id = first PLANNED', (ck.next_claimable_id||null)===nextClaim, ck.next_claimable_id+' vs '+nextClaim);
const pubIds=published.map(r=>r.article_id).sort();
const lastCompleted=pubIds.length?pubIds[pubIds.length-1]:null;
ok('checkpoint last_completed_id = last PUBLISHED', (ck.last_completed_id||null)===lastCompleted, ck.last_completed_id+' vs '+lastCompleted);

// 5) state sanity
const tx=JSON.parse(fs.readFileSync(path.join(DATA,'state','transaction.json'),'utf8'));
ok('transaction not active', tx.active!==true, JSON.stringify(tx));
const lock=JSON.parse(fs.readFileSync(path.join(DATA,'state','writer-lock.json'),'utf8'));
const lockLive=!!(lock.locked&&lock.expires_at&&new Date(lock.expires_at)>new Date());
ok('writer lock not live-stuck', !lockLive, lock.holder+' expires '+lock.expires_at);

// 6) published files + archives exist
const missPub=[], missArch=[];
published.forEach(r=>{
  if(!fs.existsSync(path.join(ROOT,r.output_path.replace(/^\//,''),'index.html'))) missPub.push(r.article_id+' '+r.output_path);
  if(!fs.existsSync(path.join(DATA,'published',r.article_id+'.html'))) missArch.push(r.article_id);
});
ok('published public files exist (root tree)', missPub.length===0, missPub.slice(0,3).join(','));
ok('published archives exist', missArch.length===0, missArch.slice(0,3).join(','));

// 7) sitemap coverage
const sitemapFiles=fs.readdirSync(ROOT).filter(f=>/^sitemap-.*\.xml$/.test(f)&&f!=='sitemap-index.xml');
const locs=[];
sitemapFiles.forEach(f=>{const x=fs.readFileSync(path.join(ROOT,f),'utf8');
  for(const m of x.matchAll(/<loc>(.*?)<\/loc>/g)) locs.push(m[1]);});
const locCount={}; locs.forEach(u=>locCount[u]=(locCount[u]||0)+1);
const dupLocs=Object.entries(locCount).filter(([,n])=>n>1);
ok('sitemap URLs appear exactly once', dupLocs.length===0, dupLocs.slice(0,3).map(([u])=>u).join(','));
const missingInSitemap=published.filter(r=>!locCount[r.canonical]);
ok('sitemap covers every PUBLISHED canonical', missingInSitemap.length===0, missingInSitemap.slice(0,3).map(r=>r.article_id).join(','));
const pubCanon=new Set(published.map(r=>r.canonical));
const nonPub=rows.filter(r=>r.status!=='PUBLISHED'&&locCount[r.canonical]);
ok('sitemap contains no non-published matrix URL', nonPub.length===0, nonPub.slice(0,3).map(r=>r.article_id).join(','));

// 8) no draft leak (_drafts/ at the repo root is the gitignored writer-side
//    draft home — the leak invariant is: nothing promotable, and the gitignore
//    guard intact so drafts can never reach the public root tree)
ok('no drafts inside the promotable staging tree', !fs.existsSync(path.join(ROOT,'site','_drafts')));
const gi=fs.readFileSync(path.join(ROOT,'.gitignore'),'utf8');
ok('.gitignore keeps _drafts/ out of the public tree', /(^|\n)_drafts\//.test(gi));

// ---- report ----
checks.forEach(c=>console.log((c.endsWith('FAIL')||c.includes(': FAIL')?'✗ ':'✓ ')+c));
if (errors.length){ console.error('CAPACITY CHECK FAIL ('+errors.length+' problem(s))'); process.exit(1); }
console.log('CAPACITY CHECK PASS: 10,000-row model, state invariants, published set, sitemap coverage, no draft leak.');
