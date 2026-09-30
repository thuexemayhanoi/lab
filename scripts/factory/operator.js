#!/usr/bin/env node
/**
 * operator.js — whitelist command-contract operator for the /lab content factory.
 * Golden port of /blog's factory-operator pattern onto the canonical Node engine.
 *
 * CHANNEL: data/state/operator-command.json — a coordinator (external AI writer or
 * human, GitHub read/write only) pushes a whitelist command; the workflow
 * .github/workflows/factory-operator.yml executes it here. The same CLI runs
 * identically in the writer's local canonical environment.
 *
 * CHANNEL CONTRACT (draft boundary): the Actions command-file channel is NOT
 * the writer direct CLI. It runs `--channel actions` and only accepts ops that
 * can run in a CLEAN CHECKOUT (no _drafts/): status, prepare-next, research,
 * recover, consistency, reports, verify. Draft-bound ops (qa, publish) are
 * REFUSED EARLY at validation (exit code 3, nothing executed, nothing
 * mutated) — the workflow then consumes the refused command so it never hangs.
 * On the writer direct CLI (default channel 'cli') every whitelisted op,
 * including qa/publish, stays available.
 *
 * HARD BOUNDARIES (same as the engine, docs/PROC-PUBLISH.md):
 * - NO AI calls, NO API keys, NO prose writing. Deterministic tooling only.
 * - NO arbitrary shell: op/ids/count/scope are validated against strict
 *   whitelists; user input is never interpolated into a shell string.
 * - DRAFT BOUNDARY (/lab adaptation): Pages serves the repository ROOT
 *   (.nojekyll), so committed drafts would be PUBLIC. `_drafts/` stays
 *   gitignored and NEVER committed. Ops that need draft prose (qa, publish)
 *   therefore run in the writer's environment via this same CLI; in a bare
 *   Actions checkout they stop safely with NO_DRAFT (nothing is mutated).
 * - RECOVER FIRST: mutating ops refuse while a transaction is active or a live
 *   writer lock is held (run the recover op first). Unclear lock ownership => STOP.
 * - SINGLE COORDINATOR: the workflow serializes runs via concurrency group
 *   `lab-factory-production`; the command file is consumed exactly once
 *   (deleted in the operator commit) and a new command never overwrites an
 *   unconsumed one (rebase keeps origin's new command).
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
const CMD_FILE = path.join(ROOT, 'data', 'state', 'operator-command.json');

const OPS = ['status','prepare-next','research','qa','publish','recover','consistency','reports','verify'];
const SCOPES = ['fast','deep','full'];
// DRAFT BOUNDARY (channel contract): ops that read `_drafts/<ID>.html`.
// `_drafts/` is gitignored and NEVER committed, so a GitHub Actions clean
// checkout can never run them. On the ACTIONS channel they are REFUSED EARLY
// (exit code 3) at validate time — never accepted only to die NO_DRAFT mid-run
// and leave operator-command.json hanging. The writer direct CLI (default
// channel) keeps full access: drafts exist there.
const DRAFT_OPS = ['qa','publish'];
const CHANNELS = ['actions','cli'];
const EXIT_CHANNEL_REFUSED = 3;
const ACTIONS_OPS = () => OPS.filter(o => !DRAFT_OPS.includes(o));
const PRODUCTION_OPS = ['prepare-next','qa','publish']; // default scope fast
const MUTATING = new Set(['prepare-next','research','qa','publish']);
const ID_RE = /^A\d{5}$/;
const COUNT_MIN = 1, COUNT_MAX = 10;
const factory = require(path.join(__dirname, 'factory.js'));

function fail(msg){ console.error('OPERATOR REFUSED: ' + msg); process.exit(1); }
function failChannel(msg){ console.error('OPERATOR CHANNEL REFUSED: ' + msg); process.exit(EXIT_CHANNEL_REFUSED); }
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
  if (list.length>COUNT_MAX) fail('too many ids ('+list.length+' > '+COUNT_MAX+')');
  return list;
}

function validateCommand(cmd, channel){
  const ch = channel || 'cli'; // default: writer direct CLI (drafts exist there)
  if (!CHANNELS.includes(ch)) fail('unknown channel '+JSON.stringify(ch)+' (expected: '+CHANNELS.join('|')+')');
  if (!cmd || typeof cmd!=='object' || Array.isArray(cmd)) fail('command must be a JSON object');
  if (!OPS.includes(cmd.op)) fail('unsupported op: '+JSON.stringify(cmd.op)+' (whitelist: '+OPS.join(', ')+')');
  if (ch==='actions' && DRAFT_OPS.includes(cmd.op)) {
    // REFUSE EARLY, nothing executed, nothing mutated: a clean checkout has no
    // _drafts/ — accepting this command would only die NO_DRAFT mid-run and
    // leave the command file hanging. qa/publish run via the writer direct CLI.
    failChannel('op "'+cmd.op+'" requires _drafts/ (gitignored, never committed) — it cannot run in an Actions clean checkout. The Actions command-file channel only accepts: '+ACTIONS_OPS().join(', ')+'. Run "'+cmd.op+'" via the writer direct CLI (node scripts/factory/operator.js '+cmd.op+' ...).');
  }
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
  if (cmd.op==='qa' && cmd.ids===undefined) cmd.ids=null; // null => all actionable rows
  for (const k of Object.keys(cmd)) if (!['op','ids','count','scope','command_id','coordinator'].includes(k)) fail('unknown command field: '+k);
  return Object.assign({}, cmd, {scope:resolveScope(cmd)});
}

function loadCommandFile(p, channel){
  let raw;
  try { raw=fs.readFileSync(p,'utf8'); } catch(e){ fail('cannot read command file '+p+': '+e.message); }
  let cmd;
  try { cmd=JSON.parse(raw); } catch(e){ fail('command file is not valid JSON: '+e.message); }
  return validateCommand(cmd, channel);
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
  const args=cmd.count?[String(cmd.count)]:[];
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
    else if (!fs.existsSync(path.join(ROOT,'_drafts',id+'.html'))) problems.push(id+' NO_DRAFT (drafts live in the writer environment, gitignored — never committed)');
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

function opPublish(cmd){
  const {rows}=preflight();
  const byId={}; rows.forEach(r=>byId[r.article_id]=r);
  // publish gate pre-check: only PASS rows with an existing wrapped draft
  const problems=[];
  for (const id of cmd.ids){
    const r=byId[id];
    if (!r) problems.push(id+' not in matrix');
    else if (r.status!=='PASS') problems.push(id+' status '+r.status+' — publish gate only accepts PASS (never lower the threshold)');
    else if (!fs.existsSync(path.join(ROOT,'_drafts',id+'.html'))) problems.push(id+' NO_DRAFT (drafts live in the writer environment, gitignored — never committed)');
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
  console.error('  operator.js validate <command.json> [--channel actions|cli]  # whitelist validation, prints resolution (exports GITHUB_ENV when present)');
  console.error('  operator.js command <command.json> [--channel actions|cli]   # validate + execute one command file');
  console.error('  operator.js <op> [--ids A00001,A00002] [--count N] [--scope fast|deep|full] [--command-id ID] [--coordinator NAME]');
  console.error('Channels: actions = GitHub Actions command-file channel (clean checkout, no _drafts/ — draft ops qa/publish are REFUSED early, exit 3).');
  console.error('          cli     = writer direct CLI (default; drafts exist, all ops available).');
  process.exit(1);
}

function exportEnv(cmd){
  if (!process.env.GITHUB_ENV) return;
  const env={OP:cmd.op, IDS:(cmd.ids||[]).join(','), COUNT:cmd.count!==undefined?String(cmd.count):'',
    SCOPE:cmd.scope||'', COMMAND_ID:cmd.command_id||'', COORDINATOR:cmd.coordinator||''};
  fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(env).map(([k,v])=>k+'='+v).join('\n')+'\n');
}

function main(argv){
  const [a,b,...rest]=argv;
  if (a==='validate'||a==='command'){
    if (!b||b.startsWith('--')) usage();
    // channel flag: the Actions command-file workflow passes --channel actions
    // so draft-bound ops (qa/publish) are refused EARLY (exit 3) instead of
    // being accepted and dying NO_DRAFT mid-run with a hanging command file.
    let channel='cli';
    for (let i=0;i<rest.length;i++){
      if (rest[i]==='--channel'){ channel=rest[++i]; if(!CHANNELS.includes(channel)) fail('unknown channel '+JSON.stringify(channel)+' (expected: '+CHANNELS.join('|')+')'); }
      else fail('unknown flag for '+a+': '+rest[i]);
    }
    const cmd=loadCommandFile(path.isAbsolute(b)?b:path.join(process.cwd(),b), channel);
    if (a==='validate'){ exportEnv(cmd); console.log('COMMAND OK '+JSON.stringify({op:cmd.op,ids:cmd.ids,count:cmd.count,scope:cmd.scope,command_id:cmd.command_id,coordinator:cmd.coordinator,channel})); return; }
    execute(cmd);
    return;
  }
  // direct CLI op: op name is argv[0]; flags start at argv[1] (writer channel — drafts exist)
  if (!OPS.includes(a)) usage();
  const cmd={op:a};
  const flags=argv.slice(1);
  for (let i=0;i<flags.length;i++){
    if (flags[i]==='--ids') cmd.ids=flags[++i];
    else if (flags[i]==='--count') cmd.count=parseInt(flags[++i],10);
    else if (flags[i]==='--scope') cmd.scope=flags[++i];
    else if (flags[i]==='--command-id') cmd.command_id=flags[++i];
    else if (flags[i]==='--coordinator') cmd.coordinator=flags[++i];
    else usage();
  }
  const validated=validateCommand(cmd);
  execute(validated);
}

if (require.main===module) main(process.argv.slice(2));
module.exports={validateCommand,loadCommandFile,parseIds,OPS,DRAFT_OPS,CHANNELS,EXIT_CHANNEL_REFUSED,ACTIONS_OPS,SCOPES,verifySteps,verifyStepsStaged,preflight,CMD_FILE};
