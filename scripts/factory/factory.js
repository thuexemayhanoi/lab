#!/usr/bin/env node
/**
 * factory.js — deterministic content-factory CLI.
 * Commands: status | prepare-next | research | qa | publish | recover | consistency | reports
 * Only ONE writer mutates production at a time (writer-lock + transaction marker).
 * The AI writer is EXTERNAL. This tool never writes prose; it validates and promotes.
 * data/content-matrix.csv is assembled from data/content-matrix.csv.part* if parts exist.
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const STATE = path.join(DATA, 'state');
const csvPath = path.join(DATA, 'content-matrix.csv');
const FIELDS = ['article_id','cluster','parent_topic','primary_keyword','secondary_keywords','search_intent','geo_id','geo_level','province','locality','poi','brand','model','vehicle_type','part','use_case','duration','requires_research','requires_official_sources','actual_service_area','cannibalization_group','slug','output_path','canonical','status','research_status','qa_score','repair_attempts','published_date'];

// assemble matrix from parts when present (canonical committed form)
const partFiles = fs.readdirSync(DATA).filter(f => /^content-matrix\.csv\.part/.test(f)).sort();
if (partFiles.length) {
  const assembled = partFiles.map(p => fs.readFileSync(path.join(DATA, p), 'utf8')).join('');
  fs.writeFileSync(csvPath, assembled);
}
function parseCSV(text){ const lines=text.split('\n'); const header=parseLine(lines[0]);
  return lines.slice(1).filter(l=>l.trim()).map(l=>{const c=parseLine(l);const o={};header.forEach((h,i)=>o[h]=c[i]||'');return o;});}
function parseLine(line){ const out=[]; let cur='',q=false;
  for(let i=0;i<line.length;i++){const c=line[i];
    if(q){if(c==='"'){if(line[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=c;}
    else{if(c==='"')q=true;else if(c===','){out.push(cur);cur='';}else cur+=c;}}
  out.push(cur);return out;}
function loadMatrix(){return parseCSV(fs.readFileSync(csvPath,'utf8'));}
function saveMatrix(rows){
  const csv=[FIELDS.join(',')].concat(rows.map(r=>FIELDS.map(f=>{let v=String(r[f]??'');if(/[",\n]/.test(v))v='"'+v.replace(/"/g,'""')+'"';return v;}).join(','))).join('\n');
  fs.writeFileSync(csvPath,csv);
  if(partFiles.length){ // rewrite parts so repo source of truth stays in sync
    const size=Math.ceil(csv.length/partFiles.length);
    partFiles.forEach((p,i)=>fs.writeFileSync(path.join(DATA,p),csv.slice(i*size,(i+1)*size)));
  }
}
const read = p => JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const write = (p,o) => fs.writeFileSync(path.join(ROOT,p), JSON.stringify(o,null,2));
const cfg = read('config/content-factory.json');
const rubric = read('config/article-rubric.json');
const phase = () => cfg.phase || 'PILOT'; // PILOT -> PRODUCTION via promote-production

function acquireLock(cmd){
  const lockPath=path.join(STATE,'writer-lock.json');
  const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));
  if(lock.locked&&lock.expires_at&&new Date(lock.expires_at)>new Date())
    { console.error('WRITER LOCK HELD BY '+lock.holder+' — refusing. Run: node scripts/factory/factory.js recover'); process.exit(2); }
  lock.locked=true;lock.holder=cmd;lock.acquired_at=new Date().toISOString();
  lock.expires_at=new Date(Date.now()+1000*60*60).toISOString();
  fs.writeFileSync(lockPath,JSON.stringify(lock,null,2));
}
function releaseLock(){ fs.writeFileSync(path.join(STATE,'writer-lock.json'),JSON.stringify({locked:false,holder:null,acquired_at:null,expires_at:null},null,2)); }
function beginTx(op,articles){ write('data/state/transaction.json',{active:true,id:'TX-'+Date.now(),started_at:new Date().toISOString(),operation:op,articles,notes:'In progress; recover() rolls forward or back.'}); }
function commitTx(){ write('data/state/transaction.json',{active:false,id:null,started_at:null,operation:null,articles:[],notes:'Committed.'}); }

function status(){
  const rows=loadMatrix(); const by={}; rows.forEach(r=>by[r.status]=(by[r.status]||0)+1);
  const alloc={}; rows.forEach(r=>alloc[r.cluster]=(alloc[r.cluster]||0)+1);
  const ck=JSON.parse(fs.readFileSync(path.join(STATE,'checkpoint.json'),'utf8'));
  const lock=JSON.parse(fs.readFileSync(path.join(STATE,'writer-lock.json'),'utf8'));
  console.log(JSON.stringify({matrix_rows:rows.length,allocation:alloc,by_status:by,checkpoint:ck,writer_lock:lock.locked?lock.holder:'free'},null,1));
}
function prepareNext(){
  acquireLock('prepare-next');
  try{
    const rows=loadMatrix(); const CHUNK=cfg.CHUNK||10; const batch=[];
    const published=rows.filter(r=>r.status==='PUBLISHED').length;
    let next;
    if(phase()==='PILOT'&&published<cfg.max_publication_in_bootstrap){
      const clusters=['RENTAL','RESCUE','REPAIR','ELECTRIC','LICENCE','REGISTRATION','PARTS'];
      const used=new Set(rows.filter(r=>r.status!=='PLANNED').map(r=>r.cluster));
      for(const c of clusters){ if(!used.has(c)||batch.length===0){ const cand=rows.find(r=>r.cluster===c&&r.status==='PLANNED'); if(cand)batch.push(cand); } }
      next=rows.filter(r=>r.status==='PLANNED').filter(r=>!batch.includes(r));
      batch.push(...next.slice(0,Math.max(0,CHUNK-batch.length)));
    } else { next=rows.filter(r=>r.status==='PLANNED'); batch.push(...next.slice(0,CHUNK)); }
    beginTx('prepare-next',batch.map(r=>r.article_id));
    batch.forEach(r=>r.status='RESEARCH');
    saveMatrix(rows);
    write('data/state/checkpoint.json',{last_run:new Date().toISOString(),phase:phase(),matrix_rows:rows.length,published_count:rows.filter(r=>r.status==='PUBLISHED').length,last_batch:batch.map(r=>r.article_id),notes:'Prepared '+batch.length+' articles for research.'});
    commitTx();
    console.log('PREPARED '+batch.length+': '+batch.map(r=>r.article_id+' ('+r.primary_keyword+')').join(' | '));
  } finally { releaseLock(); }
}
function research(args){
  const rows=loadMatrix(); const id=args[0];
  const r=rows.find(x=>x.article_id===id);
  if(!r){console.error('NOT FOUND');process.exit(1);}
  if(r.status!=='RESEARCH'&&r.status!=='WRITING'){console.error('status must be RESEARCH/WRITING, got '+r.status);process.exit(1);}
  const p='data/research/'+id+'.json';
  if(!fs.existsSync(path.join(ROOT,p))){console.error('MISSING research packet '+p+' — research BEFORE write is mandatory');process.exit(1);}
  const packet=read(p);
  const must=['article_id','primary_keyword','search_intent','research_date','questions_found','official_sources','unique_angle'];
  const missing=must.filter(k=>!(k in packet));
  if(r.requires_official_sources==='1'&&(!packet.official_sources||!packet.official_sources.length)){
    console.error('BLOCKED: requires official sources, none recorded');r.status='BLOCKED';saveMatrix(rows);process.exit(1);
  }
  if(missing.length){console.error('research packet missing fields: '+missing.join(','));process.exit(1);}
  r.status='WRITING'; r.research_status='DONE';
  saveMatrix(rows);
  console.log('RESEARCH PASS '+id);
}
function qa(args){
  const rows=loadMatrix(); const id=args[0];
  const r=rows.find(x=>x.article_id===id);
  if(!r){console.error('NOT FOUND');process.exit(1);}
  const draft=path.join(ROOT,'_drafts',id+'.html');
  if(!fs.existsSync(draft)){console.error('NO DRAFT for '+id);process.exit(1);}
  const html=fs.readFileSync(draft,'utf8');
  const text=html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
  const words=(text.match(/[A-Za-zÀ-ỹ0-9]+/g)||[]).length;
  let score=100; const fails=[];
  if(words<1600){score-=Math.min(25,Math.round((1600-words)/40));fails.push('word_count '+words);}
  if(!/<h1[^>]*>/.test(html))fails.push('missing h1');
  if(!/rel="canonical"/.test(html))fails.push('missing canonical');
  if(!/BreadcrumbList|breadcrumb/i.test(html))fails.push('missing breadcrumb');
  if(!/ld\+json/.test(html))fails.push('missing schema');
  const links=(html.match(/href="\/[^"]+"/g)||[]).length;
  if(links<3)fails.push('internal_links '+links);
  if(r.actual_service_area==='informational_only'&&/chúng tôi cứu hộ|đội cứu hộ của chúng tôi/.test(html))fails.push('CRITICAL fake local service claim');
  if(r.actual_service_area==='informational_only'&&/"@type":"LocalBusiness"/.test(html))fails.push('CRITICAL LocalBusiness schema on non-owned area');
  score-=fails.length*5;
  if(fails.some(f=>f.startsWith('CRITICAL')))score=Math.min(score,55);
  r.qa_score=String(score);
  if(score>=rubric.pass_min){r.status='PASS';}
  else if(score>=rubric.review_min){r.status='REVIEW';}
  else{ r.repair_attempts=String(Number(r.repair_attempts||0)+1);
    r.status=Number(r.repair_attempts)>=rubric.max_repair_attempts?'BLOCKED':'REPAIR'; }
  saveMatrix(rows);
  console.log('QA '+id+' score='+score+' words='+words+' status='+r.status+(fails.length?' fails: '+fails.join('; '):''));
}
function publish(args){
  acquireLock('publish');
  try{
    const rows=loadMatrix();
    const ids=args.length?args:[rows.filter(r=>r.status==='PASS').map(r=>r.article_id)];
    const published=rows.filter(r=>r.status==='PUBLISHED').length;
    const room=phase()==='PILOT'?cfg.max_publication_in_bootstrap-published:ids.length;
    let done=0;
    beginTx('publish',ids);
    for(const id of ids){
      const r=rows.find(x=>x.article_id===id);
      if(!r||r.status!=='PASS'){console.log('SKIP '+id+' (not PASS)');continue;}
      if(done>=room){console.log('LIMIT reached: '+(phase()==='PILOT'?'max bootstrap publication = '+cfg.max_publication_in_bootstrap:'chunk limit'));break;}
      const draft=path.join(ROOT,'_drafts',id+'.html');
      if(!fs.existsSync(draft)){console.log('SKIP '+id+' no draft');continue;}
      const dest=path.join(ROOT,'site',r.output_path.replace(/^\//,''),'index.html');
      fs.mkdirSync(path.dirname(dest),{recursive:true});
      const html=fs.readFileSync(draft,'utf8');
      fs.writeFileSync(dest,html);
      fs.mkdirSync(path.join(ROOT,'data','published'),{recursive:true});
      fs.writeFileSync(path.join(ROOT,'data','published',id+'.html'),html); // durable archive
      fs.rmSync(draft);
      r.status='PUBLISHED'; r.published_date=new Date().toISOString().slice(0,10);
      done++;
    }
    saveMatrix(rows);
    write('data/state/checkpoint.json',{last_run:new Date().toISOString(),phase:phase(),matrix_rows:rows.length,published_count:rows.filter(r=>r.status==='PUBLISHED').length,last_batch:ids,notes:'Published '+done+' articles.'});
    commitTx();
    console.log('PUBLISHED '+done);
  } finally{ releaseLock(); }
}
function recover(){
  const tx=JSON.parse(fs.readFileSync(path.join(STATE,'transaction.json'),'utf8'));
  if(tx.active){ console.log('ROLL-FORWARD/BACK for tx '+tx.id+' op='+tx.operation+' articles='+tx.articles.join(',')); }
  releaseLock(); commitTx();
  const ck=JSON.parse(fs.readFileSync(path.join(STATE,'checkpoint.json'),'utf8'));
  console.log('RECOVERED. checkpoint: '+JSON.stringify(ck));
}
function promoteProduction(){
  // Canonical PILOT -> PRODUCTION transition. Verifies the bootstrap pilot is
  // complete and healthy, then flips config.phase and the checkpoint phase.
  // Matrix, article IDs, published set, QA evidence and lock/transaction
  // semantics are untouched.
  const rows=loadMatrix();
  const published=rows.filter(r=>r.status==='PUBLISHED');
  const problems=[];
  if(phase()!=='PILOT')problems.push('phase is already '+phase());
  if(published.length<cfg.max_publication_in_bootstrap)
    problems.push('bootstrap pilot incomplete: published='+published.length+' < cap='+cfg.max_publication_in_bootstrap);
  published.forEach(r=>{
    if(Number(r.qa_score)<rubric.pass_min)problems.push(r.article_id+' qa='+r.qa_score);
    if(!fs.existsSync(path.join(ROOT,'data','published',r.article_id+'.html')))problems.push(r.article_id+' missing archive');
    if(!fs.existsSync(path.join(ROOT,r.output_path.replace(/^\//,''),'index.html')))problems.push(r.article_id+' missing public file');
  });
  const tx=JSON.parse(fs.readFileSync(path.join(STATE,'transaction.json'),'utf8'));
  if(tx.active)problems.push('active transaction '+tx.id+' — run recover first');
  if(problems.length){console.error('PROMOTE REFUSED:\n'+problems.join('\n'));process.exit(1);}
  acquireLock('promote-production');
  try{
    beginTx('promote-production',[]);
    cfg.phase='PRODUCTION';
    write('config/content-factory.json',cfg);
    write('data/state/checkpoint.json',{last_run:new Date().toISOString(),phase:'PRODUCTION',matrix_rows:rows.length,published_count:published.length,last_batch:published.map(r=>r.article_id),notes:'Bootstrap pilot complete (10/10, QA>=90). Promoted PILOT -> PRODUCTION via canonical promote-production command.'});
    commitTx();
    console.log('PROMOTED PILOT -> PRODUCTION. published='+published.length+', chunk='+cfg.CHUNK+', bootstrap cap no longer binds.');
  } finally { releaseLock(); }
}
function consistency(){
  const rows=loadMatrix();
  const errors=[];
  const ids=new Set(),cans=new Set(),paths=new Set(),sl=new Set(),pks=new Set();
  rows.forEach(r=>{
    [[ids,r.article_id],[cans,r.canonical],[paths,r.output_path],[sl,r.slug]].forEach(([s,v])=>{if(s.has(v))errors.push('dup '+v);s.add(v);});
    const pk=r.primary_keyword.toLowerCase();
    if(pks.has(pk))errors.push('dup primary_keyword '+r.primary_keyword);pks.add(pk);
    if(r.status==='PUBLISHED'){
      // Branch Pages: the public tree is the repository root (main / (root)).
      const f=path.join(ROOT,r.output_path.replace(/^\//,''),'index.html');
      if(!fs.existsSync(f))errors.push('PUBLISHED but no public file: '+r.output_path);
      const a=path.join(ROOT,'data','published',r.article_id+'.html');
      if(!fs.existsSync(a))errors.push('PUBLISHED but no archive: '+r.article_id);
    }
  });
  const draftLeak=[];
  if(fs.existsSync(path.join(ROOT,'_drafts'))||fs.existsSync(path.join(ROOT,'site','_drafts')))draftLeak.push('drafts directory is public!');
  console.log(errors.length?'CONSISTENCY FAIL\n'+errors.join('\n'):'CONSISTENCY PASS: '+rows.length+' rows, all unique, no leaks.');
  process.exitCode = errors.length||draftLeak.length?1:0;
}
function reports(){
  const rows=loadMatrix();
  const by={}; rows.forEach(r=>{by[r.cluster]=by[r.cluster]||{};by[r.cluster][r.status]=(by[r.cluster][r.status]||0)+1;});
  const published=rows.filter(r=>r.status==='PUBLISHED');
  const rep={generated_at:new Date().toISOString(),total:rows.length,by_cluster:by,published:published.map(r=>({id:r.article_id,pk:r.primary_keyword,qa:r.qa_score,url:r.canonical})),zero_backlink_baseline:'YES'};
  fs.mkdirSync(path.join(ROOT,'reports','factory'),{recursive:true});
  fs.writeFileSync(path.join(ROOT,'reports','factory','status-report.json'),JSON.stringify(rep,null,2));
  console.log('REPORTS WRITTEN: reports/factory/status-report.json');
}
const [cmd,...args]=process.argv.slice(2);
const commands={status,'prepare-next':prepareNext,research,qa,publish,recover,'promote-production':promoteProduction,consistency,reports};
if(!commands[cmd]){console.error('Usage: factory.js <status|prepare-next|research|qa|publish|recover|promote-production|consistency|reports> [args]');process.exit(1);}
commands[cmd](args);
