import {test,expect,type APIRequestContext,type Page} from './fixtures';

async function importLesson(request:APIRequestContext,name:string){
 const response=await request.post('/api/v1/imports',{data:{title:`Reading position ${name}`,body:'猫は窓のそばで眠っています。私は温かいお茶を飲みました。\n\n'.repeat(45)+`記録 ${name} ${Date.now()}。`,folder:'Acceptance'}});
 expect(response.ok()).toBe(true);const submitted=await response.json();let id:string=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();if(job.state==='failed')throw new Error(job.error);id=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 return id;
}
async function cursor(request:APIRequestContext,id:string){return(await(await request.get('/api/v1/texts/'+id)).json()).cursor as number}
async function archive(request:APIRequestContext,id:string){
 await expect.poll(async()=>{
  const text=await(await request.get('/api/v1/texts/'+id)).json();
  const response=await request.patch('/api/v1/texts/'+id,{data:{archived:true,revision:text.revision}});
  expect([200,409]).toContain(response.status());return response.status();
 }).toBe(200);
}
async function ready(page:Page){await expect(page.locator('.book-body')).toBeVisible();await page.waitForTimeout(450)}
async function closeLesson(page:Page){
 // Clicking an offscreen toolbar through Playwright would itself scroll the
 // lesson to the top. Invoke its existing handler without changing position.
 await page.locator('.reader .back-button').evaluate((button:HTMLButtonElement)=>button.click());
 await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
}
async function reopen(page:Page,id:string){await page.evaluate(id=>{location.hash=id},id);await ready(page)}
async function snapshot(page:Page){
 return page.evaluate(()=>{
  const words=Array.from(document.querySelectorAll<HTMLElement>('.reader [data-word-end]'));
  const anchor=words.reduce((best,word)=>Math.abs(word.getBoundingClientRect().bottom-innerHeight*.8)<Math.abs(best.getBoundingClientRect().bottom-innerHeight*.8)?word:best);
  return {wordEnd:anchor.dataset.wordEnd!,bottom:anchor.getBoundingClientRect().bottom,y:scrollY};
 });
}
async function expectPosition(page:Page,position:Awaited<ReturnType<typeof snapshot>>){
 // WebKit rounds scroll coordinates to whole CSS pixels on restoration.
 await expect.poll(async()=>Math.abs(await page.locator(`[data-word-end="${position.wordEnd}"]`).evaluate(el=>el.getBoundingClientRect().bottom)-position.bottom)).toBeLessThanOrEqual(1);
 // The token's viewport position is the bookmark. Absolute scrollY can differ
 // when an offline banner is added or removed above the reader.
}

test('restoration, repeated open/close and popup locking never advance unread progress',async({page,request},info)=>{
 const id=await importLesson(request,info.project.name);const writes:number[]=[];
 page.on('request',request=>{if(request.method()==='PUT'&&request.url().endsWith('/texts/'+id+'/progress'))writes.push(request.postDataJSON().cursor)});
 try{
  const text=await(await request.get('/api/v1/texts/'+id)).json();
  const sentence=text.sentences[24];const saved=sentence.start+sentence.tokens.at(-1).end;
  expect((await request.put('/api/v1/texts/'+id+'/progress',{data:{cursor:saved}})).ok()).toBe(true);
  await page.goto('/#'+id);await ready(page);
  // With no device bookmark, restore the same word at the same reading line
  // used to save progress, rather than putting the next word near the top.
  await expect.poll(()=>page.locator(`[data-word-end="${saved}"]`).evaluate(el=>el.getBoundingClientRect().bottom/innerHeight)).toBeCloseTo(.8,2);
  const fallback=await snapshot(page);
  for(let n=0;n<3;n++){
   await closeLesson(page);await page.waitForTimeout(150);expect(await cursor(request,id)).toBe(saved);
   await reopen(page,id);await expectPosition(page,fallback);
  }
  await page.reload();await ready(page);await expectPosition(page,fallback);
  expect(await cursor(request,id)).toBe(saved);expect(writes).toEqual([]);

  await page.evaluate(()=>scrollBy(0,470));
  await expect.poll(()=>cursor(request,id)).toBeGreaterThan(saved);
  const furthest=await cursor(request,id);const forward=await snapshot(page);
  await closeLesson(page);await reopen(page,id);await expectPosition(page,forward);
  await page.reload();await ready(page);await expectPosition(page,forward);
  expect(await cursor(request,id)).toBe(furthest);

  // A return to an earlier paragraph keeps that visual location without
  // reducing or re-crediting the furthest progress stored on the server.
  await page.evaluate(()=>scrollBy(0,-260));
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeLessThan(forward.y-200);
  const backward=await snapshot(page);await page.waitForTimeout(100);
  await closeLesson(page);await reopen(page,id);await expectPosition(page,backward);
  await page.reload();await ready(page);await expectPosition(page,backward);
  const writesBeforePopup=writes.length;
  for(let n=0;n<2;n++){
   await page.getByRole('button',{name:'Reading options'}).evaluate((button:HTMLButtonElement)=>button.click());
   const dialog=page.getByRole('dialog',{name:'Settings',exact:true});await expect(dialog).toBeVisible();
   await expect(page.locator('body')).toHaveCSS('position','fixed');
   await dialog.evaluate(el=>{el.scrollTop=el.scrollHeight});await page.waitForTimeout(100);
   await dialog.getByRole('button',{name:'Close',exact:true}).evaluate((button:HTMLButtonElement)=>button.click());
   await expect(dialog).toHaveCount(0);await expectPosition(page,backward);
  }
  await page.waitForTimeout(1200);
  expect(writes.length).toBe(writesBeforePopup);expect(await cursor(request,id)).toBe(furthest);
  await page.screenshot({path:info.outputPath('restored-reading-position.png')});
  await closeLesson(page);
  // Reopening uses TanStack's cached older text immediately, then receives the
  // newer server cursor. That refresh must replace the stale local bookmark.
  const laterSentence=text.sentences[64],remote=laterSentence.start+laterSentence.tokens.at(-1).end;
  expect(remote).toBeGreaterThan(furthest);
  expect((await request.put('/api/v1/texts/'+id+'/progress',{data:{cursor:remote}})).ok()).toBe(true);
  const writesBeforeRemote=writes.length;
  await page.waitForTimeout(2100); // Let the cached text pass its two-second stale time.
  await reopen(page,id);
  await expect.poll(()=>page.locator(`[data-word-end="${remote}"]`).evaluate(el=>el.getBoundingClientRect().bottom/innerHeight)).toBeCloseTo(.8,2);
  await closeLesson(page);await reopen(page,id);
  expect(await cursor(request,id)).toBe(remote);expect(writes.length).toBe(writesBeforeRemote);
 }finally{await page.close();await archive(request,id)}
});

