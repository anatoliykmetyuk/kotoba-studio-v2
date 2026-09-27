/* No mutation request is intercepted or queued here. Reading progress has its
   own acknowledged queue; offline state/status writes must not report success. */
const SHELL='kotoba-shell-'+VERSION;const DATA='kotoba-read-cache-v1';
const NETWORK_TIMEOUT_MS=8000;
self.addEventListener('install',event=>event.waitUntil(caches.open(SHELL).then(cache=>cache.addAll(PRECACHE))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('kotoba-shell-')&&name!==SHELL)await caches.delete(name);await self.clients.claim()})()));
self.addEventListener('message',event=>{if(event.data==='activate-update')self.skipWaiting()});
async function remember(cache,request,response,max){
 if(response.ok){await cache.put(request,response.clone());if(max){const keys=await cache.keys();for(const key of keys.slice(0,Math.max(0,keys.length-max)))await cache.delete(key)}}
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
  try{await remember(cache,key,response,max)}catch(error){if(error.name!=='QuotaExceededError')throw error}
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
