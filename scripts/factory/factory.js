#!/usr/bin/env node
/**
 * factory.js — deterministic content-factory CLI (canonical engine of /lab).
 * Commands: status | prepare-next [n] | research | qa | qa-repair |
 *           publish | grounding | recover | promote-production |
 *           consistency | reports
 * Only ONE writer mutates production at a time (writer-lock + transaction marker).
 * The AI writer is EXTERNAL. This tool never writes prose; it validates and promotes.
 * data/content-matrix.csv is assembled from data/content-matrix.csv.part* if parts exist.
 *
 * Orchestration notes (golden port from /blog, adapted to the Node engine):
 * - prepare-next [n] claims at most n PLANNED rows (1..CHUNK, default CHUNK=10)
 *   and REFUSES while an unfinished chunk exists (RESEARCH/WRITING/QA/REPAIR/PASS
 *   rows must reach a terminal state first — resume before claiming new work).
 * - qa writes deterministic evidence to data/qa/<ID>.json (score, fails, draft hash).
 * - publish is GATE-BINDED and ATOMIC (two-phase):
 *     publishStage  : publish gate (status=PASS, qa_score>=90, QA evidence
 *                     result=PASS + score>=90 + sha256(_drafts/<ID>.html) ===
 *                     evidence.draft_sha256 — REFUSE with QA_EVIDENCE_STALE /
 *                     DRAFT_CHANGED_AFTER_QA otherwise; the engine NEVER
 *                     auto-updates the hash) + grounding gate, then stages
 *                     archive/site/matrix/checkpoint inside a live transaction
 *                     WITHOUT removing drafts or appending the ledger
 *                     (pre-state journal kept for deterministic rollback).
 *     publishCommit : removes drafts (only when the publish state is safe,
 *                     i.e. after build+verify in the operator path), appends
 *                     the real ledger event, commits the transaction, releases
 *                     the lock.
 *     publishRollback: deterministic restore from the stage journal (matrix
 *                     rows, checkpoint bytes, staged files removed, site
 *                     rebuilt so hub/sitemap/search-index self-heal) — used by
 *                     the operator when build/verify FAILS and by recover()
 *                     for interrupted staged publishes. No half-PUBLISHED
 *                     state (public/archive changed but matrix/checkpoint not)
 *                     ever survives: the marker only clears after the staged
 *                     state is fully restored (rollback) or fully committed.
 *   The bare `publish` CLI = stage+commit (sandbox/test quick path); the
 *   production path is operator.js, which runs build+verify between stage
 *   and commit (atomic). Recover never force-clears an ambiguous transaction.
 * - grounding checks that every quantitative claim (VND ranges, %, minute/
 *   hour durations) in a grounded article is covered by a research-packet
 *   claim_evidence entry with a real, domain-matched source URL. A single
 *   shop's price list may ground "nguồn X công khai mức ..." phrasing only;
 *   market-wide range claims need sources that actually aggregate vendors.
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
function beginTx(op,articles,extra){ write('data/state/transaction.json',Object.assign({active:true,id:'TX-'+Date.now(),started_at:new Date().toISOString(),operation:op,articles,notes:'In progress; recover() rolls forward or back.'},extra||{})); }
function commitTx(){ write('data/state/transaction.json',{active:false,id:null,started_at:null,operation:null,articles:[],notes:'Committed.'}); }
function readTx(){ return JSON.parse(fs.readFileSync(path.join(STATE,'transaction.json'),'utf8')); }

// ---- checkpoint enrichment: progress pointers derived from repository truth ----
// last_completed_id contract: the LAST id of the CONTIGUOUS COMPLETED PREFIX in
// matrix (row) order — walking rows from the top while status is PUBLISHED and
// stopping at the first non-completed row. NEVER the lexicographic max of all
// PUBLISHED ids: pilot articles published at far-away ids (e.g. A09401) must
// never push the pointer past the actual contiguous production prefix
// (regression: last_completed_id once became A09401 while next_claimable_id
// was A00015 — impossible to resume from).
function lastCompletedId(rows){
  let last=null;
  for(const r of rows){
    if(r.status==='PUBLISHED') last=r.article_id; else break;
  }
  return last;
}
function progressOf(rows){
  const published=rows.filter(r=>r.status==='PUBLISHED').map(r=>r.article_id).sort();
  const planned=rows.filter(r=>r.status==='PLANNED').map(r=>r.article_id).sort();
  const active=rows.filter(r=>UNFINISHED.includes(r.status)).map(r=>r.article_id).sort();
  return { published_count: published.length,
    last_completed_id: lastCompletedId(rows),
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

// ---- QA evidence + publish gate (hash-bound: publish may ONLY promote the
// exact bytes that were scored PASS; any later edit forces a re-QA) ----
const sha256Of = p => require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function qaEvidence(id){ const p=path.join(DATA,'qa',id+'.json');
  if(!fs.existsSync(p)) return null;
  try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch(e){ return null; } }
function publishGate(rows, ids){
  const problems=[]; const byId={}; rows.forEach(r=>byId[r.article_id]=r);
  for(const id of ids){
    const r=byId[id];
    if(!r){ problems.push(id+': not in matrix'); continue; }
    if(r.status!=='PASS'){ problems.push(id+': status '+r.status+' — publish gate requires PASS (never lower the threshold)'); continue; }
    if(Number(r.qa_score||0)<rubric.pass_min){ problems.push(id+': matrix qa_score '+r.qa_score+' < '+rubric.pass_min); continue; }
    const draft=path.join(ROOT,'_drafts',id+'.html');
    if(!fs.existsSync(draft)){ problems.push(id+': NO_DRAFT'); continue; }
    if(fs.existsSync(path.join(ROOT,'data','published',id+'.html'))){ problems.push(id+': AMBIGUOUS — archive already exists while matrix status is '+r.status+' (published before?); resolve per docs/PROC-RECOVERY.md instead of staging over it'); continue; }
    const ev=qaEvidence(id);
    if(!ev){ problems.push(id+': QA_EVIDENCE_MISSING — data/qa/'+id+'.json not found; run qa before publish (draft edited after QA? score it again)'); continue; }
    if(ev.result!=='PASS'){ problems.push(id+': QA_EVIDENCE_NOT_PASS — evidence result='+ev.result+' (must be PASS)'); continue; }
    if(Number(ev.score||0)<rubric.pass_min){ problems.push(id+': QA_EVIDENCE_BELOW_THRESHOLD — evidence score='+ev.score+' < '+rubric.pass_min); continue; }
    if(!ev.draft_sha256){ problems.push(id+': QA_EVIDENCE_MISSING_HASH — evidence has no draft_sha256'); continue; }
    const cur=sha256Of(draft);
    if(cur!==ev.draft_sha256){ problems.push(id+': QA_EVIDENCE_STALE / DRAFT_CHANGED_AFTER_QA — draft sha256 '+cur.slice(0,12)+'… != evidence '+String(ev.draft_sha256).slice(0,12)+'…; re-run qa (the engine never auto-updates the hash)'); continue; }
  }
  return { ok:!problems.length, problems };
}

// ---- grounding gate: quantitative claims must be covered by real evidence ----
function normText(s){ return String(s).replace(/[\u2013\u2014\u2212]/g,'-').replace(/\s+/g,' ').trim(); }
function quantTokensOf(html){
  const t=normText(String(html).replace(/<script[\s\S]*?<\/script>/g,' ').replace(/<[^>]+>/g,' '));
  const set=new Set(); const add=x=>set.add(String(x).toLowerCase());
  // VND amounts (full notation, ranges included) and k-notation
  for(const m of t.matchAll(/(\d{1,3}(?:\.\d{3})+)(?:\s?(?:-|đến)\s?(\d{1,3}(?:\.\d{3})+))?\s?(?:đ|vnđ|vnd)/gi)){ add(m[1]); if(m[2]) add(m[2]); }
  for(const m of t.matchAll(/\b(\d+)\s?k\b(?![a-zà-ỹ])/gi)) add(m[1]+'k');
  // percentages (ranges included)
  for(const m of t.matchAll(/(\d+)(?:\s?(?:-|đến)\s?(\d+))?\s?%/g)){ add(m[1]+'%'); if(m[2]) add(m[2]+'%'); }
  // durations: ranges first, then single values (never the tail of a range)
  for(const m of t.matchAll(/(\d+\s?(?:-|đến)\s?\d+\s?(?:phút|giờ|tiếng))\b/gi)) add(m[1]);
  for(const m of t.matchAll(/(?<![\d-])(\d+\s?(?:phút|giờ|tiếng))\b/gi)) add(m[1]);
  return [...set].sort((a,b)=>a.localeCompare(b,'vi'));
}
function groundingCheck(ids){
  const required=((cfg.grounding||{}).required_ids)||[];
  const rows=loadMatrix(); const byId={}; rows.forEach(r=>byId[r.article_id]=r);
  let check;
  if(ids&&ids.length) check=[...new Set(ids)];
  else { check=[...required]; rows.forEach(r=>{ if(r.status==='PASS') check.push(r.article_id); }); }
  const problems=[]; const checked=[]; const detail={};
  for(const id of check){
    const r=byId[id];
    const artifact=(r&&r.status==='PASS')?path.join(ROOT,'_drafts',id+'.html')
      :path.join(ROOT,'data','published',id+'.html');
    if(!fs.existsSync(artifact)){ problems.push(id+': no artifact to ground (draft/archive missing)'); continue; }
    checked.push(id);
    const tokens=quantTokensOf(fs.readFileSync(artifact,'utf8'));
    detail[id]={tokens};
    if(!tokens.length) continue; // no quantitative claims => nothing to ground
    const packetPath=path.join(DATA,'research',id+'.json');
    let packet=null;
    try{ packet=JSON.parse(fs.readFileSync(packetPath,'utf8')); }
    catch(e){ problems.push(id+': GROUNDING_FAIL — quantitative claims ('+tokens.join(', ')+') but research packet missing/not valid JSON'); continue; }
    const evs=Array.isArray(packet.claim_evidence)?packet.claim_evidence:[];
    if(!evs.length){ problems.push(id+': GROUNDING_FAIL — quantitative claims ('+tokens.join(', ')+') but claim_evidence is empty/missing'); continue; }
    const bad=[];
    evs.forEach((e,i)=>{
      const at=id+'.claim_evidence['+i+']';
      if(!e||typeof e!=='object'){ bad.push(at+' not an object'); return; }
      const u=String(e.source_url||'');
      let host=''; try{ host=new URL(u).hostname; }catch(_){ bad.push(at+' source_url not a valid URL'); }
      if(!/^https?:\/\//.test(u)) bad.push(at+' source_url must be http(s)');
      if(host&&String(e.source_domain||'').toLowerCase()!==host.toLowerCase()) bad.push(at+' source_domain '+e.source_domain+' != hostname '+host);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date_accessed||''))) bad.push(at+' date_accessed must be YYYY-MM-DD');
      if(!String(e.claim||'').trim()) bad.push(at+' missing claim');
      if(!String(e.claim_supported||'').trim()) bad.push(at+' missing claim_supported (quote from the source)');
    });
    if(bad.length){ problems.push(id+': malformed claim_evidence — '+bad.join('; ')); continue; }
    const hay=e=>normText(String(e.claim||'')+' '+String(e.claim_supported||'')).toLowerCase();
    const escReg=s=>s.replace(/[.*+?^${}()|[\]\\]/g,(c)=>'\\'+c); // no backreference-style replacement strings
    const ungrounded=tokens.filter(tok=>!evs.some(e=>{
      try{ return new RegExp('(?<![0-9])'+escReg(tok)+'(?![0-9])','i').test(hay(e)); }catch(_){ return hay(e).includes(tok); }
    }));
    if(ungrounded.length) problems.push(id+': GROUNDING_FAIL — ungrounded quantitative claims: '+ungrounded.join(', '));
  }
  return { ok:!problems.length, problems, checked, detail };
}
function grounding(){
  const g=groundingCheck(null);
  if(!g.ok){ console.error('GROUNDING FAIL\n'+g.problems.join('\n')); process.exitCode=1; return; }
  console.log('GROUNDING PASS: '+g.checked.length+' grounded article(s) checked'+(g.checked.length?' ('+g.checked.join(', ')+')':'')+' — every quantitative claim (VND/%/thời gian) has matching claim_evidence.');
}

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
// ---- atomic publish: stage -> (build+verify, operator path) -> commit ----
// Never leaves a half-PUBLISHED state: archive/public writes without matrix/
// checkpoint updates only exist inside the STAGED window, and an interrupted
// staged publish is deterministically rolled back from the journal. Drafts
// are removed ONLY at commit (publish state already safe); the transaction
// marker clears ONLY after the staged state is fully restored or committed.
function publishStage(args){
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
  const rows=loadMatrix();
  // No ids => take at most the current chunk of PASS rows — never sweep the whole backlog.
  const effIds=args.length?args.slice():rows.filter(r=>r.status==='PASS').map(r=>r.article_id).slice(0,CHUNK);
  if(!effIds.length){ releaseLock(); console.log('PUBLISHED 0 (no PASS rows to stage)'); return {ids:[],started,noop:true}; }
  const gate=publishGate(rows,effIds);
  if(!gate.ok){ releaseLock(); console.error('REFUSED: publish gate (QA evidence must bind the exact PASS draft):\n'+gate.problems.join('\n')); process.exit(1); }
  const ground=groundingCheck(effIds);
  if(!ground.ok){ releaseLock(); console.error('REFUSED: grounding gate:\n'+ground.problems.join('\n')); process.exit(1); }
  const published=rows.filter(r=>r.status==='PUBLISHED').length;
  const room=phase()==='PILOT'?Math.min(cfg.max_publication_in_bootstrap-published,CHUNK):CHUNK;
  if(effIds.length>room){ releaseLock(); console.error('REFUSED: publish would exceed the '+(phase()==='PILOT'?'bootstrap publication cap':'chunk limit')+' (room='+room+', asked='+effIds.length+')'); process.exit(1); }
  // pre-state journal BEFORE any mutation (rollback truth)
  const journal={rows_before:{},checkpoint_before:fs.readFileSync(path.join(STATE,'checkpoint.json'),'utf8'),
    files:[],drafts:effIds.slice(),ids:effIds.slice()};
  effIds.forEach(id=>{ const r=rows.find(x=>x.article_id===id); journal.rows_before[id]=r?r.status:null; });
  beginTx('publish',effIds,{phase:'STAGED',started_ms:started,journal});
  const stagedIds=[];
  for(const id of effIds){
    const r=rows.find(x=>x.article_id===id);
    const draft=path.join(ROOT,'_drafts',id+'.html');
    const html=fs.readFileSync(draft,'utf8');
    const archiveRel=path.join('data','published',id+'.html');
    const siteRel=path.join('site',r.output_path.replace(/^\//,''),'index.html');
    const rootRel=path.join(r.output_path.replace(/^\//,''),'index.html');
    const siteExisted=fs.existsSync(path.join(ROOT,siteRel));
    const rootExisted=fs.existsSync(path.join(ROOT,rootRel));
    fs.mkdirSync(path.join(ROOT,'data','published'),{recursive:true});
    fs.writeFileSync(path.join(ROOT,archiveRel),html); // durable archive
    const dest=path.join(ROOT,siteRel);
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,html);
    journal.files.push({id,archive:archiveRel,archive_existed:false,site:siteRel,site_existed:siteExisted,public:rootRel,public_existed:rootExisted});
    r.status='PUBLISHED'; r.published_date=new Date().toISOString().slice(0,10);
    stagedIds.push(id);
  }
  saveMatrix(rows);
  writeCheckpoint(rows,'Staged publish of '+stagedIds.length+' articles (commit only after build+verify PASS; rollback on failure).',{last_batch:stagedIds});
  // persist the completed journal into the STAGED transaction marker
  const tx=Object.assign({},readTx(),{journal});
  write('data/state/transaction.json',tx);
  console.log('STAGED '+stagedIds.length+': '+stagedIds.join(', ')+' (tx '+tx.id+' — drafts intact, ledger untouched; run build+verify, then publishCommit)');
  return { ids:stagedIds, started, tx };
}
function publishCommit(staged){
  if(!staged||staged.noop){ return; }
  const tx=readTx();
  if(!tx.active||tx.operation!=='publish'||tx.phase!=='STAGED'||!Array.isArray(tx.journal&&tx.journal.ids)){
    console.error('REFUSED: publishCommit — no active STAGED publish transaction (already committed/rolled back?). Run publishStage again.'); process.exit(1);
  }
  const ids=tx.journal.ids;
  const started=Number(tx.started_ms)||staged.started||Date.now();
  for(const id of ids){ const draft=path.join(ROOT,'_drafts',id+'.html'); if(fs.existsSync(draft)) fs.rmSync(draft); }
  if(ids.length) appendLedger({op:'publish',started_at:new Date(started).toISOString(),
    finished_at:new Date().toISOString(),elapsed_ms:Date.now()-started,
    ids,published:ids.length,phase:phase()});
  // future grounding coverage: published ids join the audited scope forever
  if(cfg.grounding&&Array.isArray(cfg.grounding.required_ids)){
    let dirty=false; ids.forEach(id=>{ if(!cfg.grounding.required_ids.includes(id)){ cfg.grounding.required_ids.push(id); dirty=true; } });
    if(dirty) write('config/content-factory.json',cfg);
  }
  commitTx();
  releaseLock();
  console.log('PUBLISHED '+ids.length+': '+ids.join(', '));
}
function publishRollback(reason){
  const tx=readTx();
  if(!tx.active||tx.operation!=='publish'||tx.phase!=='STAGED'||!tx.journal){
    console.error('ROLLBACK REFUSED: no active STAGED publish transaction with journal — nothing deterministic to roll back. Resolve manually per docs/PROC-RECOVERY.md; never force-clear.');
    process.exitCode=1; return { ok:false };
  }
  const j=tx.journal;
  const rows=loadMatrix();
  // 1) restore matrix rows to the pre-stage truth
  for(const id of Object.keys(j.rows_before||{})){
    const r=rows.find(x=>x.article_id===id);
    if(r) r.status=j.rows_before[id];
  }
  saveMatrix(rows);
  // 2) remove files the stage created (never touch pre-existing ones)
  for(const f of (j.files||[])){
    if(f.archive&&!f.archive_existed&&fs.existsSync(path.join(ROOT,f.archive))) fs.rmSync(path.join(ROOT,f.archive));
    if(f.site&&!f.site_existed&&fs.existsSync(path.join(ROOT,f.site))) fs.rmSync(path.join(ROOT,f.site));
  }
  // 3) restore checkpoint bytes (pre-stage truth, incl. last_batch)
  if(j.checkpoint_before) fs.writeFileSync(path.join(STATE,'checkpoint.json'),j.checkpoint_before);
  // 4) deterministic self-heal of derived public tree (hub/sitemap/search-index)
  const rc=require('child_process').spawnSync(process.execPath,[path.join(ROOT,'scripts','site','build-site.js')],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(rc.status!==0){ console.error('ROLLBACK WARNING: post-rollback site rebuild failed (rc='+rc.status+') — public tree may be stale; run build-site after resolving.'); }
  commitTx();
  releaseLock();
  console.log('ROLLBACK COMPLETE (reason: '+reason+') — matrix, checkpoint, archives and staged files restored to pre-publish truth; drafts intact.');
  return { ok:true };
}
function publish(args){ // quick path (sandbox/tests): stage + commit immediately
  const staged=publishStage(args);
  publishCommit(staged);
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
    // STAGED publish = not committed: rollback deterministically from the journal
    // (crash anywhere between beginTx and commit — after archive/site write,
    // before/after matrix save, before checkpoint, before commit — the journal
    // restores the exact pre-stage truth; drafts were never removed).
    if(tx.phase==='STAGED'){
      if(!tx.journal){ console.error('RECOVER STOP: staged publish transaction without a pre-state journal — ambiguous, resolve manually per docs/PROC-RECOVERY.md (never force-clear).'); process.exit(1); }
      console.log('RECOVER: staged (uncommitted) publish '+tx.id+' — deterministic rollback to pre-publish truth.');
      const res=publishRollback('recover: staged transaction '+tx.id+' interrupted');
      if(!res.ok) process.exit(1);
      const ck=syncCheckpoint(loadMatrix());
      console.log('RECOVERED (staged publish rolled back). checkpoint: '+JSON.stringify({phase:ck.phase,published_count:ck.published_count,last_completed_id:ck.last_completed_id,next_claimable_id:ck.next_claimable_id,active_chunk:ck.active_chunk}));
      return;
    }
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
  const groundedIds=((cfg.grounding||{}).required_ids)||[];
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
      // grounded scope: QA evidence must bind the EXACT published bytes
      if(groundedIds.includes(r.article_id)){
        const ev=qaEvidence(r.article_id);
        if(!ev) errors.push('PUBLISHED (grounded scope) without QA evidence: '+r.article_id+' — run qa-repair (never fake evidence)');
        else{
          if(ev.result!=='PASS') errors.push('QA evidence result='+ev.result+' for published '+r.article_id+' (must be PASS)');
          if(Number(ev.score||0)<rubric.pass_min) errors.push('QA evidence score='+ev.score+' < '+rubric.pass_min+' for published '+r.article_id);
          if(!ev.draft_sha256) errors.push('QA evidence missing draft_sha256 for '+r.article_id);
          else if(sha256Of(a)!==ev.draft_sha256) errors.push('QA_EVIDENCE_STALE for '+r.article_id+' — archive sha256 != evidence draft_sha256 (archive changed after scoring; run qa-repair, never fake the hash)');
        }
      }
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
// Re-score a PUBLISHED article's durable archive (content repair path).
// Deterministic: same scoring rules as qa(), but the scored artifact is the
// published archive; the new evidence binds the EXACT archive bytes. Never
// touches PASS/draft flow; a sub-threshold repair result moves the row to
// REPAIR (non-terminal — blocks claiming new chunks until fixed).
function qaRepair(args){
  const rows=loadMatrix(); const id=args[0];
  const r=rows.find(x=>x.article_id===id);
  if(!r){console.error('NOT FOUND');process.exit(1);}
  if(r.status!=='PUBLISHED'){console.error('qa-repair refused: '+id+' status '+r.status+' — only PUBLISHED archives are re-scored (never fabricate evidence for unpublished rows)');process.exit(1);}
  const archive=path.join(ROOT,'data','published',id+'.html');
  if(!fs.existsSync(archive)){console.error('NO ARCHIVE for '+id);process.exit(1);}
  const html=fs.readFileSync(archive,'utf8');
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
  let result;
  if(score>=rubric.pass_min){ result='PASS'; r.status='PUBLISHED'; }
  else if(score>=rubric.review_min){ result='REVIEW'; r.status='REPAIR'; r.repair_attempts=String(Number(r.repair_attempts||0)+1); }
  else{ r.repair_attempts=String(Number(r.repair_attempts||0)+1);
    r.status=Number(r.repair_attempts)>=rubric.max_repair_attempts?'BLOCKED':'REPAIR'; result=r.status; }
  saveMatrix(rows);
  const evPath=path.join(ROOT,'data','qa',id+'.json');
  fs.mkdirSync(path.dirname(evPath),{recursive:true});
  fs.writeFileSync(evPath,JSON.stringify({article_id:id,scored_at:new Date().toISOString(),
    scorer:'factory-qa-deterministic-v1',score,words,result,
    fails, draft_sha256:sha256Of(archive),
    scored_artifact:'published-archive',
    matrix_status_after:r.status},null,2));
  console.log('QA-REPAIR '+id+' score='+score+' words='+words+' status='+r.status+(fails.length?' fails: '+fails.join('; '):''));
  if(result!=='PASS') process.exitCode=1;
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
  const commands={status,'prepare-next':prepareNext,research,qa,'qa-repair':qaRepair,publish,grounding,recover,'promote-production':promoteProduction,consistency,reports};
  if(!commands[cmd]){console.error('Usage: factory.js <status|prepare-next|research|qa|qa-repair|publish|grounding|recover|promote-production|consistency|reports> [args]');process.exit(1);}
  commands[cmd](args);
}
if (require.main === module) main(process.argv.slice(2));
module.exports = { loadMatrix, saveMatrix, loadMatrixText, parseCSV, status, prepareNext,
  research, qa, qaRepair, publish, publishStage, publishCommit, publishRollback, publishGate,
  grounding, groundingCheck, quantTokensOf, recover, promoteProduction, consistency, reports,
  acquireLock, releaseLock, lockState, beginTx, commitTx, readTx, progressOf, lastCompletedId,
  sha256Of, qaEvidence, writeCheckpoint, syncCheckpoint, readLedger, appendLedger, cfg, rubric,
  phase, FIELDS, UNFINISHED, TERMINAL };
