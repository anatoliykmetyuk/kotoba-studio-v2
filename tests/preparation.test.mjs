import assert from 'node:assert/strict';
import {after,afterEach,beforeEach,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import ts from 'typescript';

// Exercise the shipped modules with controlled network and clock boundaries.
// Temporary compilation stays inside the project and needs no extra runner.
const root=fileURLToPath(new URL('..',import.meta.url));
await mkdir(path.join(root,'.runtime'),{recursive:true});
const output=await mkdtemp(path.join(root,'.runtime/preparation-tests-'));
for(const name of ['api','speech-queue','speech']){
 const source=await readFile(path.join(root,'web/src',name+'.ts'),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/from ['"]\.\/(api|speech-queue)['"]/g,"from './$1.mjs'");
 await writeFile(path.join(output,name+'.mjs'),compiled);
}
const {waitJob}=await import(pathToFileURL(path.join(output,'api.mjs')));
const {PlaybackQueue}=await import(pathToFileURL(path.join(output,'speech-queue.mjs')));
let sequence=0;
const speech=()=>import(pathToFileURL(path.join(output,'speech.mjs'))+'?case='+sequence++);
const originalDocument=globalThis.document;const originalWindow=globalThis.window;
beforeEach(()=>{globalThis.document=Object.assign(new EventTarget(),{visibilityState:'visible'});globalThis.window=new EventTarget()});
afterEach(()=>{globalThis.document=originalDocument;globalThis.window=originalWindow});
after(()=>rm(output,{recursive:true,force:true}));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const response=value=>({ok:true,json:async()=>value});
const running=()=>response({state:'running'});
const ready=()=>response({state:'ready',result:{url:'/audio.wav'}});
const aborted=signal=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason)});

test('job readiness and explicit failures return without an extra poll',async t=>{
 const fetch=t.mock.method(globalThis,'fetch',async()=>ready());
 assert.deepEqual(await waitJob('ready'),{url:'/audio.wav'});
 assert.equal(fetch.mock.calls[0].arguments[1].cache,'no-store');
 fetch.mock.mockImplementation(async()=>response({state:'failed',error:'Generation failed'}));
 await assert.rejects(waitJob('failed'),/Generation failed/);
 assert.equal(fetch.mock.calls.length,2);
});

test('canceling during the polling delay prevents later requests',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const fetch=t.mock.method(globalThis,'fetch',async()=>running());
 const controller=new AbortController();const result=waitJob('cancel',controller.signal);
 const rejected=assert.rejects(result,{name:'AbortError'});
 await flush();controller.abort();await rejected;
 document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pageshow'));t.mock.timers.tick(1000);await flush();
 assert.equal(fetch.mock.calls.length,1);
});

test('the job deadline aborts an outstanding network request',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 let signal;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{signal=options.signal;return aborted(signal)});
 const result=assert.rejects(waitJob('timeout',undefined,500),/still processing/);
 t.mock.timers.tick(500);await result;assert.equal(signal.aborted,true);
});

for(const event of ['visibilitychange','pageshow'])test(`resuming with ${event} refreshes a waiting job immediately`,async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 let calls=0;const fetch=t.mock.method(globalThis,'fetch',async()=>++calls===1?running():ready());
 const result=waitJob('resume');await flush();assert.equal(fetch.mock.calls.length,1);
 (event==='pageshow'?window:document).dispatchEvent(new Event(event));
 assert.deepEqual(await result,{url:'/audio.wav'});assert.equal(fetch.mock.calls.length,2);
});

test('a hidden-page event does not poll early',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 let calls=0;const fetch=t.mock.method(globalThis,'fetch',async()=>++calls===1?running():ready());
 const result=waitJob('hidden');await flush();document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'));await flush();
 assert.equal(fetch.mock.calls.length,1);t.mock.timers.tick(1000);await result;
});

test('speech consumers share preparation and then reuse the loaded audio',async t=>{
 const {prepareSpeech}=await speech();
 const fetch=t.mock.method(globalThis,'fetch',async url=>url==='/api/v1/speech'?response({url:'/audio.wav'}):{ok:true,blob:async()=>new Blob(['audio'])});
 t.mock.method(URL,'createObjectURL',()=> 'blob:prepared');
 const [first,second]=await Promise.all([prepareSpeech({text:'test'}),prepareSpeech({text:'test'})]);
 assert.equal(first,'blob:prepared');assert.equal(second,first);assert.equal(await prepareSpeech({text:'test'}),first);
 assert.equal(fetch.mock.calls.length,2);
});

