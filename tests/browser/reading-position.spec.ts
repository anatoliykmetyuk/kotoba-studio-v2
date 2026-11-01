import {test,expect,type APIRequestContext,type Page} from './fixtures';

async function importLesson(request:APIRequestContext,name:string){
 const response=await request.post('/api/v1/imports',{data:{title:`Reading position ${name}`,body:'猫は窓のそばで眠っています。私は温かいお茶を飲みました。\n\n'.repeat(45)+`記録 ${name} ${Date.now()}。`}});
 expect(response.ok()).toBe(true);const submitted=await response.json();let id:string=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();if(job.state==='failed')throw new Error(job.error);id=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 return id;
}
async function progress(request:APIRequestContext,id:string){return(await(await request.get('/api/v1/texts/'+id)).json()).readingProgress as number}
async function archive(request:APIRequestContext,id:string){
 await expect.poll(async()=>{
  const text=await(await request.get('/api/v1/texts/'+id)).json();
  const response=await request.patch('/api/v1/texts/'+id,{data:{archived:true,revision:text.revision}});
  expect([200,409]).toContain(response.status());return response.status();
 }).toBe(200);
}
async function ready(page:Page){await expect(page.locator('.book-body')).toBeVisible();await page.waitForTimeout(450)}
async function closeLesson(page:Page){
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
 // WebKit rounds restored scroll coordinates to whole CSS pixels. Bookmark
 // restoration compares the token's viewport position, independent of banners.
 await expect.poll(async()=>Math.abs(await page.locator(`[data-word-end="${position.wordEnd}"]`).evaluate(el=>el.getBoundingClientRect().bottom)-position.bottom)).toBeLessThanOrEqual(1);
}

test('scrolling, restoration and popup locking save the bookmark without completing text',async({page,request},info)=>{
 const id=await importLesson(request,info.project.name);const writes:string[]=[];
 page.on('request',request=>{if(request.method()==='PUT'&&/\/(progress|checkpoint)$/.test(request.url()))writes.push(request.url())});
 try{
  await page.goto('/#'+id);await ready(page);expect(await progress(request,id)).toBe(0);
  await page.evaluate(()=>scrollTo(0,1400));
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(1000);
  const forward=await snapshot(page);
  await expect.poll(()=>page.evaluate(id=>JSON.parse(localStorage.getItem('kotoba:position:'+id)??'null')?.wordEnd,id)).toBe(Number(forward.wordEnd));
  for(let n=0;n<3;n++){
   await closeLesson(page);await reopen(page,id);await expectPosition(page,forward);
  }
  await page.reload();await ready(page);await expectPosition(page,forward);
  expect(await progress(request,id)).toBe(0);expect(writes).toEqual([]);

  await page.evaluate(()=>scrollBy(0,-260));
  await expect.poll(()=>page.evaluate(()=>scrollY)).toBeLessThan(forward.y-200);
  const backward=await snapshot(page);
  await expect.poll(()=>page.evaluate(id=>JSON.parse(localStorage.getItem('kotoba:position:'+id)??'null')?.wordEnd,id)).toBe(Number(backward.wordEnd));
  await closeLesson(page);await reopen(page,id);await expectPosition(page,backward);
  await page.reload();await ready(page);await expectPosition(page,backward);
  for(let n=0;n<2;n++){
   await page.getByRole('button',{name:'Reading options'}).evaluate((button:HTMLButtonElement)=>button.click());
   const dialog=page.getByRole('dialog',{name:'Settings',exact:true});await expect(dialog).toBeVisible();
   await expect(page.locator('html')).toHaveCSS('overflow','hidden');
   await dialog.evaluate(el=>{el.scrollTop=el.scrollHeight});
   await dialog.getByRole('button',{name:'Close',exact:true}).evaluate((button:HTMLButtonElement)=>button.click());
   await expect(dialog).toHaveCount(0);await expectPosition(page,backward);
  }
  expect(await progress(request,id)).toBe(0);expect(writes).toEqual([]);
  await expect(page.getByRole('progressbar',{name:'Reading progress',exact:true})).toHaveAttribute('aria-valuenow','0');
  await page.screenshot({path:info.outputPath('restored-reading-position.png')});

  // Completion on another device changes reading progress, never this device's
  // independent visual bookmark, including a cached-to-fresh query refresh.
  await closeLesson(page);
  const detail=await(await request.get('/api/v1/texts/'+id)).json();
  const remote=detail.sentences.at(-1);
  expect((await request.put('/api/v1/texts/'+id+'/checkpoint',{data:{start:remote.start,end:remote.end,completed:true}})).ok()).toBe(true);
  await page.waitForTimeout(2100);
  await reopen(page,id);await expectPosition(page,backward);
  await expect.poll(()=>progress(request,id)).toBeGreaterThan(0);expect(writes).toEqual([]);
 }finally{await page.close();await archive(request,id)}
});

test('offline scrolling preserves the exact bookmark and never queues completion',async({page,context,request,browserName},info)=>{
 test.skip(browserName==='webkit','WebKit offline emulation rejects service-worker responses: https://github.com/microsoft/playwright/issues/42775');
 const id=await importLesson(request,`offline ${info.project.name}`);
 try{
  await page.goto('/#'+id);await ready(page);
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  await page.reload();await ready(page);expect(await progress(request,id)).toBe(0);
  await context.setOffline(true);
  await page.evaluate(()=>scrollTo(0,1400));await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(1000);
  const position=await snapshot(page);
  await expect.poll(()=>page.evaluate(id=>JSON.parse(localStorage.getItem('kotoba:position:'+id)??'null')?.wordEnd,id)).toBe(Number(position.wordEnd));
  await closeLesson(page);await reopen(page,id);await expectPosition(page,position);
  await page.reload();await ready(page);await expectPosition(page,position);
  await expect(page.getByRole('progressbar',{name:'Reading progress',exact:true})).toHaveAttribute('aria-valuenow','0');
  expect(await page.evaluate(id=>localStorage.getItem('kotoba:cursor:'+id),id)).toBeNull();
  expect(await progress(request,id)).toBe(0);
  await context.setOffline(false);await expect(page.locator('.connection-banner')).toHaveCount(0);
  await page.reload();await ready(page);await expectPosition(page,position);expect(await progress(request,id)).toBe(0);
  await page.screenshot({path:info.outputPath('offline-bookmark-without-progress.png')});
 }finally{await context.setOffline(false);await page.close();await archive(request,id)}
});
