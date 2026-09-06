#!/usr/bin/env node
/** Apply GROK_SCREENING_V1 unified diffs to abc.mjs / abc-collect.mjs (pure JS). */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync} from 'node:zlib';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function applyUnified(src,diffText){
  const lines=src.split(/(?<=\n)/);
  const hunks=[];
  let cur=null;
  for(const line of diffText.split(/(?<=\n)/)){
    if(line.startsWith('@@')){
      const m=/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      cur={oldStart:Number(m[1])-1,parts:[]}; hunks.push(cur);
    } else if(cur && !line.startsWith('\\')) cur.parts.push(line);
  }
  const out=lines.slice();
  for(const h of [...hunks].reverse()){
    const oldLines=[], newLines=[];
    for(const L of h.parts){
      if(L.startsWith(' ')) {oldLines.push(L.slice(1)); newLines.push(L.slice(1));}
      else if(L.startsWith('-')) oldLines.push(L.slice(1));
      else if(L.startsWith('+')) newLines.push(L.slice(1));
    }
    const chunk=out.slice(h.oldStart,h.oldStart+oldLines.length);
    if(chunk.join('')!==oldLines.join('')) throw new Error('hunk mismatch at line '+(h.oldStart+1));
    out.splice(h.oldStart,oldLines.length,...newLines);
  }
  return out.join('');
}

function inflateB64(name){
  const p=resolve(root,'patches',name+'.zlib.b64');
  if(!existsSync(p)) return null;
  return inflateSync(Buffer.from(readFileSync(p,'utf8'),'base64')).toString('utf8');
}

const map=[
  ['abc.mjs','abc-screening-abc.mjs.patch'],
  ['abc-collect.mjs','abc-screening-collect.mjs.patch'],
];
for(const [file,patchName] of map){
  const target=resolve(root,file);
  const patchPath=resolve(root,'patches',patchName);
  let body;
  const fromB64=inflateB64(file);
  if(fromB64){ body=fromB64; console.log('using zlib payload for',file); }
  else if(existsSync(patchPath)){
    const src=readFileSync(target,'utf8');
    body=applyUnified(src,readFileSync(patchPath,'utf8'));
    console.log('applied unified diff',patchName);
  } else throw new Error('missing patch/payload for '+file);
  writeFileSync(target,body);
  console.log('wrote',file,body.length);
}
console.log('GROK_SCREENING_V1 wiring applied — buy gates unchanged');
