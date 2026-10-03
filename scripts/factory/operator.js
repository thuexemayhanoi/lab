#!/usr/bin/env node
/**
 * operator.js — whitelist command-contract operator for the /lab content factory.
 * Golden port of /blog's factory-operator pattern onto the canonical Node engine.
 *
 * PUSH-DRIVEN PRODUCTION (docs/PROC-PUBLISH.md — the /vanchinh + /blog model):
 * the writer commits the pair into `_drafts/` (wrapped `A#####.html` +
 * `A#####.body.html` + `data/research/<ID>.json`) and pushes;
 * .github/workflows/factory-production.yml derives the EXACT article ids from
 * the pushed diff (scripts/factory/push-selection.js) and drives this CLI:
 * recover → prepare-next --ids → research → qa → publish. The same CLI stays
 * available to the writer locally (identical tooling, identical gates) —
 * there is NO other command channel.
 *
 * HARD BOUNDARIES (same as the engine, docs/PROC-PUBLISH.md):
 * - NO AI calls, NO API keys, NO prose writing. Deterministic tooling only.
 * - NO arbitrary shell: op/ids/count/scope are validated against strict
 *   whitelists; user input is never interpolated into a shell string.
 * - DRAFT BOUNDARY (push-driven): `_drafts/` IS committed (the loop needs it
 *   on Actions) but GitHub Pages runs Jekyll and Jekyll NEVER publishes
 *   underscore directories — drafts are never served publicly. The engine
 *   enforces the contract: `.nojekyll` must be ABSENT and `_drafts/` must NOT
 *   be gitignored (factory.js consistency + capacity-check.js).
 * - RECOVER FIRST: mutating ops refuse while a transaction is active or a live
 *   writer lock is held (run the recover op first). Unclear lock ownership => STOP.
 * - SINGLE COORDINATOR: the workflow serializes runs via concurrency group
 *   `lab-factory-production` (never cancel-in-progress). The publish commit
 *   deletes the drafts (a D-only diff), so push-selection returns mode=skip
 *   and the loop never re-triggers itself.
 *
 * QA SCOPES (docs/PROC-PUBLISH.md "QA modes" — thresholds NEVER change):
 * - fast  (production default for prepare-next/qa/publish — the NORMAL
 *          2-article content loop): scoped consistency of the CURRENT ids
 *          only (factory.js consistency --ids | --chunk: tx/lock sanity,
 *          matrix uniqueness, checkpoint<->matrix coherence, selected-id
 *          invariants). For publish: staged consistency + selected-ID
 *          grounding (+ the deterministic build needed to promote the
 *          staged pages). NO full test-suite, NO capacity-check, NO
 *          editorial-audit, NO full-site audit — a 2-article pair must not
 *          pay for a whole-site verification. Critical factual/legal gates
 *          (publish gate, QA evidence hash, grounding) are UNCHANGED.
 * - deep  : fast + test-suite (node --test tests/test-suite.js) +
 *          capacity-check + editorial-audit.
 * - full  : deep + full-site grounding + deterministic rebuild
 *          (build-site). Engine/workflow changes, final verification.
 * - Tier 4 (soak + watchdog) is for engine/workflow/recovery changes or
 *          scheduled maintenance — NEVER part of the per-pair content loop.
 *
 * ATOMIC PUBLISH (op publish): publishStage (QA-hash gate + grounding gate +
 * staged archive/site/matrix/checkpoint inside a live transaction, drafts
 * intact, pre-state journal) -> build-site + reports + staged verify ->
 * publishCommit ONLY when everything PASS (drafts removed, ledger event
 * appended, transaction cleared). Any failure => publishRollback
 * (deterministic restore; never reports success, never leaves a half-
 * PUBLISHED state). Crash mid-flow => factory.js recover rolls the staged
 * transaction back from the journal. editorial-audit runs pre-commit ONLY
 * in deep/full scope — it never blocks a normal FAST publish.
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

const OPS = ['status','prepare-next','research','qa','publish','recover','consistency','reports','verify'];
const SCOPES = ['fast','deep','full'];
const PRODUCTION_OPS = ['prepare-next','qa','publish']; // default scope fast
const MUTATING = new Set(['prepare-next','research','qa','publish']);
const ID_RE = /^A\d{5}$/;
const COUNT_MIN = 1, COUNT_MAX = 10;
const factory = require(path.join(__dirname, 'factory.js'));
const agentsCore = require(path.join(__dirname, 'agents-core.js'));

// TURBO write-ahead queue: explicit --ids lists may carry up to QUEUE_MAX
// (default 20) ids — one writer push, one deterministic claim. The legacy
// --count path keeps the small CHUNK cap (COUNT_MAX).
const IDS_MAX = Math.max(COUNT_MAX, Number(factory.cfg && factory.cfg.QUEUE_MAX) || 20);

// Durable pause gate: op MUTATING bị từ chối khi state.pause đang giữ production
// (committed truth — bền qua runner). Ngoại lệ duy nhất: agent #4/#5 đang sửa
// CHÍNH incident sở hữu pause (maintenance lock cùng incident_id trên workspace).
function pauseGate(op){
  if (!MUTATING.has(op)) return;
  let pause = null;
  try { pause = agentsCore.durablePause(); }
  catch (e) { fail('pipeline-state.json hỏng cú pháp — KHÔNG chạy op mutating khi state không đọc được (fail-closed): ' + e.message); }
  if (!pause) return;
  const m = agentsCore.maintHeld() ? agentsCore.maintRaw() : null;
  if (m && m.incident_id === pause.incident_id) return;
  fail('production PAUSED (durable): incident ' + pause.incident_id + ' giữ pause — op "' + op + '" bị từ chối. KHÔNG bypass maintenance/pause (giải quyết incident trước, docs/AGENTS-OPS.md).');
}

function fail(msg){ console.error('OPERATOR REFUSED: ' + msg); process.exit(1); }
function resolveScope(cmd){ return cmd.scope || (PRODUCTION_OPS.includes(cmd.op) ? 'fast' : (cmd.op==='verify'?'full':'')); }

function parseIds(v){
  if (v===undefined||v===null||v==='') return [];
  let list=[];
  if (Array.isArray(v)) list=v.map(String);
  else if (typeof v==='string') list=v.split(',');
  else fail('ids must be a string or array');
  list=list.map(s=>s.trim()).filter(Boolean);
  if (list.some(id=>!ID_RE.test(id))) fail('malformed article id in ids (expected A#####): '+JSON.stringify(v));
  if (list.some((id,i)=>list.indexOf(id)!==i)) fail('duplicate id in ids: '+list.join(','));
  if (list.length>IDS_MAX) fail('too many ids ('+list.length+' > IDS_MAX='+IDS_MAX+' — write-ahead queue limit)');
  return list;
}

function validateCommand(cmd){
  if (!cmd || typeof cmd!=='object' || Array.isArray(cmd)) fail('command must be a JSON object');
  if (!OPS.includes(cmd.op)) fail('unsupported op: '+JSON.stringify(cmd.op)+' (whitelist: '+OPS.join(', ')+')');
  if (cmd.ids!==undefined) cmd.ids=parseIds(cmd.ids);
  if (cmd.count!==undefined){
    if(!Number.isInteger(cmd.count)) fail('count must be an integer');
    if(cmd.count<COUNT_MIN||cmd.count>COUNT_MAX) fail('count must be '+COUNT_MIN+'..'+COUNT_MAX+', got '+cmd.count);
  }
  if (typeof cmd.scope==='string') cmd.scope=cmd.scope.trim();
  if (cmd.scope==='') delete cmd.scope; // empty flag (e.g. $SCOPE unset in workflow env) -> op-appropriate default
  if (cmd.scope!==undefined && !SCOPES.includes(cmd.scope)) fail('scope must be fast|deep|full, got '+JSON.stringify(cmd.scope));
  if (cmd.command_id!==undefined && !/^[\w.-]{1,64}$/.test(String(cmd.command_id))) fail('bad command_id');
  if (cmd.coordinator!==undefined && (typeof cmd.coordinator!=='string'||cmd.coordinator.length>100||/[\r\n]/.test(cmd.coordinator))) fail('bad coordinator');
  if (cmd.op==='publish' && (!cmd.ids||!cmd.ids.length)) fail('publish requires ids (only PASS rows are promoted)');
  if (cmd.op==='research' && (!cmd.ids||!cmd.ids.length)) fail('research requires ids');
  if (cmd.op==='prepare-next' && cmd.ids && cmd.ids.length && cmd.count!==undefined) fail('prepare-next: --ids and --count are mutually exclusive (exact push-driven claim vs legacy count claim)');
  if (cmd.op==='qa' && cmd.ids===undefined) cmd.ids=null; // null => all actionable rows
  for (const k of Object.keys(cmd)) if (!['op','ids','count','scope','command_id','coordinator'].includes(k)) fail('unknown command field: '+k);
  return Object.assign({}, cmd, {scope:resolveScope(cmd)});
}

// ---- engine state preflight: repository truth first, recover BEFORE mutate ----
function preflight(){
  const tx=factory.readTx();
  if (tx.active) fail('transaction '+tx.id+' (op='+tx.operation+') is ACTIVE — run the recover op first; no new work while a transaction is in flight.');
  const lock=factory.lockState();
  if (lock.held) fail('writer lock held by '+lock.raw.holder+' (expires '+lock.raw.expires_at+') — unclear ownership, STOP. Run recover.');
  return { tx, lock, rows: factory.loadMatrix() };
}

function run(cmdArr, opts){
  const r=spawnSync(cmdArr[0], cmdArr.slice(1), Object.assign({cwd:ROOT, encoding:'utf8', stdio:['ignore','pipe','pipe']},opts||{}));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status;
}

function runReportsChecked(ctx){
  const rc=run(['node','scripts/factory/factory.js','reports']);
  if (rc!==0){ console.error(ctx+': reports FAIL (rc='+rc+') — STOP, not reporting success.'); process.exit(1); }
}

// Normal (non-staged) verification. FAST is scoped to the CURRENT working
// ids (explicit ids, or the current chunk when none are given) - the normal
// 2-article loop never pays for a full-site sweep or the static test suite.
function verifySteps(scope, ids){
  const s=['fast','deep','full'].includes(scope)?scope:'full'; // unknown scope -> safest (full)
  const idList=(Array.isArray(ids)?ids:[]).filter(Boolean);
  if(s==='fast'){
    // FAST: scoped consistency ONLY (tx/lock sanity, matrix uniques,
    // checkpoint<->matrix coherence, selected-id invariants). No test-suite,
    // no grounding sweep, no capacity-check, no editorial-audit.
    const cons=idList.length
      ? ['node','scripts/factory/factory.js','consistency','--ids',idList.join(',')]
      : ['node','scripts/factory/factory.js','consistency','--chunk'];
    return [cons];
  }
  if(s==='deep'){
    // DEEP: FAST + test-suite + capacity-check + editorial-audit.
    const cons=idList.length
      ? ['node','scripts/factory/factory.js','consistency','--ids',idList.join(',')]
      : ['node','scripts/factory/factory.js','consistency','--chunk'];
    return [cons,
            ['node','--test','tests/test-suite.js'],
            ['node','scripts/factory/capacity-check.js'],
            ['node','scripts/factory/editorial-audit.js']];
  }
  // FULL: global consistency + full grounding + test-suite + capacity-check +
  // editorial-audit + deterministic rebuild.
  return [['node','scripts/factory/factory.js','consistency'],
          ['node','scripts/factory/factory.js','grounding'],
          ['node','--test','tests/test-suite.js'],
          ['node','scripts/factory/capacity-check.js'],
          ['node','scripts/factory/editorial-audit.js'],
          ['node','scripts/site/build-site.js']];
}
// Staged-window verification (atomic publish): every step is STAGED-AWARE -
// consistency and capacity-check accept EXACTLY the in-flight STAGED publish
// transaction (id/operation/phase/journal/ids) instead of requiring "no
// transaction active". The production invariants are NOT weakened: every
// non-staged caller still requires tx inactive + lock free, and a mismatched
// transaction inside the staged window FAILS. tests/test-suite.js deliberately
// runs OUTSIDE the staged window (it is a CI gate on the committed tree; its
// tx-inactive invariant is exactly the post-commit production contract).
// FAST publish = staged consistency + selected-ID grounding ONLY (the
// deterministic build already ran before verify). editorial-audit and
// capacity-check join at deep/full - they NEVER block a normal FAST publish.
function verifyStepsStaged(scope, txId, ids){
  const s=['fast','deep','full'].includes(scope)?scope:'full'; // unknown scope -> safest (full)
  const idList=(Array.isArray(ids)?ids:[]).filter(Boolean);
  const cons=['node','scripts/factory/factory.js','consistency','--staged-tx',String(txId)];
  if(idList.length) cons.push('--staged-ids',idList.join(','));
  const ground=['node','scripts/factory/factory.js','grounding',...idList];
  if(s==='fast') return [cons,ground];
  const steps=[cons,ground,
              ['node','scripts/factory/capacity-check.js','--staged-tx',String(txId)],
              ['node','scripts/factory/editorial-audit.js','--out','reports/editorial/audit-after.json']];
  if(s==='full') steps.push(['node','scripts/factory/factory.js','grounding'],
                            ['node','scripts/site/build-site.js']);
  return steps;
}
function runVerify(scope, ids){
  const steps=verifySteps(scope, ids);
  const failed=[];
  for (const st of steps){ const rc=run(st); if(rc!==0) failed.push(st.join(' ')); }
  if (failed.length){ console.error('VERIFY FAIL (scope='+scope+'): '+failed.join(' | ')); process.exit(1); }
  console.log('VERIFY PASS (scope='+scope+')');
}

// ---- ops ----
function opStatus(){ factory.status(); }

function opPrepareNext(cmd){
  preflight();
  // push-driven production: --ids claims EXACT PLANNED rows (the pushed draft
  // ids from push-selection.js); the legacy --count path is unchanged.
  const args=(cmd.ids&&cmd.ids.length)?['--ids',cmd.ids.join(',')]:cmd.count?[String(cmd.count)]:[];
  factory.prepareNext(args); // acquires lock + tx internally; exits non-zero on refusal
  runReportsChecked('prepare-next');
  // FAST = scoped consistency of the JUST-CLAIMED chunk (checkpoint active
  // chunk). No test-suite / capacity-check / editorial-audit per micro-op.
  runVerify(cmd.scope||'fast');
}

function opResearch(cmd){
  const {rows}=preflight();
  const byId={}; rows.forEach(r=>byId[r.article_id]=r);
  // pre-check ALL ids before mutating anything (all-or-nothing, no partial claims)
  const problems=[];
  for (const id of cmd.ids){
    const r=byId[id];
    if (!r) problems.push(id+' not in matrix');
    else if (r.status!=='RESEARCH'&&r.status!=='WRITING') problems.push(id+' status '+r.status+' (need RESEARCH/WRITING)');
    else if (!fs.existsSync(path.join(ROOT,'data','research',id+'.json'))) problems.push(id+' missing research packet');
  }
  if (problems.length) fail('research pre-check: '+problems.join('; '));
  const started=Date.now();
  factory.acquireLock('operator-research');
  try{ cmd.ids.forEach(id=>factory.research([id])); }
  finally { factory.releaseLock(); }
  factory.appendLedger({op:'research',started_at:new Date(started).toISOString(),finished_at:new Date().toISOString(),
    elapsed_ms:Date.now()-started,ids:cmd.ids,count:cmd.ids.length});
  runReportsChecked('research');
  // FAST = scoped consistency of the researched ids + their research contract
  // (the engine already validated packets/official sources). No test-suite.
  runVerify(cmd.scope||'fast', cmd.ids);
}

function opQa(cmd){
  const {rows}=preflight();
  const byId={}; rows.forEach(r=>byId[r.article_id]=r);
  let ids=cmd.ids;
  if (!ids) ids=rows.filter(r=>['WRITING','QA','REPAIR','REVIEW'].includes(r.status)).map(r=>r.article_id);
  if (!ids.length){ console.log('qa: no actionable rows (WRITING/QA/REPAIR/REVIEW).'); return; }
  // pre-check drafts before mutating (all-or-nothing)
  const problems=[];
  for (const id of ids){
    const r=byId[id];
    if (!r) problems.push(id+' not in matrix');
    else if (factory.TERMINAL.has(r.status)) problems.push(id+' status '+r.status+' is protected');
    else if (!fs.existsSync(path.join(ROOT,'_drafts',id+'.html'))) problems.push(id+' NO_DRAFT (wrapped draft missing from _drafts/ — run wrap-drafts.js, commit and push)');
  }
  if (problems.length) fail('qa pre-check: '+problems.join('; '));
  const started=Date.now();
  factory.acquireLock('operator-qa');
  try{ ids.forEach(id=>factory.qa([id])); }
  finally { factory.releaseLock(); }
  factory.appendLedger({op:'qa',started_at:new Date(started).toISOString(),finished_at:new Date().toISOString(),
    elapsed_ms:Date.now()-started,ids,count:ids.length});
  runReportsChecked('qa');
  // FAST = scoped consistency of the scored ids (QA scores + hash-bound
  // evidence are written by the engine itself). No test-suite, no editorial
  // sweep — critical factual/legal failures still FAIL the QA score hard.
  runVerify(cmd.scope||'fast', ids);
}

// STAGED internal-link gate (fail-closed): every /lab/ href in the staged
// archived pages must resolve to a real file/dir in the built public root
// (branch Pages: the repository root IS the deployable tree). Mirrors the
// test-suite contract "published: internal links resolve to real files"
// (existence ONLY — link-count/depth thresholds stay with QA, not here).
function stagedLinkCheck(ids){
  const problems=[];
  const exists = href => {
    if (href.startsWith('/lab/assets/')) return fs.existsSync(path.join(ROOT, href.replace(/^\/lab\//, '')));
    const p = href.replace(/^\/lab\//, '').replace(/\/$/, '');
    if (!p) return fs.existsSync(path.join(ROOT, 'index.html'));
    if (/\.(xml|txt|md|json)$/i.test(p)) return fs.existsSync(path.join(ROOT, p));
    return fs.existsSync(path.join(ROOT, p, 'index.html'));
  };
  for (const id of ids){
    const f = path.join(ROOT, 'data', 'published', id + '.html');
    if (!fs.existsSync(f)) { problems.push(id + ' NO_ARCHIVE (staged archive page missing)'); continue; }
    const html = fs.readFileSync(f, 'utf8');
    const hrefs = [...html.matchAll(/href="(\/lab\/[^"#]+)"/g)].map(m => m[1]);
    for (const h of hrefs) if (!exists(h)) problems.push(id + ' broken internal link ' + h);
  }
  return problems;
}
function opPublish(cmd){
  const {rows}=preflight();
  const byId={}; rows.forEach(r=>byId[r.article_id]=r);
  // publish gate pre-check: only PASS rows with an existing wrapped draft
  const problems=[];
  for (const id of cmd.ids){
    const r=byId[id];
    if (!r) problems.push(id+' not in matrix');
    else if (r.status!=='PASS') problems.push(id+' status '+r.status+' — publish gate only accepts PASS (never lower the threshold)');
    else if (!fs.existsSync(path.join(ROOT,'_drafts',id+'.html'))) problems.push(id+' NO_DRAFT (wrapped draft missing from _drafts/ — run wrap-drafts.js, commit and push)');
  }
  if (problems.length) fail('publish pre-check: '+problems.join('; '));
  // ATOMIC PUBLISH (Simple Production Mode): stage all mutations
  // (archive/site/matrix/checkpoint, drafts INTACT, ledger untouched,
  // pre-state journal) -> build + reports + staged verify on the staged state
  // -> commit ONLY when everything PASS. FAST staged verify = staged
  // consistency + selected-ID grounding (editorial-audit and capacity-check
  // are deep/full gates — they NEVER block a normal FAST publish). Any
  // failure => deterministic publishRollback (matrix/checkpoint/public
  // restored to pre-publish truth) and NO success report.
  const staged=factory.publishStage(cmd.ids); // exits non-zero on gate refusal
  let failed=null;
  const step=(name,rc)=>{ if(rc!==0&&!failed) failed=name+' (rc='+rc+')'; };
  if(!staged.noop){
    step('build-site', run(['node','scripts/site/build-site.js']));
    if(!failed) step('reports', run(['node','scripts/factory/factory.js','reports']));
    // staged internal-link gate (dead link => rollback, never publish)
    if(!failed){ const lp=stagedLinkCheck(staged.ids); if(lp.length) failed='stagedLinkCheck ('+lp.join('; ')+')'; }
    // STAGED-AWARE VERIFY (was the success-path deadlock): the verification
    // runs against the staged contract — exactly THIS transaction + journal —
    // never a blanket bypass of the tx/lock invariants.
    if(!failed){
      for (const st of verifyStepsStaged(cmd.scope||'fast', staged.tx.id, staged.ids)){ const rc=run(st); if(rc!==0){ failed='verify '+st.join(' '); break; } }
    }
  }
  if(failed){
    console.error('publish: '+failed+' — NOT committed. Rolling back the staged publish (deterministic restore to pre-publish truth; drafts intact).');
    factory.publishRollback('operator publish: '+failed);
    process.exit(1);
  }
  factory.publishCommit(staged);
  runReportsChecked('publish'); // post-commit reports (ledger now holds the real event)
  console.log('PUBLISHED (atomic, build+verify PASS) '+staged.ids.length+': '+staged.ids.join(', '));
}

function opRecover(){ factory.recover(); }
function opConsistency(){ factory.consistency(); }
function opReports(){ factory.reports(); }
function opVerify(cmd){ runVerify(cmd.scope||'full'); }

function execute(cmd){
  pauseGate(cmd.op); // durable pause gate TRƯỚC khi execute op mutating — entrypoint cũ KHÔNG bypass pause
  switch(cmd.op){
    case 'status': return opStatus();
    case 'prepare-next': return opPrepareNext(cmd);
    case 'research': return opResearch(cmd);
    case 'qa': return opQa(cmd);
    case 'publish': return opPublish(cmd);
    case 'recover': return opRecover();
    case 'consistency': return opConsistency();
    case 'reports': return opReports();
    case 'verify': return opVerify(cmd);
  }
}

function usage(){
  console.error('Usage:');
  console.error('  operator.js <op> [--ids A00001,A00002] [--count N] [--scope fast|deep|full] [--command-id ID] [--coordinator NAME]');
  console.error('    prepare-next --ids A00015,A00016 — push-driven EXACT claim (ids from push-selection.js); --ids and --count are mutually exclusive');
  console.error('  Ops whitelist: status, prepare-next, research, qa, publish, recover, consistency, reports, verify');
  console.error('  Production loop: .github/workflows/factory-production.yml on _drafts/ pushes (push-selection.js derives the EXACT ids).');
  process.exit(1);
}

function main(argv){
  // CLI-only op surface (the push-driven production loop
  // .github/workflows/factory-production.yml calls this same CLI):
  // op name is argv[0]; flags start at argv[1]. Everything is validated
  // against the strict whitelist BEFORE anything executes.
  const [a]=argv;
  if (!OPS.includes(a)) fail('unsupported op: '+JSON.stringify(a)+' (whitelist: '+OPS.join(', ')+')');
  const cmd={op:a};
  const flags=argv.slice(1);
  for (let i=0;i<flags.length;i++){
    if (flags[i]==='--ids') cmd.ids=flags[++i];
    else if (flags[i]==='--count'){ const v=flags[++i]; if (v===undefined||!/^\d+$/.test(v)) usage(); cmd.count=parseInt(v,10); }
    else if (flags[i]==='--scope') cmd.scope=flags[++i];
    else if (flags[i]==='--command-id') cmd.command_id=flags[++i];
    else if (flags[i]==='--coordinator') cmd.coordinator=flags[++i];
    else usage();
  }
  const validated=validateCommand(cmd);
  execute(validated);
}

if (require.main===module) main(process.argv.slice(2));
module.exports={validateCommand,parseIds,OPS,SCOPES,verifySteps,verifyStepsStaged,preflight};
