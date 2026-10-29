/* Explicit checkpoints have their own acknowledged queue. Other offline
   mutations must not report success. */
const SHELL='kotoba-shell-'+VERSION;const DATA='kotoba-read-cache-v2';
const NETWORK_TIMEOUT_MS=8000;
self.addEventListener('install',event=>event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(PRECACHE))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('kotoba-shell-')&&name!==SHELL||name.startsWith('kotoba-read-cache-')&&name!==DATA)await caches.delete(name);await self.clients.claim()})()));
const statusReceipts=new Map();let dataWrites=Promise.resolve();
function serializeData(write){const task=dataWrites.catch(()=>{}).then(write);dataWrites=task;return task}
function jsonResponse(data,response){
 const headers=new Headers(response.headers);for(const name of ['Content-Length','Content-Encoding','ETag'])headers.delete(name);
 return new Response(JSON.stringify(data),{status:response.status,headers});
}
function mergeStatusData(path,data){
 if(/^\/api\/v1\/words\/[^/]+$/.test(path)&&data.status&&data.base){
  const receipt=statusReceipts.get(data.base.id);
  if(receipt&&data.status.revision>receipt.revision)statusReceipts.set(data.base.id,data.status);
  else if(receipt&&receipt.revision>=data.status.revision)return {...data,status:receipt};
 }else if(/^\/api\/v1\/texts\/[^/]+$/.test(path)&&Array.isArray(data.sentences)){
  let changed=false;
  const sentences=data.sentences.map(sentence=>{
   let affected=false;
   const tokens=sentence.tokens.map(token=>{
    const receipt=statusReceipts.get(token.baseId);if(!receipt)return token;
    if(token.statusRevision>receipt.revision){statusReceipts.set(token.baseId,{state:token.state,revision:token.statusRevision});return token}
    if(receipt.revision===token.statusRevision&&receipt.state===token.state)return token;
    affected=true;return {...token,state:receipt.state,statusRevision:receipt.revision};
   });
   if(!affected)return sentence;changed=true;return {...sentence,tokens};
  });
  if(changed)return {...data,sentences};
 }
 return data;
}
self.addEventListener('message',event=>{
 if(event.data==='activate-update'){event.waitUntil(self.skipWaiting());return}
 if(event.data?.type==='checkpoint-cache'){
  const text=event.data.text;
  if(!text||typeof text.id!=='string'||!Array.isArray(text.sentences)){event.ports[0]?.postMessage({ok:false});return}
  event.waitUntil(serializeData(async()=>{
   const cache=await caches.open(DATA),key='/api/v1/texts/'+text.id;
   await cache.put(key,jsonResponse(mergeStatusData(key,text),new Response(null,{headers:{'Content-Type':'application/json'}})));
   const library=await cache.match('/api/v1/texts');
   if(library){const items=await library.json();await cache.put('/api/v1/texts',jsonResponse(items.map(item=>item.id===text.id?{...item,textState:text.textState,readingProgress:text.readingProgress,revision:text.revision}:item),library))}
  }).then(()=>event.ports[0]?.postMessage({ok:true}),()=>event.ports[0]?.postMessage({ok:false})));
  return;
 }
 const {type,baseId,status}=event.data??{};
 if(type!=='word-status'||typeof baseId!=='string'||!status||!['new','learning','familiar','known'].includes(status.state)||!Number.isInteger(status.revision)||status.revision<0)return;
 const old=statusReceipts.get(baseId);if(old&&old.revision>status.revision)return;
 statusReceipts.set(baseId,{state:status.state,revision:status.revision});
 event.waitUntil(serializeData(async()=>{
  const cache=await caches.open(DATA);
  for(const key of await cache.keys()){
   const path=new URL(key.url).pathname;
   if(!/^\/api\/v1\/(texts|words)\/[^/]+$/.test(path))continue;
   const response=await cache.match(key);if(!response)continue;
   const previous=await response.json(),data=mergeStatusData(path,previous);
   if(data!==previous)await cache.put(key,jsonResponse(data,response));
  }
 }));
});
async function remember(cache,request,response,max){
 if(response.ok){
  let stored=response.clone();
  if(typeof request!=='string'&&new URL(request.url).pathname.startsWith('/api/v1/')&&statusReceipts.size){
   const data=mergeStatusData(new URL(request.url).pathname,await stored.json());
   stored=jsonResponse(data,response);
  }
  await cache.put(request,stored);if(max){const keys=await cache.keys();for(const key of keys.slice(0,Math.max(0,keys.length-max)))await cache.delete(key)}}
 return response;
}
async function networkFirst(request,name,key=request,max){
 const cache=await caches.open(name);const stored=await cache.match(key);
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),NETWORK_TIMEOUT_MS);
 const cancel=()=>controller.abort(request.signal.reason);
 if(request.signal.aborted)cancel();else request.signal.addEventListener('abort',cancel,{once:true});
 try{
  const response=await fetch(request,{signal:controller.signal});
  // A reachable HTTPS gateway can still have an unavailable upstream. Only
  // server failures use stale data; authorization and missing-resource errors
  // must reach the caller unchanged.
  if(response.status>=500&&stored)return stored;
  // Cache quota cannot break a successful read, but an aborted response body
  // still needs the same fallback as a connection that never sent headers.
  try{await (name===DATA?serializeData(()=>remember(cache,key,response,max)):remember(cache,key,response,max))}catch(error){if(error.name!=='QuotaExceededError')throw error}
  return response;
 }catch(error){if(stored&&!request.signal.aborted)return stored;throw error}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',cancel)}
}
self.addEventListener('fetch',event=>{
 const request=event.request;const url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin)return;
 if(request.mode==='navigate'){
  event.respondWith(networkFirst(request,SHELL,'/index.html'));return;
 }
 if(/^\/api\/v1\/(texts(?:\/[^/]+)?|words\/[^/]+|settings)$/.test(url.pathname)){
  event.respondWith(networkFirst(request,DATA,request,80));return;
 }
 // All other API reads, including ephemeral phrase jobs/media, bypass storage.
 if(url.pathname.startsWith('/api/'))return;
 if(PRECACHE.includes(url.pathname))event.respondWith(caches.match(request).then(stored=>stored||fetch(request)));
});
