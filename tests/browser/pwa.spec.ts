import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);
const acceptanceOrigin=process.env.KOTOBA_ACCEPTANCE_ORIGIN??'https://localhost:8443';

test.use({baseURL:process.env.KOTOBA_TEST_BASE_URL??acceptanceOrigin});

test('trusted HTTPS installs the PWA and caches read requests',async({page})=>{
 await page.goto('/');
 expect(await page.evaluate(()=>isSecureContext)).toBe(true);
 await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
 await page.reload();
 const result=await page.evaluate(async()=>{
  const manifest=await(await fetch('/manifest.webmanifest')).json();
  const response=await fetch('/api/v1/texts');
  await response.json();
  const cache=await caches.open('kotoba-read-cache-v1');
  const cached=await cache.match('/api/v1/texts');
  return {manifest,cached:!!cached,active:(await navigator.serviceWorker.getRegistration())?.active?.state};
 });
 expect(result.active).toBe('activated');
 expect(result.cached).toBe(true);
 expect(result.manifest.display).toBe('standalone');
 expect(result.manifest.icons.some((icon:{purpose:string})=>icon.purpose==='maskable')).toBe(true);
});

test('real HTTP failures use bounded cached reads without hiding client errors or writes',async({page})=>{
 // This uses a real disposable upstream, not Playwright route interception or
 // WebKit's broken context.setOffline service-worker emulation (issue 42775).
 let mode:'ready'|'unavailable'|'missing'|'unauthorized'|'hanging'|'disconnected'|'partial'='ready';
 const source=await readFile(new URL('../../web/sw.js',import.meta.url),'utf8');
 const shell='<!doctype html><title>PWA fallback fixture</title><main>Cached shell</main>';
 const server=createServer((request,response)=>{
  response.setHeader('Cache-Control','no-store');
  if(request.url==='/sw.js'){
   response.setHeader('Content-Type','text/javascript');
   response.end('const VERSION="fallback-fixture";const PRECACHE=["/","/index.html"];\n'+source);return;
  }
  if(mode==='hanging')return;
  if(mode==='disconnected'){response.destroy();return}
  if(mode==='partial'){
   response.writeHead(200,{'Content-Type':request.url?.startsWith('/api/')?'application/json':'text/html','Content-Length':'1000'});
   response.write(request.url?.startsWith('/api/')?'{"state":':'<!doctype html><main>');
   setTimeout(()=>response.destroy(),25);return;
  }
  response.statusCode=mode==='unavailable'?502:mode==='missing'?404:mode==='unauthorized'?401:200;
  if(request.url?.startsWith('/api/')){
   response.setHeader('Content-Type','application/json');
   response.end(JSON.stringify({state:mode}));
  }else{response.setHeader('Content-Type','text/html');response.end(mode==='ready'?shell:mode)}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture port');
 const origin=`http://127.0.0.1:${address.port}`;
 try{
  await page.goto(origin);
  await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready});
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  expect(await page.evaluate(async()=>(await fetch('/api/v1/texts')).json())).toEqual({state:'ready'});
  for(const failure of ['unavailable','disconnected','partial','hanging'] as const){
   mode=failure;const started=Date.now();
   expect(await page.evaluate(async()=>(await fetch('/api/v1/texts')).json())).toEqual({state:'ready'});
   expect(Date.now()-started).toBeLessThan(12_000);
   const navigationStarted=Date.now();
   const navigation=await page.reload({waitUntil:'domcontentloaded'});
   expect(Date.now()-navigationStarted).toBeLessThan(12_000);
   expect(navigation?.fromServiceWorker()).toBe(true);
   await expect(page.locator('main')).toHaveText('Cached shell');
   server.closeAllConnections();
  }
  mode='hanging';
  expect(await page.evaluate(async()=>{
   const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),50);
   try{await fetch('/api/v1/texts',{signal:controller.signal});return 'unexpected response'}
   catch(error){return (error as Error).name}finally{clearTimeout(timer)}
  })).toBe('AbortError');
  server.closeAllConnections();
  mode='unavailable';
  expect(await page.evaluate(async()=>(await fetch('/api/v1/settings')).status)).toBe(502);
  expect(await page.evaluate(async()=>(await fetch('/api/v1/texts/fixture/progress',{method:'PUT',body:'{}'})).status)).toBe(502);
  for(const clientError of ['missing','unauthorized'] as const){
   mode=clientError;
   expect(await page.evaluate(async()=>{const response=await fetch('/api/v1/texts');return {status:response.status,data:await response.json()}})).toEqual({status:clientError==='missing'?404:401,data:{state:clientError}});
   const navigation=await page.reload({waitUntil:'domcontentloaded'});
   expect(navigation?.status()).toBe(clientError==='missing'?404:401);
   await expect(page.locator('main')).toHaveCount(0);
  }
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
});