test('offline scroll queues only actual progress and preserves the exact position across reload',async({page,context,request,browserName},info)=>{
 test.skip(browserName==='webkit','WebKit offline emulation rejects service-worker responses: https://github.com/microsoft/playwright/issues/42775');
 const id=await importLesson(request,`offline ${info.project.name}`),key='kotoba:cursor:'+id;
 try{
  await page.goto('/#'+id);await ready(page);
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  await page.reload();await ready(page);
  expect(await cursor(request,id)).toBe(0);
  await context.setOffline(true);
  await page.evaluate(()=>scrollTo(0,1400));
  await expect.poll(()=>page.evaluate(key=>Number(localStorage.getItem(key)),key)).toBeGreaterThan(0);
  const queued=await page.evaluate(key=>Number(localStorage.getItem(key)),key),position=await snapshot(page);
  await expect(page.locator('.book-progress')).toContainText('Waiting to sync');
  await closeLesson(page);await reopen(page,id);await expectPosition(page,position);
  await page.reload();await ready(page);await expectPosition(page,position);
  expect(await page.evaluate(key=>Number(localStorage.getItem(key)),key)).toBe(queued);
  expect(await cursor(request,id)).toBe(0);
  await context.setOffline(false);
  await expect.poll(()=>cursor(request,id),{timeout:20_000}).toBe(queued);
  await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key),key)).toBeNull();
  await page.reload();await ready(page);await expectPosition(page,position);
  expect(await cursor(request,id)).toBe(queued);

  // With browser anchoring disabled, removing a banner shifts the reader up
  // without moving scrollY. A subsequent backward scroll must not be credited
  // as forward reading. A tall banner makes crossing another text line certain.
  await page.addStyleTag({content:'*{overflow-anchor:none!important}.connection-banner{min-height:240px}'});
  await context.setOffline(true);await expect(page.locator('.connection-banner')).toContainText('Offline');
  await page.evaluate(()=>scrollBy(0,600));
  await expect.poll(()=>page.evaluate(key=>Number(localStorage.getItem(key)),key)).toBeGreaterThan(queued);
  const secondQueued=await page.evaluate(key=>Number(localStorage.getItem(key)),key),offlineY=await page.evaluate(()=>scrollY);
  await context.setOffline(false);await expect(page.locator('.connection-banner')).toHaveCount(0);
  expect(await page.evaluate(()=>scrollY)).toBeCloseTo(offlineY,0);
  await expect.poll(()=>cursor(request,id),{timeout:20_000}).toBe(secondQueued);
  await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key),key)).toBeNull();
  await page.evaluate(()=>scrollBy(0,-10));
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeLessThan(offlineY);
  await page.waitForTimeout(1300);
  expect(await cursor(request,id)).toBe(secondQueued);
  expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBeNull();
 }finally{await context.setOffline(false);await page.close();await archive(request,id)}
});
