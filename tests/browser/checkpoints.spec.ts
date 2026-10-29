import {test,expect,type APIRequestContext,type Page} from './fixtures';
import {randomUUID} from 'node:crypto';
import {penTap} from './input';

type Word={id:string;baseId:string;state:string;start:number;end:number};
type Sentence={id:string;start:number;end:number;body:string;tokens:Word[];completed:boolean};
type Lesson={id:string;body:string;revision:number;readingProgress:number;textState:string;sentences:Sentence[]};
type Section={start:number;end:number;sentences:Sentence[];words:number};

function sections(sentences:Sentence[],limit:number){
 const result:Section[]=[];let group:Sentence[]=[],words=0;
 for(const sentence of sentences){
  group.push(sentence);words+=sentence.tokens.length;
  if(words>=limit){result.push({start:group[0].start,end:sentence.end,sentences:group,words});group=[];words=0}
 }
 if(group.length)result.push({start:group[0].start,end:group.at(-1)!.end,sentences:group,words});
 return result;
}
async function detail(request:APIRequestContext,id:string):Promise<Lesson>{const response=await request.get('/api/v1/texts/'+id);expect(response.ok()).toBe(true);return response.json()}
async function fixture(request:APIRequestContext,name:string){
 const sentences=[
  '猫は窓のそばで眠り、犬は庭を元気に走り、鳥は青い空をゆっくり飛び、魚は静かな池で泳いでいます。',
  ...Array(4).fill('猫は窓のそばで眠っています。'),
  ...Array(4).fill('犬は庭を元気に走っています。'),
  ...Array(4).fill('鳥は青い空をゆっくり飛びます。'),
  ...Array(4).fill('魚は静かな池で泳いでいます。')];
 const body=`Fixture ${randomUUID()} `+sentences.join('\n\n');
 const response=await request.post('/api/v1/imports',{data:{title:'Reading checkpoints '+name,body}});
 expect(response.ok()).toBe(true);const submitted=await response.json();let id:string=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();expect(job.state,job.error).not.toBe('failed');id=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 return detail(request,id);
}
async function archive(request:APIRequestContext,id:string){
 await expect.poll(async()=>{const text=await detail(request,id);const response=await request.patch('/api/v1/texts/'+id,{data:{archived:true,revision:text.revision}});expect([200,409]).toContain(response.status());return response.status()}).toBe(200);
}
async function setting(request:APIRequestContext,checkpointWords:number){expect((await request.patch('/api/v1/settings',{data:{checkpointWords}})).ok()).toBe(true)}
async function open(page:Page,id:string){await page.goto('/#'+id);await expect(page.locator('.book-body')).toBeVisible()}
function checkbox(page:Page,index:number){return page.getByRole('checkbox',{name:'Complete section '+(index+1),exact:true})}
async function expectProgress(page:Page,value:number){await expect(page.getByRole('progressbar',{name:'Reading progress',exact:true})).toHaveAttribute('aria-valuenow',String(Math.round(value*100)))}
function tokenStates(text:Lesson){return new Map(text.sentences.flatMap(s=>s.tokens.map(w=>[w.baseId,w.state] as const)))}
async function safeArea(page:Page,browserName:string){
 const cdp=browserName==='chromium'?await page.context().newCDPSession(page):null;
 const portrait=page.viewportSize()!.height>page.viewportSize()!.width;
 const insets={top:portrait?47:0,left:portrait?0:47,right:portrait?0:47,bottom:portrait?34:21};
 if(cdp)await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets});
 else await page.evaluate(values=>{for(const [key,value] of Object.entries(values))document.documentElement.style.setProperty('--safe-'+key,value+'px')},insets);
 return {insets,close:()=>cdp?.detach()};
}

