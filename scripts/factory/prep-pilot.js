#!/usr/bin/env node
/** prep-pilot.js — deterministic pilot prep: mark the 10 pilot rows PLANNED→RESEARCH. */
'use strict';
const { execSync } = require('child_process');
execSync('node ' + __dirname + '/factory.js status', { stdio: 'inherit' }); // ensure matrix assembled
const fs = require('fs');
const p = 'data/content-matrix.csv';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const ids = new Set(process.argv.slice(2).length ? process.argv.slice(2) :
  ['A00001','A00052','A00097','A00465','A05060','A06003','A06801','A07602','A08201','A09401']);
function cells(l){const o=[];let c='',q=false;for(let i=0;i<l.length;i++){const ch=l[i];
 if(q){ if(ch==='"'){ if(l[i+1]==='"'){c+='"';i++;} else q=false; } else c+=ch; }
 else { if(ch==='"')q=true; else if(ch===','){o.push(c);c='';} else c+=ch; } }
 o.push(c); return o; }
const out=[lines[0]]; let n=0;
for(const l of lines.slice(1).filter(x=>x.trim())){
  const c=cells(l);
  if(ids.has(c[0]) && c[24]==='PLANNED'){ c[24]='RESEARCH'; n++; }
  out.push(c.map(v=>/[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v).join(','));
}
fs.writeFileSync(p, out.join('\n'));
fs.writeFileSync('data/state/checkpoint.json', JSON.stringify({last_run:new Date().toISOString(),phase:'PILOT',matrix_rows:out.length-1,published_count:0,last_batch:[...ids],notes:'Pilot set of 10 prepared for research (deterministic pilot prep).'},null,2));
console.log('PREPARED', n);