test('actual Tailscale upstream outage preserves cached reading and queued progress',async({page,request,baseURL},info)=>{
 test.skip(process.env.KOTOBA_PWA_OUTAGE!=='1','Opt in only when the isolated acceptance web service is available for an outage.');
 test.setTimeout(180_000);
 expect(baseURL,'Outage testing must target the isolated trusted HTTPS origin').toBe(acceptanceOrigin);
 const container='kotoba-v2-acceptance-web-1';
 const labels=JSON.parse((await execute('docker',['inspect','--format','{{json .Config.Labels}}',container])).stdout);
 expect(labels['com.docker.compose.project']).toBe('kotoba-v2-acceptance');
 expect(labels['com.docker.compose.service']).toBe('web');
 const submitted=await request.post('/api/v1/imports',{data:{title:`PWA recovery ${info.project.name}`,body:'猫は窓のそばで眠っています。私は温かいお茶を飲みました。\n'.repeat(32)+`記録 ${info.project.name} ${Date.now()}。`,folder:'Acceptance'}});
 expect(submitted.ok()).toBe(true);const imported=await submitted.json();let textId=imported.textId;
 if(!textId)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+imported.jobId)).json();if(job.state==='failed')throw new Error(job.error);textId=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 try{
 await page.goto('/#'+textId);await expect(page.locator('.book-body')).toBeVisible();
 await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
 await page.reload();await expect(page.locator('.book-body')).toBeVisible();
 const before=await page.evaluate(async id=>(await fetch('/api/v1/texts/'+id)).json(),textId);
 const key='kotoba:cursor:'+textId;let queued=0;
 try{
  await execute('docker',['stop','--time','2',container]);
  expect((await request.get('/api/v1/texts')).status(),'The real HTTPS gateway must report the stopped upstream').toBe(502);
  const navigation=await page.reload();expect(navigation?.fromServiceWorker()).toBe(true);
  await expect(page.locator('.book-body')).toBeVisible();
  expect(await page.evaluate(async id=>(await fetch('/api/v1/texts/'+id)).json(),textId)).toEqual(before);
  expect(await page.evaluate(async id=>(await fetch('/api/v1/texts/'+id+'/progress',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({cursor:1})})).status,textId)).toBe(502);
  await page.waitForTimeout(450);await page.evaluate(()=>scrollTo(0,1400));
  await expect.poll(()=>page.evaluate(key=>Number(localStorage.getItem(key)),key)).toBeGreaterThan(before.cursor);
  queued=await page.evaluate(key=>Number(localStorage.getItem(key)),key);
  await expect(page.locator('.book-progress')).toContainText('Waiting to sync');
  await page.reload();await expect(page.locator('.book-body')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(500);
  expect(await page.evaluate(key=>Number(localStorage.getItem(key)),key)).toBeGreaterThanOrEqual(queued);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath('cached-reading-during-upstream-outage.png')});
 }finally{
  await execute('docker',['start',container]);
  await expect.poll(async()=>{try{return(await request.get('/api/v1/texts')).status()}catch{return 0}},{timeout:30_000}).toBe(200);
 }
 expect(queued).toBeGreaterThan(0);
 await expect.poll(async()=>(await(await request.get('/api/v1/texts/'+textId)).json()).cursor,{timeout:20_000}).toBeGreaterThanOrEqual(queued);
 await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key),key)).toBeNull();
 await page.reload();await expect(page.locator('.book-body')).toBeVisible();
 expect(await page.evaluate(async id=>(await(await fetch('/api/v1/texts/'+id)).json()).cursor,textId)).toBeGreaterThanOrEqual(queued);
 }finally{
  await page.close();
  // The pagehide progress flush can advance the revision during cleanup.
  await expect.poll(async()=>{
   const fixture=await(await request.get('/api/v1/texts/'+textId)).json();
   const response=await request.patch('/api/v1/texts/'+textId,{data:{archived:true,revision:fixture.revision}});
   expect([200,409]).toContain(response.status());return response.status();
  }).toBe(200);
 }
});

test('offline reload serves the shell and previously fetched text',async({page,context,browserName})=>{
 test.skip(browserName==='webkit','WebKit offline emulation rejects service-worker responses: https://github.com/microsoft/playwright/issues/42775');
 await page.goto('/');
 await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
 await page.reload();
 const before=await page.evaluate(async()=>{
  const texts=await(await fetch('/api/v1/texts')).json();
  const url=texts[0]?'/api/v1/texts/'+texts[0].id:'/api/v1/texts';
  return {url,data:await(await fetch(url)).json()};
 });
 try{
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.connection-banner')).toContainText('Offline');
  const after=await page.evaluate(async url=>(await fetch(url)).json(),before.url);
  expect(after).toEqual(before.data);
 }finally{
  await context.setOffline(false);
 }
});