test('sentence-end checkpoints complete only their section, support undo and preserve word statuses',async({page,request,browserName},info)=>{
 const previous=await(await request.get('/api/v1/settings')).json();const text=await fixture(request,info.project.name);const errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await setting(request,10);
  for(const base of tokenStates(text).keys())expect((await request.put('/api/v1/words/'+base+'/status',{data:{state:'new'}})).ok()).toBe(true);
  const expected=sections(text.sentences,10);expect(expected.length).toBeGreaterThan(3);
  // The first sentence deliberately exceeds the threshold. It must have one
  // checkpoint at its end, with the next section starting a fresh token count.
  expect(text.sentences[0].tokens.length).toBeGreaterThan(10);expect(expected[0].sentences).toHaveLength(1);
  const selected=expected[1],families=[...new Set(selected.sentences.flatMap(s=>s.tokens.map(w=>w.baseId)))];
  expect(families.length).toBeGreaterThan(3);
  for(const [base,state] of families.slice(0,3).map((base,index)=>[base,['learning','familiar','known'][index]]))expect((await request.put('/api/v1/words/'+base+'/status',{data:{state}})).ok()).toBe(true);
  const before=await detail(request,text.id),beforeStates=tokenStates(before);
  await open(page,text.id);const safe=await safeArea(page,browserName);
  try{
   await expect(page.locator('.book-body').getByRole('checkbox')).toHaveCount(expected.length);
   for(const [index,section] of expected.entries()){
    await expect(checkbox(page,index)).toHaveAttribute('data-checkpoint-start',String(section.start));
    await expect(checkbox(page,index)).toHaveAttribute('data-checkpoint-end',String(section.end));
    await expect(checkbox(page,index)).toHaveAttribute('aria-checked','false');
   }
   expect(expected.at(-1)!.end).toBe(text.sentences.at(-1)!.end);
   await expectProgress(page,0);
   // Reading the end and returning does not complete any section.
   await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await page.evaluate(()=>scrollTo(0,0));
   await expectProgress(page,0);expect((await detail(request,text.id)).readingProgress).toBe(0);

   await page.evaluate(()=>{
    const events:string[]=[];(window as unknown as {checkpointAnimations:string[]}).checkpointAnimations=events;
    for(const type of ['animationstart','transitionrun'])document.querySelector('.reader')!.addEventListener(type,event=>{
     const target=event.target as Element;
     if(target.closest('[role=checkbox]'))events.push('checkbox');
     if(target.closest('[role=progressbar]'))events.push('progressbar');
    },true);
   });
   await checkbox(page,1).tap();await expect(checkbox(page,1)).toHaveAttribute('aria-checked','true');
   await expect(checkbox(page,0)).toHaveAttribute('aria-checked','false');await expect(checkbox(page,2)).toHaveAttribute('aria-checked','false');
   const total=text.sentences.reduce((sum,s)=>sum+s.tokens.length,0),fraction=selected.words/total;
   await expectProgress(page,fraction);
   await expect.poll(()=>page.evaluate(()=>(window as unknown as {checkpointAnimations:string[]}).checkpointAnimations)).toEqual(expect.arrayContaining(['checkbox','progressbar']));
   await expect.poll(async()=>{const saved=await detail(request,text.id);return saved.sentences.filter(s=>s.completed).map(s=>s.id)}).toEqual(selected.sentences.map(s=>s.id));
   const checked=await detail(request,text.id);expect(checked.readingProgress).toBeCloseTo(fraction,8);expect(checked.textState).toBe('new');
   const selectedFamilies=new Set(families);
   for(const [base,state] of tokenStates(checked))expect(state).toBe(beforeStates.get(base)==='new'&&selectedFamilies.has(base)?'known':beforeStates.get(base));
   const buttonBox=(await checkbox(page,1).boundingBox())!;expect(buttonBox.height).toBeGreaterThanOrEqual(44);expect(buttonBox.width).toBeGreaterThanOrEqual(44);
   const toolbar=page.locator('.reader-toolbar');const toolbarBox=(await toolbar.boundingBox())!;
   expect(toolbarBox.y).toBeGreaterThanOrEqual(safe.insets.top-1);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.screenshot({path:info.outputPath('independent-completed-section.png')});

   // Native keyboard and Pencil paths must each toggle exactly once.
   await checkbox(page,1).focus();await checkbox(page,1).press('Space');await expect(checkbox(page,1)).toHaveAttribute('aria-checked','false');
   await expectProgress(page,0);await expect.poll(async()=>(await detail(request,text.id)).readingProgress).toBe(0);
   expect(tokenStates(await detail(request,text.id))).toEqual(tokenStates(checked));
   await penTap(page,checkbox(page,1),browserName);await expect(checkbox(page,1)).toHaveAttribute('aria-checked','true');await expectProgress(page,fraction);
   await checkbox(page,0).click();await expect(checkbox(page,0)).toHaveAttribute('aria-checked','true');
   for(let index=2;index<expected.length;index++){await checkbox(page,index).tap();await expect(checkbox(page,index)).toHaveAttribute('aria-checked','true')}
   await expectProgress(page,1);await expect.poll(async()=>(await detail(request,text.id)).textState).toBe('completed');
   await page.reload();await expect(page.locator('.book-body')).toBeVisible();
   for(let index=0;index<expected.length;index++)await expect(checkbox(page,index)).toHaveAttribute('aria-checked','true');
   await expectProgress(page,1);
   // Reopening through a checkpoint preserves every Known status.
   const completeStates=tokenStates(await detail(request,text.id));await checkbox(page,0).tap();
   await expect.poll(async()=>(await detail(request,text.id)).textState).toBe('new');
   expect(tokenStates(await detail(request,text.id))).toEqual(completeStates);
   expect(errors).toEqual([]);
  }finally{await safe.close()}
 }finally{await page.close();await setting(request,previous.checkpointWords);await archive(request,text.id)}
});