test('canceling one shared speech consumer leaves the other active',async t=>{
 const {prepareSpeech}=await speech();let deliver,signal;
 t.mock.method(globalThis,'fetch',async(url,options)=>url==='/api/v1/speech'?new Promise(resolve=>{deliver=resolve;signal=options.signal}):{ok:true,blob:async()=>new Blob(['audio'])});
 t.mock.method(URL,'createObjectURL',()=> 'blob:shared');
 const controller=new AbortController();const first=prepareSpeech({text:'test'},controller.signal);const second=prepareSpeech({text:'test'});
 const rejected=assert.rejects(first,{name:'AbortError'});controller.abort();await rejected;assert.equal(signal.aborted,false);
 deliver(response({url:'/audio.wav'}));assert.equal(await second,'blob:shared');
});

test('canceling the last consumer stops polling and allows an immediate retry',async t=>{
 const {prepareSpeech}=await speech();let abandoned,calls=0;
 const fetch=t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(++calls===1){abandoned=options.signal;return aborted(abandoned)}
  return url==='/api/v1/speech'?response({url:'/audio.wav'}):{ok:true,blob:async()=>new Blob(['audio'])};
 });
 t.mock.method(URL,'createObjectURL',()=> 'blob:retry');
 const controller=new AbortController();const first=prepareSpeech({text:'test'},controller.signal);const rejected=assert.rejects(first,{name:'AbortError'});
 controller.abort();const second=prepareSpeech({text:'test'});await rejected;assert.equal(abandoned.aborted,true);
 assert.equal(await second,'blob:retry');assert.equal(fetch.mock.calls.length,3);
});

test('the speech deadline also covers downloading the media',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const {prepareSpeech}=await speech();let mediaSignal;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='/api/v1/speech')return response({url:'/audio.wav'});
  mediaSignal=options.signal;return {ok:true,blob:()=>aborted(mediaSignal)};
 });
 const rejected=assert.rejects(prepareSpeech({text:'test'}),/Pronunciation preparation timed out/);
 await flush();t.mock.timers.tick(120_000);await rejected;assert.equal(mediaSignal.aborted,true);
});

test('failed media preparation does not poison the retry or cache',async t=>{
 const {prepareSpeech}=await speech();let fail=true;
 t.mock.method(globalThis,'fetch',async url=>url==='/api/v1/speech'?response({url:'/audio.wav'}):{ok:!fail,blob:async()=>new Blob(['audio'])});
 t.mock.method(URL,'createObjectURL',()=> 'blob:recovered');
 await assert.rejects(prepareSpeech({text:'test'}),/could not load/);fail=false;
 assert.equal(await prepareSpeech({text:'test'}),'blob:recovered');
});

test('rapid token taps play in order without replacing the current item',()=>{
 const played=[];const queue=new PlaybackQueue(input=>played.push(input));
 queue.enqueue('first');queue.enqueue('second');queue.enqueue('third');
 assert.deepEqual(played,['first']);
 queue.ended();assert.deepEqual(played,['first','second']);
 queue.ended();assert.deepEqual(played,['first','second','third']);
 queue.ended();queue.ended();assert.deepEqual(played,['first','second','third']);
 queue.enqueue('fourth');assert.deepEqual(played,['first','second','third','fourth']);
});

test('stopping or replacing playback drops queued items before another tap',()=>{
 const played=[];const queue=new PlaybackQueue(input=>played.push(input));
 queue.enqueue('first');queue.enqueue('obsolete');queue.clear();queue.ended();
 assert.deepEqual(played,['first']);queue.enqueue('next');queue.ended();
 assert.deepEqual(played,['first','next']);
});

test('clicked tokens prepare immediately while their playback remains sequential',()=>{
 const prepared=[],played=[];let canceled=0;
 const queue=new PlaybackQueue(input=>played.push(input),input=>prepared.push(input),()=>canceled++);
 queue.enqueue('first');queue.enqueue('second');queue.enqueue('third');
 assert.deepEqual(prepared,['first','second','third']);assert.deepEqual(played,['first']);
 queue.ended();assert.deepEqual(played,['first','second']);assert.equal(prepared.length,3);
 queue.clear();assert.equal(canceled,1);queue.ended();assert.deepEqual(played,['first','second']);
 queue.enqueue('after stop');assert.deepEqual(prepared,['first','second','third','after stop']);
 assert.deepEqual(played,['first','second','after stop']);
});
