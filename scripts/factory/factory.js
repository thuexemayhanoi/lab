#!/usr/bin/env node
/**
 * factory.js — deterministic content-factory CLI (canonical engine of /lab).
 * Commands: status | prepare-next [n] | research | qa | publish | recover |
 *           promote-production | consistency | reports
 * Only ONE writer mutates production at a time (writer-lock + transaction marker).
 * The AI writer is EXTERNAL. This tool never writes prose; it validates and promotes.
 * data/content-matrix.csv is assembled from data/content-matrix.csv.part* if parts exist.
 *
 * Orchestration notes (golden port from /blog, adapted to the Node engine):
 * - prepare-next [n] claims at most n PLANNED rows (1..CHUNK, default CHUNK=10)
 *   and REFUSES while an unfinished chunk exists (RESEARCH/WRITING/QA/REPAIR/PASS
 *   rows must reach a terminal state first — resume before claiming new work).
 * - qa writes deterministic evidence to data/qa/<ID>.json (score, fails, draft hash).
 * - publish appends a real event to data/state/throughput-ledger.json (no backfill).
 * - recover resolves an active transaction from repository truth or STOPS safely
 *   (never force-clears an ambiguous transaction, never force-unlocks a live lock).
 * - reports regenerates reports/factory/status-report.json + throughput.json from
 *   real data only.
 * This file is also importable as a module (used by scripts/factory/operator.js);
 * the CLI dispatch runs only when executed directly.
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
if (partFiles.length && require.main === module) {
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
function loadMatrixText(){ // module-safe: assemble in memory without writing when imported
  return partFiles.length ? partFiles.map(p => fs.readFileSync(path.join(DATA,p),'utf8')).join('')
    : fs.readFileSync(csvPath,'utf8');
}
function loadMatrix(){return parseCSV(loadMatrixText());}
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
// Non-terminal chunk states. REVIEW (qa 80–89) is NOT a completion: it must be
// repaired and re-QA'd to PASS or BLOCKED before the chunk counts as finished.
const UNFINISHED = ['RESEARCH','WRITING','QA','REVIEW','REPAIR','PASS'];
const TERMINAL = new Set(['PLANNED','PUBLISHED','BLOCKED']);

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
function lockState(){ const l=JSON.parse(fs.readFileSync(path.join(STATE,'writer-lock.json'),'utf8'));
  return {raw:l, held: !!(l.locked&&l.expires_at&&new Date(l.expires_at)>new Date())}; }
function beginTx(op,articles){ write('data/state/transaction.json',{active:true,id:'TX-'+Date.now(),started_at:new Date().toISOString(),operation:op,articles,notes:'In progress; recover() rolls forward or back.'}); }
function commitTx(){ write('data/state/transaction.json',{active:false,id:null,started_at:null,operation:null,articles:[],notes:'Committed.'}); }
function readTx(){ return JSON.parse(fs.readFileSync(path.join(STATE,'transaction.json'),'utf8')); }

// ---- checkpoint enrichment: progress pointers derived from repository truth ----
function progressOf(rows){
  const published=rows.filter(r=>r.status==='PUBLISHED').map(r=>r.article_id).sort();
  const planned=rows.filter(r=>r.status==='PLANNED').map(r=>r.article_id).sort();
  const active=rows.filter(r=>UNFINISHED.includes(r.status)).map(r=>r.article_id).sort();
  return { published_count: published.length,
    last_completed_id: published.length?published[published.length-1]:null,
    next_claimable_id: planned.length?planned[0]:null,
    active_chunk: active };
}
function writeCheckpoint(rows, notes, extra){
  const prog=progressOf(rows);
  const ck={last_run:new Date().toISOString(),phase:phase(),matrix_rows:rows.length,
    published_count:prog.published_count,last_batch:(extra&&extra.last_batch)||[],
    last_completed_id:prog.last_completed_id,next_claimable_id:prog.next_claimable_id,
    active_chunk:prog.active_chunk,notes};
  write('data/state/checkpoint.json',ck);
  return ck;
}

// ---- throughput ledger: REAL events only, appended by mutating ops. No backfill. ----
function ledgerPath(){ return path.join(STATE,'throughput-ledger.json'); }
function readLedger(){ try { return JSON.parse(fs.readFileSync(ledgerPath(),'utf8')); }
  catch(e){ return {version:1,events:[]}; } }
function appendLedger(event){ const l=readLedger(); l.events.push(event);
  write('data/state/throughput-ledger.json',l); }

function status(){
  const rows=loadMatrix(); const by={}; rows.forEach(r=>by[r.status]=(by[r.status]||0)+1);
  const alloc={}; rows.forEach(r=>alloc[r.cluster]=(alloc[r.cluster]||0)+1);
  const ck=JSON.parse(fs.readFileSync(path.join(STATE,'checkpoint.json'),'utf8'));
  const lock=JSON.parse(fs.readFileSync(path.join(STATE,'writer-lock.json'),'utf8'));
  console.log(JSON.stringify({matrix_rows:rows.length,allocation:alloc,by_status:by,checkpoint:ck,writer_lock:lock.locked?lock.holder:'free'},null,1));
}
function prepareNext(args){
  const nArg = args&&args.length?parseInt(args[0],10):NaN;
  const CHUNK = cfg.CHUNK||10;
  const n = isNaN(nArg) ? CHUNK : nArg;
  if(!Number.isInteger(n)||n<1||n>CHUNK){
    console.error('prepare-next count must be an integer 1..'+CHUNK); process.exit(1);
  }
  const pre=loadMatrix();
  const unfinished=pre.filter(r=>UNFINISHED.includes(r.status));
  if(unfinished.length){
    console.error('REFUSED: unfinished chunk present ('+unfinished.map(r=>r.article_id+'='+r.status).join(', ')+'). Complete/QA/publish or release the current chunk before claiming a new one (resume first).');
    process.exit(1);
  }
  acquireLock('prepare-next');
  try{
    const rows=loadMatrix(); const batch=[];
    if(phase()==='PILOT'&&rows.filter(r=>r.status==='PUBLISHED').length<cfg.max_publication_in_bootstrap){
      const clusters=['RENTAL','RESCUE','REPAIR','ELECTRIC','LICENCE','REGISTRATION','PARTS'];
      const used=new Set(rows.filter(r=>r.status!=='PLANNED').map(r=>r.cluster));
      for(const c of clusters){ if(!used.has(c)||batch.length===0){ const cand=rows.find(r=>r.cluster===c&&r.status==='PLANNED'); if(cand)batch.push(cand); } }
      const next=rows.filter(r=>r.status==='PLANNED').filter(r=>!batch.includes(r));
      batch.push(...next.slice(0,Math.max(0,n-batch.length)));
    } else { batch.push(...rows.filter(r=>r.status==='PLANNED').slice(0,n)); }
    if(!batch.length){ console.error('NO PLANNED ROWS LEFT'); process.exit(1); }
    beginTx('prepare-next',batch.map(r=>r.article_id));
    batch.forEach(r=>r.status='RESEARCH');
    saveMatrix(rows);
    const ck=writeCheckpoint(rows,'Prepared '+batch.length+' articles for research.',{last_batch:batch.map(r=>r.article_id)});
    commitTx();
    console.log('PREPARED '+batch.length+': '+batch.map(r=>r.article_id+' ('+r.primary_keyword+')').join(' | '));
    console.log('CHECKPOINT next_claimable='+ck.next_claimable_id+' active_chunk='+ck.active_chunk.join(','));
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
  if(TERMINAL.has(r.status)){console.error('qa refused: '+id+' status '+r.status+' is protected (terminal); only WRITING/QA/REVIEW/REPAIR rows are scored');process.exit(1);}
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
  // deterministic QA evidence (hash-bound to the exact draft that was scored)
  const evPath=path.join(ROOT,'data','qa',id+'.json');
  fs.mkdirSync(path.dirname(evPath),{recursive:true});
  fs.writeFileSync(evPath,JSON.stringify({article_id:id,scored_at:new Date().toISOString(),
    scorer:'factory-qa-deterministic-v1',score,words,result:r.status,
    fails, draft_sha256:require('crypto').createHash('sha256').update(html).digest('hex'),
    matrix_status_after:r.status},null,2));
  console.log('QA '+id+' score='+score+' words='+words+' status='+r.status+(fails.length?' fails: '+fails.join('; '):''));
}
function publish(args){
  const CHUNK=cfg.CHUNK||10;
  // Hard chunk invariant (canonical engine, not just the operator):
  // a publish operation promotes AT MOST CHUNK articles. Explicit >CHUNK ids
  // => REFUSE up front (never silently publish a prefix and drop the rest).
  // Checked BEFORE acquiring the lock so a refusal leaves no held lock behind
  // (process.exit does not run finally blocks).
  if(args.length>CHUNK){
    console.error('REFUSED: publish received '+args.length+' ids > CHUNK='+CHUNK+' (at most '+CHUNK+' articles per publish operation). Split the ids into chunks of <= '+CHUNK+' and publish each chunk separately.');
    process.exit(1);
  }
  acquireLock('publish');
  const started=Date.now();
  try{
    const rows=loadMatrix();
    // No ids => take at most the current chunk of PASS rows — never sweep the whole backlog.
    const ids=args.length?args:rows.filter(r=>r.status==='PASS').map(r=>r.article_id).slice(0,CHUNK);
    const published=rows.filter(r=>r.status==='PUBLISHED').length;
    const room=phase()==='PILOT'?Math.min(cfg.max_publication_in_bootstrap-published,CHUNK):CHUNK;
    let done=0; const doneIds=[];
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
      done++; doneIds.push(id);
    }
    saveMatrix(rows);
    writeCheckpoint(rows,'Published '+done+' articles.',{last_batch:doneIds});
    commitTx();
    // throughput ledger: real measured events only (a no-op publish is not an event)
    if(done>0) appendLedger({op:'publish',started_at:new Date(started).toISOString(),
      finished_at:new Date().toISOString(),elapsed_ms:Date.now()-started,
      ids:doneIds,published:done,phase:phase()});
    console.log('PUBLISHED '+done);
  } finally{ releaseLock(); }
}
// Sync derived progress pointers in checkpoint from matrix truth —
// deterministic (no timestamp churn): running twice changes nothing.
function syncCheckpoint(rows){
  let ck={};
  try { ck=JSON.parse(fs.readFileSync(path.join(STATE,'checkpoint.json'),'utf8')); } catch(e){}
  const prog=progressOf(rows);
  const out=Object.assign({},ck,{matrix_rows:rows.length,published_count:prog.published_count,
    last_completed_id:prog.last_completed_id,next_claimable_id:prog.next_claimable_id,
    active_chunk:prog.active_chunk});
  write('data/state/checkpoint.json',out);
  return out;
}
// Safe transaction recovery from repository truth. Ambiguous state => STOP (exit 1).
function recover(){
  const tx=readTx();
  const lock=lockState();
  if(!tx.active){
    if(lock.held){ console.log('RECOVER: writer-lock still live (holder='+lock.raw.holder+' expires '+lock.raw.expires_at+') — NOT force-unlocking (ownership unclear).'); process.exit(1); }
    if(lock.raw.locked){ console.log('RECOVER: stale writer-lock cleared (expired at '+lock.raw.expires_at+').'); }
    releaseLock(); commitTx();
    const rows=loadMatrix();
    const ck=syncCheckpoint(rows);
    console.log('RECOVERED (transaction already clean). checkpoint: '+JSON.stringify({phase:ck.phase,published_count:ck.published_count,next_claimable_id:ck.next_claimable_id,active_chunk:ck.active_chunk}));
    return;
  }
  console.log('RECOVER: active transaction '+tx.id+' op='+tx.operation+' articles='+(tx.articles||[]).join(','));
  if(lock.held){ console.log('RECOVER: writer-lock live (holder='+lock.raw.holder+' expires '+lock.raw.expires_at+') — ownership unclear, NOT clearing. STOP.'); process.exit(1); }
  const rows=loadMatrix(); const byId={}; rows.forEach(r=>byId[r.article_id]=r);
  const problems=[];
  if(tx.operation==='publish'){
    for(const id of (tx.articles||[])){
      const r=byId[id];
      if(!r){ problems.push(id+' missing from matrix — cannot resolve'); continue; }
      const pub=r.status==='PUBLISHED';
      const archive=fs.existsSync(path.join(ROOT,'data','published',id+'.html'));
      const pubFile=fs.existsSync(path.join(ROOT,r.output_path.replace(/^\//,''),'index.html'))||fs.existsSync(path.join(ROOT,'site',r.output_path.replace(/^\//,''),'index.html'));
      const draft=fs.existsSync(path.join(ROOT,'_drafts',id+'.html'));
      if(pub){ if(!archive||!pubFile) problems.push(id+' PUBLISHED in matrix but archive/public file missing — ambiguous'); else console.log('  '+id+': completed (matrix PUBLISHED + archive + public file) — roll forward'); }
      else if(draft){ console.log('  '+id+': draft intact, matrix '+r.status+' — rolled back, safe to re-publish'); }
      else { problems.push(id+' not PUBLISHED, no draft — cannot resolve from truth'); }
    }
  } else if(tx.operation==='prepare-next'){
    console.log('  prepare-next claim is resumable: claimed rows stay in RESEARCH (no data loss).');
  } else if(tx.operation==='promote-production'){
    const cp=JSON.parse(fs.readFileSync(path.join(STATE,'checkpoint.json'),'utf8'));
    if(phase()==='PRODUCTION'&&cp.phase==='PRODUCTION') console.log('  phase already PRODUCTION in both config and checkpoint — completed.');
    else if(phase()==='PILOT'&&cp.phase==='PILOT') console.log('  phase still PILOT in both — rolled back cleanly.');
    else problems.push('phase mismatch config='+phase()+' checkpoint='+cp.phase+' — ambiguous');
  } else { problems.push('unknown transaction operation '+tx.operation); }
  if(problems.length){ console.error('RECOVER STOP (transaction not safely recoverable):\n'+problems.join('\n')+'\nResolve manually per docs/PROC-RECOVERY.md — never force-clear state.'); process.exit(1); }
  releaseLock(); commitTx();
  const ck=syncCheckpoint(rows);
  console.log('RECOVERED. checkpoint: '+JSON.stringify({phase:ck.phase,published_count:ck.published_count,next_claimable_id:ck.next_claimable_id,active_chunk:ck.active_chunk}));
}
function promoteProduction(){
  // Canonical PILOT -> PRODUCTION transition. Verifies the bootstrap pilot is
  // complete and healthy, then flips config.phase and the checkpoint phase.
  const rows=loadMatrix(); const published=rows.filter(r=>r.status==='PUBLISHED'); const problems=[];
  if(phase()!=='PILOT')problems.push('phase is already '+phase());
  if(published.length<cfg.max_publication_in_bootstrap)
    problems.push('bootstrap pilot incomplete: published='+published.length+' < cap='+cfg.max_publication_in_bootstrap);
  published.forEach(r=>{
    if(Number(r.qa_score)<rubric.pass_min)problems.push(r.article_id+' qa='+r.qa_score);
    if(!fs.existsSync(path.join(ROOT,'data','published',r.article_id+'.html')))problems.push(r.article_id+' missing archive');
    if(!fs.existsSync(path.join(ROOT,r.output_path.replace(/^\//,''),'index.html')))problems.push(r.article_id+' missing public file');
  });
  const tx=readTx();
  if(tx.active)problems.push('active transaction '+tx.id+' — run recover first');
  if(problems.length){console.error('PROMOTE REFUSED:\n'+problems.join('\n'));process.exit(1);}
  acquireLock('promote-production');
  try{
    beginTx('promote-production',[]);
    cfg.phase='PRODUCTION';
    write('config/content-factory.json',cfg);
    const ck=writeCheckpoint(rows,'Bootstrap pilot complete (10/10, QA>=90). Promoted PILOT -> PRODUCTION via canonical promote-production command.',{last_batch:published.map(r=>r.article_id)});
    ck.phase='PRODUCTION'; write('data/state/checkpoint.json',ck);
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
  // _drafts/ at the repo root is the canonical WRITER-side draft home: gitignored,
  // never committed, never promoted. A REAL leak is drafts inside the promotable
  // staging tree (site/) or a .gitignore that no longer keeps _drafts/ out.
  if(fs.existsSync(path.join(ROOT,'site','_drafts')))draftLeak.push('drafts inside site/ staging tree — would be promoted to the public root!');
  if(!/(^|\n)_drafts\//.test(fs.readFileSync(path.join(ROOT,'.gitignore'),'utf8')))draftLeak.push('.gitignore no longer excludes _drafts/ — drafts would become public!');
  console.log(errors.length?'CONSISTENCY FAIL\n'+errors.join('\n'):'CONSISTENCY PASS: '+rows.length+' rows, all unique, no leaks.');
  process.exitCode = errors.length||draftLeak.length?1:0;
}
function reports(){
  const rows=loadMatrix();
  const by={}; rows.forEach(r=>{by[r.cluster]=by[r.cluster]||{};by[r.cluster][r.status]=(by[r.cluster][r.status]||0)+1;});
  const totals={}; rows.forEach(r=>totals[r.status]=(totals[r.status]||0)+1);
  const published=rows.filter(r=>r.status==='PUBLISHED');
  const prog=progressOf(rows);
  const rep={generated_at:new Date().toISOString(),total:rows.length,by_status:totals,by_cluster:by,
    phase:phase(),active_chunk:prog.active_chunk,last_completed_id:prog.last_completed_id,
    next_claimable_id:prog.next_claimable_id,blocked:rows.filter(r=>r.status==='BLOCKED').map(r=>r.article_id),
    published:published.map(r=>({id:r.article_id,pk:r.primary_keyword,qa:r.qa_score,url:r.canonical})),zero_backlink_baseline:'YES'};
  fs.mkdirSync(path.join(ROOT,'reports','factory'),{recursive:true});
  fs.writeFileSync(path.join(ROOT,'reports','factory','status-report.json'),JSON.stringify(rep,null,2));
  // throughput report: REAL ledger events only — no backfill, no estimates.
  const ledger=readLedger();
  const pubEvents=ledger.events.filter(e=>e.op==='publish');
  const publishedTotal=pubEvents.reduce((s,e)=>s+(e.published||0),0);
  const spanMs=pubEvents.length>1?new Date(pubEvents[pubEvents.length-1].finished_at)-new Date(pubEvents[0].started_at):null;
  const thr={generated_at:new Date().toISOString(),
    note:'Real measured events only (data/state/throughput-ledger.json). No backfill; historical publishes before the ledger are not counted.',
    events_total:ledger.events.length,chunks_completed:pubEvents.length,
    qa_checked:ledger.events.filter(e=>e.op==='qa').reduce((s,e)=>s+(e.count||0),0),
    published:publishedTotal,
    repair_count:rows.filter(r=>Number(r.repair_attempts||0)>0).length,
    publish_operations:pubEvents.length,
    publish_elapsed_ms_total:pubEvents.reduce((s,e)=>s+(e.elapsed_ms||0),0),
    effective_articles_per_hour:(spanMs&&spanMs>0)?Math.round(publishedTotal/(spanMs/3600000)*10)/10:null};
  fs.writeFileSync(path.join(ROOT,'reports','factory','throughput.json'),JSON.stringify(thr,null,2));
  console.log('REPORTS WRITTEN: reports/factory/status-report.json reports/factory/throughput.json');
}
function main(argv){
  const [cmd,...args]=argv;
  const commands={status,'prepare-next':prepareNext,research,qa,publish,recover,'promote-production':promoteProduction,consistency,reports};
  if(!commands[cmd]){console.error('Usage: factory.js <status|prepare-next|research|qa|publish|recover|promote-production|consistency|reports> [args]');process.exit(1);}
  commands[cmd](args);
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { loadMatrix, saveMatrix, loadMatrixText, parseCSV, status, prepareNext,
  research, qa, publish, recover, promoteProduction, consistency, reports,
  acquireLock, releaseLock, lockState, beginTx, commitTx, readTx, progressOf,
  writeCheckpoint, syncCheckpoint, readLedger, appendLedger, cfg, rubric, phase, FIELDS,
  UNFINISHED, TERMINAL };