test('section size persists, regrouping keeps sentence completion and reduced motion stays still',async({page,request},info)=>{
 const previous=await(await request.get('/api/v1/settings')).json();const text=await fixture(request,'settings '+info.project.name);
 try{
  await setting(request,10);await open(page,text.id);
  const original=sections(text.sentences,10);await checkbox(page,1).tap();await expect(checkbox(page,1)).toHaveAttribute('aria-checked','true');
  const completed=original[1].sentences.map(s=>s.id);await expect.poll(async()=>(await detail(request,text.id)).sentences.filter(s=>s.completed).map(s=>s.id)).toEqual(completed);
  const savedProgress=(await detail(request,text.id)).readingProgress;
  await page.getByRole('button',{name:'Reading options',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
  const slider=dialog.getByRole('slider',{name:'Words per section',exact:true});await expect(slider).toHaveValue('10');
  await slider.focus();await slider.press('End');await expect(slider).toHaveValue('500');
  await expect.poll(async()=>(await(await request.get('/api/v1/settings')).json()).checkpointWords).toBe(500);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(page.locator('.book-body').getByRole('checkbox')).toHaveCount(sections(text.sentences,500).length);
  await expect(checkbox(page,0)).toHaveAttribute('aria-checked','false');
  expect((await detail(request,text.id)).sentences.filter(s=>s.completed).map(s=>s.id)).toEqual(completed);
  await expectProgress(page,savedProgress);
  await page.reload();await expect(page.locator('.book-body')).toBeVisible();
  await page.getByRole('button',{name:'Reading options',exact:true}).click();await expect(slider).toHaveValue('500');
  await slider.focus();await slider.press('Home');await expect(slider).toHaveValue('10');
  await expect.poll(async()=>(await(await request.get('/api/v1/settings')).json()).checkpointWords).toBe(10);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(checkbox(page,1)).toHaveAttribute('aria-checked','true');
  await page.emulateMedia({reducedMotion:'reduce'});await checkbox(page,0).tap();await expect(checkbox(page,0)).toHaveAttribute('aria-checked','true');
  const motion=await page.locator('.reader').evaluate(reader=>Array.from(reader.querySelectorAll('*')).flatMap(el=>el.getAnimations()).filter(animation=>animation.playState==='running').length);
  expect(motion).toBe(0);
  await page.screenshot({path:info.outputPath('regrouped-checkpoints.png')});
 }finally{await page.close();await setting(request,previous.checkpointWords);await archive(request,text.id)}
});

test('offline checkpoint completion and undo survive reload and recover without scroll credit',async({page,context,request,browserName},info)=>{
 test.skip(browserName==='webkit','WebKit offline emulation rejects service-worker responses: https://github.com/microsoft/playwright/issues/42775');
 const previous=await(await request.get('/api/v1/settings')).json();const text=await fixture(request,'offline '+info.project.name);
 try{
  await setting(request,10);
  for(const base of tokenStates(text).keys())expect((await request.put('/api/v1/words/'+base+'/status',{data:{state:'new'}})).ok()).toBe(true);
  const allSections=sections(text.sentences,10),retainedIndex=allSections.length-1;
  await open(page,text.id);await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  await page.reload();await expect(page.locator('.book-body')).toBeVisible();
  await context.setOffline(true);
  await checkbox(page,1).tap();await expect(checkbox(page,1)).toHaveAttribute('aria-checked','true');await expect(checkbox(page,0)).toHaveAttribute('aria-checked','false');
  const selected=sections(text.sentences,10)[1],fraction=selected.words/text.sentences.reduce((sum,s)=>sum+s.tokens.length,0);
  await expectProgress(page,fraction);expect((await detail(request,text.id)).readingProgress).toBe(0);
  await page.reload();await expect(page.locator('.book-body')).toBeVisible();await expect(checkbox(page,1)).toHaveAttribute('aria-checked','true');await expectProgress(page,fraction);
  await checkbox(page,1).tap();await expect(checkbox(page,1)).toHaveAttribute('aria-checked','false');await expectProgress(page,0);
  await checkbox(page,retainedIndex).tap();await expect(checkbox(page,retainedIndex)).toHaveAttribute('aria-checked','true');
  const retained=allSections[retainedIndex],expected=retained.words/text.sentences.reduce((sum,s)=>sum+s.tokens.length,0);
  const promoted=new Set(selected.sentences.flatMap(s=>s.tokens.map(w=>w.baseId))),retainedFamilies=new Set(retained.sentences.flatMap(s=>s.tokens.map(w=>w.baseId)));
  expect([...promoted].some(base=>!retainedFamilies.has(base))).toBe(true);
  await page.reload();await expect(page.locator('.book-body')).toBeVisible();await expect(checkbox(page,1)).toHaveAttribute('aria-checked','false');await expect(checkbox(page,retainedIndex)).toHaveAttribute('aria-checked','true');await expectProgress(page,expected);
  await context.setOffline(false);await expect.poll(async()=>(await detail(request,text.id)).readingProgress,{timeout:20_000}).toBeCloseTo(expected,8);
  await expect.poll(async()=>(await detail(request,text.id)).sentences.filter(s=>s.completed).map(s=>s.id)).toEqual(retained.sentences.map(s=>s.id));
  const recoveredStates=tokenStates(await detail(request,text.id));
  for(const base of promoted)expect(recoveredStates.get(base)).toBe('known');
  await page.reload();await expect(page.locator('.book-body')).toBeVisible();await expect(checkbox(page,1)).toHaveAttribute('aria-checked','false');await expect(checkbox(page,retainedIndex)).toHaveAttribute('aria-checked','true');
  await page.screenshot({path:info.outputPath('recovered-offline-checkpoints.png')});
 }finally{await context.setOffline(false);await page.close();await setting(request,previous.checkpointWords);await archive(request,text.id)}
});

test('closed lesson checkpoint sync remains available after Library reloads offline',async({page,context,request,browserName},info)=>{
 test.skip(browserName==='webkit','WebKit offline emulation rejects service-worker responses: https://github.com/microsoft/playwright/issues/42775');
 const previous=await(await request.get('/api/v1/settings')).json();const text=await fixture(request,'closed lesson '+info.project.name);
 try{
  await setting(request,10);await open(page,text.id);await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  await page.reload();await expect(page.locator('.book-body')).toBeVisible();
  const selected=sections(text.sentences,10)[1],fraction=selected.words/text.sentences.reduce((sum,s)=>sum+s.tokens.length,0);
  await context.setOffline(true);await checkbox(page,1).tap();await expect(checkbox(page,1)).toHaveAttribute('aria-checked','true');await expectProgress(page,fraction);
  await page.locator('.reader .back-button').evaluate((button:HTMLButtonElement)=>button.click());await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
  expect((await detail(request,text.id)).readingProgress).toBe(0);
  // Observe the active Library refresh after acknowledgement. The lesson query
  // is inactive throughout recovery, so it cannot refresh its own cached data.
  const refreshed=page.waitForResponse(async response=>{
   if(response.request().method()!=='GET'||new URL(response.url()).pathname!=='/api/v1/texts'||!response.ok())return false;
   const items=await response.json();return items.some((item:Lesson)=>item.id===text.id&&Math.abs(item.readingProgress-fraction)<1e-8);
  });
  await context.setOffline(false);await expect.poll(async()=>(await detail(request,text.id)).readingProgress,{timeout:20_000}).toBeCloseTo(fraction,8);await refreshed;
  await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
  await context.setOffline(true);await page.reload();await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
  const card=page.locator('.text-card').filter({has:page.getByRole('heading',{name:'Reading checkpoints closed lesson '+info.project.name,exact:true})});
  await expect(card).toBeVisible();await card.click();await expect(page.locator('.book-body')).toBeVisible();
  await expect(checkbox(page,1)).toHaveAttribute('aria-checked','true');await expect(checkbox(page,0)).toHaveAttribute('aria-checked','false');await expectProgress(page,fraction);
  await expect(page.locator('.book-progress')).toContainText('Checkpoints saved');
  await page.screenshot({path:info.outputPath('closed-lesson-sync-offline-reopen.png')});
 }finally{await context.setOffline(false);await page.close();await setting(request,previous.checkpointWords);await archive(request,text.id)}
});
