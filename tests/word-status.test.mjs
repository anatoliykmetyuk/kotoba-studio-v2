import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import ts from 'typescript';
const dir=await mkdtemp(new URL('../.runtime/status-tests-',import.meta.url));
const checkpointSource=await readFile(new URL('../web/src/checkpoints.ts',import.meta.url),'utf8');
await writeFile(dir+'/checkpoints.mjs',ts.transpileModule(checkpointSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
const {applyCheckpoint}=await import('file://'+dir+'/checkpoints.mjs');
const source=await readFile(new URL('../web/src/word-status.ts',import.meta.url),'utf8');
await writeFile(dir+'/status.mjs',ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
const {WordStatuses,displayTextStatuses,patchTextStatus}=await import('file://'+dir+'/status.mjs');
after(()=>rm(dir,{recursive:true,force:true}));
const initial={state:'new',revision:4};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('pending changes update every form while unrelated words and server revisions remain intact',async()=>{
 const saved=[],store=new WordStatuses((id,status)=>saved.push({id,status})),request=deferred();
 const result=store.change('family','known',initial,()=>request.promise);
 const original={revision:9,cursor:12,readingProgress:.3,sentences:[{tokens:[{id:'a',baseId:'family',surface:'遊ぶ',state:'new',statusRevision:4},{id:'b',baseId:'family',surface:'遊びました',state:'new',statusRevision:4},{id:'c',baseId:'other',state:'learning',statusRevision:2}]}]};
 const displayed=displayTextStatuses(original,store.getSnapshot());
 assert.deepEqual(displayed.sentences[0].tokens.map(t=>t.state),['known','known','learning']);
 assert.equal(original.sentences[0].tokens[0].state,'new');assert.equal(displayed.cursor,12);assert.equal(displayed.revision,9);assert.equal(displayed.readingProgress,.3);
 assert.equal(saved.length,0);assert.equal(store.getSnapshot().get('family').pending,true);
 request.resolve({state:'known',revision:5});await result;
 assert.equal(saved.length,1);assert.equal(store.getSnapshot().get('family').pending,false);
});

test('rapid clicks stay in order, use acknowledged revisions, and never flash an older intention',async()=>{
 const store=new WordStatuses(),first=deferred(),second=deferred(),seen=[];
 const one=store.change('family','learning',initial,revision=>{seen.push(revision);return first.promise});
 const two=store.change('family','known',initial,revision=>{seen.push(revision);return second.promise});
 assert.deepEqual(seen,[4]);assert.equal(store.getSnapshot().get('family').state,'known');
 first.resolve({state:'learning',revision:5});await one;
 assert.deepEqual(seen,[4,5]);assert.equal(store.getSnapshot().get('family').state,'known');
 second.resolve({state:'known',revision:6});await two;assert.equal(store.getSnapshot().get('family').pending,false);
});

test('a failed early save leaves the newest intention visible and does not advance its revision',async()=>{
 const saved=[],store=new WordStatuses((id,status)=>saved.push(status)),first=deferred(),second=deferred(),seen=[];
 const one=store.change('family','learning',initial,()=>first.promise);const failed=assert.rejects(one,/unavailable/);
 const two=store.change('family','familiar',initial,revision=>{seen.push(revision);return second.promise});
 first.reject(new Error('unavailable'));await failed;
 assert.equal(store.getSnapshot().get('family').state,'familiar');assert.deepEqual(seen,[4]);assert.deepEqual(saved,[]);
 second.resolve({state:'familiar',revision:5});await two;assert.deepEqual(saved,[{state:'familiar',revision:5}]);
});

test('the latest failed save rolls back to the last success, including New-to-Learning',async()=>{
 const store=new WordStatuses();
 await assert.rejects(store.change('family','learning',initial,async()=>{throw new Error('offline')}));
 assert.deepEqual(store.getSnapshot().get('family'),{...initial,pending:false});
 await store.change('family','known',initial,async()=>({state:'known',revision:5}));
 await assert.rejects(store.change('family','familiar',initial,async()=>{throw new Error('offline')}));
 assert.deepEqual(store.getSnapshot().get('family'),{state:'known',revision:5,pending:false});
});

test('a stale read cannot undo a receipt, while newer data from another device is accepted',async()=>{
 const store=new WordStatuses();await store.change('family','known',initial,async()=>({state:'known',revision:5}));
 assert.deepEqual(store.reconcile('family',initial),{state:'known',revision:5});
 assert.deepEqual(store.reconcile('family',{state:'familiar',revision:8}),{state:'familiar',revision:8});
 assert.equal(store.getSnapshot().get('family').state,'familiar');
 const newer={sentences:[{tokens:[{baseId:'family',state:'learning',statusRevision:9}]}]};
 assert.equal(patchTextStatus(newer,'family',{state:'known',revision:5}),newer);
});

test('independent families save concurrently and atomic promotion keeps a remotely Known word',async()=>{
 const store=new WordStatuses(),first=deferred(),second=deferred(),started=[];
 const one=store.change('a','learning',initial,()=>{started.push('a');return first.promise});
 const two=store.change('b','known',initial,()=>{started.push('b');return second.promise});assert.deepEqual(started,['a','b']);
 second.resolve({state:'known',revision:5});await two;assert.equal(store.getSnapshot().get('a').pending,true);
 first.resolve({state:'known',revision:10});await one;assert.equal(store.getSnapshot().get('a').state,'known');await flush();
});


test('confirmed New receipts do not undo queued checkpoint promotion',async()=>{
 const store=new WordStatuses();await store.change('family','new',initial,async()=>({state:'new',revision:5}));
 const text={id:'lesson',sentences:[{start:0,end:4,completed:false,tokens:[{baseId:'family',state:'new',statusRevision:5}]}]};
 const queued=applyCheckpoint(text,{textId:'lesson',start:0,end:4,completed:true});
 assert.equal(displayTextStatuses(queued,store.getSnapshot(),true).sentences[0].tokens[0].state,'known');
});


test('newer statuses from another device reach the reader before pending checkpoint projections',async()=>{
 const store=new WordStatuses();await store.change('family','known',initial,async()=>({state:'known',revision:5}));
 const text={id:'lesson',sentences:[{start:0,end:4,completed:false,tokens:[{baseId:'family',state:'known',statusRevision:5}]}]};
 store.reconcile('family',{state:'learning',revision:6});
 const confirmed=displayTextStatuses(text,store.getConfirmedSnapshot());
 const queued=applyCheckpoint(confirmed,{textId:'lesson',start:0,end:4,completed:true});
 assert.equal(displayTextStatuses(queued,store.getSnapshot(),true).sentences[0].tokens[0].state,'learning');
 store.reconcile('family',{state:'new',revision:7});
 const newQueued=applyCheckpoint(displayTextStatuses(text,store.getConfirmedSnapshot()),{textId:'lesson',start:0,end:4,completed:true});
 assert.equal(displayTextStatuses(newQueued,store.getSnapshot(),true).sentences[0].tokens[0].state,'known');
});
