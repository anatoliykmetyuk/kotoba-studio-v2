import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../web/sw.js',import.meta.url),'utf8');
const origin='https://fixture.test';
const text=state=>({revision:7,cursor:13,sentences:[{tokens:[{baseId:'cat',state,statusRevision:2},{baseId:'cat',state,statusRevision:2},{baseId:'dog',state:'learning',statusRevision:3}]}]});
function fixture(fetch){
 const entries=new Map(),handlers=new Map();
 const key=request=>typeof request==='string'?new URL(request,origin).href:request.url;
 const cache={match:async request=>entries.get(key(request))?.clone(),put:async(request,response)=>{entries.set(key(request),response.clone())},keys:async()=>[...entries.keys()].map(url=>new Request(url)),delete:async request=>entries.delete(key(request))};
 const context={VERSION:'test',PRECACHE:[],Headers,Request,Response,URL,AbortController,setTimeout,clearTimeout,fetch,caches:{open:async()=>cache},self:{location:{origin},addEventListener:(name,fn)=>handlers.set(name,fn)}};
 vm.runInNewContext(source,context);
 return {cache,
  async checkpoint(text){let pending,ack;handlers.get('message')({data:{type:'checkpoint-cache',text},ports:[{postMessage:value=>{ack=value}}],waitUntil:p=>{pending=p}});await pending;assert.equal(ack.ok,true)},
  async message(status){let pending;handlers.get('message')({data:{type:'word-status',baseId:'cat',status},waitUntil:p=>{pending=p}});await pending},
  async read(path,mode){let result;const request=new Request(origin+path);if(mode)Object.defineProperty(request,'mode',{value:mode});handlers.get('fetch')({request,respondWith:p=>{result=p}});return (await result).json()}
 };
}

test('acknowledged saves patch all cached occurrences and preserve unrelated data',async()=>{
 const f=fixture();await f.cache.put('/api/v1/texts/lesson',new Response(JSON.stringify(text('new'))));
 await f.cache.put('/api/v1/words/cat',new Response(JSON.stringify({base:{id:'cat'},status:{state:'new',revision:2},meanings:['cat']})));
 await f.message({state:'known',revision:3});
 const saved=await(await f.cache.match('/api/v1/texts/lesson')).json();
 assert.deepEqual(saved.sentences[0].tokens.map(t=>t.state),['known','known','learning']);assert.equal(saved.cursor,13);assert.equal(saved.revision,7);
 assert.equal((await(await f.cache.match('/api/v1/words/cat')).json()).status.state,'known');
 await f.message({state:'learning',revision:2});assert.equal((await(await f.cache.match('/api/v1/words/cat')).json()).status.state,'known');
});

test('a read begun before acknowledgment cannot overwrite the saved offline status',async()=>{
 let deliver;const f=fixture(()=>new Promise(resolve=>{deliver=resolve}));
 const read=f.read('/api/v1/texts/lesson');while(!deliver)await new Promise(setImmediate);
 await f.message({state:'known',revision:3});deliver(new Response(JSON.stringify(text('new'))));await read;
 assert.equal((await(await f.cache.match('/api/v1/texts/lesson')).json()).sentences[0].tokens[0].state,'known');
});

test('newer statuses read from another device survive later delayed receipts',async()=>{
 const current=text('familiar');current.sentences[0].tokens[0].statusRevision=9;current.sentences[0].tokens[1].statusRevision=9;
 const f=fixture(async()=>new Response(JSON.stringify(current)));await f.message({state:'known',revision:3});await f.read('/api/v1/texts/lesson');await f.message({state:'learning',revision:4});
 const cached=await(await f.cache.match('/api/v1/texts/lesson')).json();assert.equal(cached.sentences[0].tokens[0].state,'familiar');assert.equal(cached.sentences[0].tokens[0].statusRevision,9);
});


test('checkpoint durability and status acknowledgments share a write queue',async()=>{
 const f=fixture(),put=f.cache.put;let release,blocked;
 const started=new Promise(resolve=>{blocked=resolve});
 f.cache.put=async(request,response)=>{
  if(!release){await new Promise(resolve=>{release=resolve;blocked()})}
  await put(request,response);
 };
 const checkpoint=f.checkpoint({...text('new'),id:'lesson',textState:'completed',readingProgress:1});await started;
 const status=f.message({state:'known',revision:3});release();await Promise.all([checkpoint,status]);
 const cached=await(await f.cache.match('/api/v1/texts/lesson')).json();assert.equal(cached.sentences[0].tokens[0].state,'known');assert.equal(cached.readingProgress,1);
 // Reversing message order must also preserve the latest word receipt.
 await f.checkpoint({...text('new'),id:'lesson',textState:'new',readingProgress:0});
 assert.equal((await(await f.cache.match('/api/v1/texts/lesson')).json()).sentences[0].tokens[0].state,'known');
});


test('online navigation still refreshes the shell stored under its string cache key',async()=>{
 const f=fixture(async()=>new Response(JSON.stringify({shell:'new'})));
 await f.cache.put('/index.html',new Response(JSON.stringify({shell:'old'})));
 assert.deepEqual(await f.read('/','navigate'),{shell:'new'});
 assert.deepEqual(await(await f.cache.match('/index.html')).json(),{shell:'new'});
});
