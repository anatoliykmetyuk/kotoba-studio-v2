import {test,expect,type Page,type Locator} from './fixtures';

import {muteTestOutput} from './audio-output';

test.beforeEach(async({page})=>muteTestOutput(page));

import {penTap} from './input';

test('popup close accepts pen after touch scrolling and outside dismissal uses mouse or touch',async({page,request,context,browserName,isMobile},info)=>{
 if(browserName==='chromium')await context.grantPermissions(['clipboard-write']);
 await page.addInitScript(()=>{
  (window as any).penPlaybackCount=0;
  document.addEventListener('play',event=>{if(event.target instanceof HTMLMediaElement){event.target.muted=true;(window as any).penPlaybackCount++}},true);
 });
 const response=await request.post('/api/v1/imports',{data:{title:'Popup input acceptance',body:'猫は窓のそばで眠っています。私は温かいお茶を飲みました。\n\n'.repeat(35),folder:'Acceptance'}});
 expect(response.ok()).toBe(true);const imported=await response.json();let id=imported.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+imported.jobId)).json();if(job.state==='failed')throw new Error(job.error);id=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 await page.goto('/#'+id);const token=page.locator('.token').first();await expect(token).toBeVisible();
 const panel=page.getByRole('dialog',{name:'Word details',exact:true});
 await token.click();await expect(panel).toBeVisible();
 // A short touch pull prevents a synthetic click but does not dismiss. The
 // subsequent independent Pencil or mouse tap must not inherit that suppression.
 await panel.evaluate(el=>{
  const r=el.getBoundingClientRect(),target=el.querySelector('.word-panel-head')!;
  for(const [type,dy] of [['touchstart',0],['touchmove',25],['touchend',25]] as const){
   const point={identifier:1,clientX:r.left+20,clientY:r.top+60+dy};
   const event=new Event(type,{bubbles:true,cancelable:true});Object.assign(event,{touches:type==='touchend'?[]:[point],changedTouches:[point]});target.dispatchEvent(event);
  }
 });
 await expect(panel).toBeVisible();
 await penTap(page,panel.getByRole('button',{name:'Close word details',exact:true}),browserName);
 await expect(panel).toHaveCount(0);
 await token.click();await expect(panel).toBeVisible();
 await expect(panel.getByRole('button',{name:'Pronounce word',exact:true})).toBeEnabled();
 await expect.poll(()=>page.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.ended)).toBe(true);
 const playbackCount=await page.evaluate(()=>(window as any).penPlaybackCount);
 await penTap(page,panel.getByRole('button',{name:'Pronounce word',exact:true}),browserName);
 await expect.poll(()=>page.evaluate(()=>(window as any).penPlaybackCount)).toBe(playbackCount+1);
 if(browserName==='chromium'){
  // These clipboard writes use real pen input and real browser permissions.
  for(const label of ['Copy word','Copy sentence']){
   const copy=panel.getByRole('button',{name:label,exact:true});await copy.scrollIntoViewIfNeeded();
   await penTap(page,copy,browserName);await expect(copy).toHaveAttribute('title','Copied');
  }
 }else{
  // DOM pen events cannot grant WebKit clipboard permission; verify button
  // activation separately from the trusted clipboard checks in the next test.
  const more=panel.getByRole('button',{name:/Show all meanings/});await penTap(page,more,browserName);await expect(more).toHaveCount(0);
 }
 const backdrop=page.getByRole('button',{name:'Dismiss popup',exact:true});
 await expect(backdrop).toBeVisible();
 const panelBox=(await panel.boundingBox())!;
 const point=panelBox.x>10?{x:panelBox.x/2,y:Math.max(panelBox.y+80,100)}:{x:10,y:panelBox.y/2};
 // Both press and release must be outside; dragging out of content must not close.
 await page.mouse.move(panelBox.x+20,panelBox.y+60);await page.mouse.down();await page.mouse.move(point.x,point.y,{steps:5});await page.mouse.up();
 await expect(panel).toBeVisible();
 await page.screenshot({path:info.outputPath('popup-dismissal.png')});
 if(isMobile)await page.touchscreen.tap(point.x,point.y);else await page.mouse.click(point.x,point.y);
 await expect(panel).toHaveCount(0);await expect(page.locator('body')).not.toHaveCSS('position','fixed');
 // Clicking the backdrop must not also select a lesson word behind it.
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await token.click();await expect(panel).toBeVisible();
 await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+20,point.y+30,{steps:5});await page.mouse.move(point.x,point.y,{steps:5});await page.mouse.up();
 await expect(panel).toBeVisible();
 await penTap(page,backdrop,browserName,point);await expect(panel).toHaveCount(0);
 // Check the entire gutter, including immediately beside the visible edge,
 // rather than only the middle of the text area.
 const viewport=page.viewportSize()!;
 const points=panelBox.x>10?[1,30,100].flatMap(gap=>[5,viewport.height/2,viewport.height-5].map(y=>({x:panelBox.x-gap,y}))):[2,viewport.width/2,viewport.width-2].map(x=>({x,y:Math.max(1,panelBox.y-2)}));
 for(const outside of points){
  await token.click();await expect(panel).toBeVisible();
  expect(await backdrop.evaluate((el,p)=>document.elementFromPoint(p.x,p.y)===el,outside)).toBe(true);
  if(isMobile)await page.touchscreen.tap(outside.x,outside.y);else await page.mouse.click(outside.x,outside.y);
  await expect(panel).toHaveCount(0);
  await token.click();await expect(panel).toBeVisible();await penTap(page,backdrop,browserName,outside);await expect(panel).toHaveCount(0);
  // A compatibility click arriving after dismissal must not activate the page.
  await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,clientX:p.x,clientY:p.y})),outside);
  await expect(page.getByRole('dialog')).toHaveCount(0);
 }
});

async function geometry(page:Page){
 return page.evaluate(()=>['.reader','.book-body','.token'].flatMap(selector=>Array.from(document.querySelectorAll(selector)).slice(0,160).map(el=>{
  const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];
 })));
}
async function mouseDoesNotDismiss(page:Page,panel:ReturnType<Page['locator']>){
 const box=(await panel.boundingBox())!;
 await page.mouse.move(box.x+18,box.y+70);await page.mouse.down();
 await page.mouse.move(box.x+18,box.y+210,{steps:10});await page.mouse.up();
 await expect(panel).toBeVisible();
 await expect(panel.locator('.sheet-drag-area,.popup-drag-area')).toBeHidden();
}

async function unchanged(page:Page,before:number[][]){
 const after=await geometry(page);expect(after.length).toBe(before.length);
 for(let i=0;i<before.length;i++)for(let n=0;n<4;n++)expect(after[i][n],`rectangle ${i}, coordinate ${n}`).toBeCloseTo(before[i][n],0);
}

test('word and phrase overlays preserve reader geometry, support copying and keep progress',async({page,request,context,browserName},info)=>{
 test.setTimeout(240_000);
 // Headless Chromium denies clipboard writes without an explicit browser grant.
 // WebKit permits writes in the trusted click gesture. Neither API is replaced.
 if(browserName==='chromium')await context.grantPermissions(['clipboard-write']);
 const response=await request.post('/api/v1/imports',{data:{title:'Word overlay acceptance',body:'猫は窓のそばで眠っています。私は温かいお茶を飲みました。\n\n'.repeat(35),folder:'Acceptance'}});
 expect(response.ok()).toBe(true);const imported=await response.json();let id=imported.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+imported.jobId)).json();if(job.state==='failed')throw new Error(job.error);id=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 const desktop=info.project.name.startsWith('desktop');
 const widths=desktop?[1024,1440,1920]:[page.viewportSize()!.width];
 for(const width of widths){
  if(desktop)await page.setViewportSize({width,height:900});
  await page.goto('about:blank');
  const settings=page.waitForResponse(r=>r.url().endsWith('/api/v1/settings')&&r.request().method()==='GET');
  await page.goto('/#'+id);await settings;await expect(page.locator('.book-body')).toBeVisible();
  await expect(page.getByRole('button',{name:'Select phrase',exact:true})).toHaveCount(0);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await page.evaluate(()=>scrollTo(0,650));await page.waitForTimeout(1200);
  // Wait for the deliberate setup scroll to be acknowledged before measuring
  // popup behavior. Graph validation may take longer than the debounce timer.
  await expect.poll(()=>page.evaluate(id=>localStorage.getItem('kotoba:cursor:'+id),id)).toBeNull();
  const cursor=(await(await request.get('/api/v1/texts/'+id)).json()).cursor;
  const tokenId=await page.locator('.token').evaluateAll(tokens=>(tokens.find(el=>{const r=el.getBoundingClientRect();return r.top>100&&r.bottom<innerHeight-40}) as HTMLElement).dataset.tokenId!);
  const token=page.locator(`[data-token-id="${tokenId}"]`);const before=await geometry(page),y=await page.evaluate(()=>scrollY);
  await token.click();const panel=page.getByRole('dialog',{name:'Word details',exact:true});
  await expect(panel).toBeVisible();await expect(panel).toHaveCSS('position','fixed');await expect(panel).toHaveAttribute('aria-modal','true');
  await expect(page.locator('.sheet-backdrop')).toBeVisible();await expect(page.locator('body')).toHaveCSS('position','fixed');
  await expect(panel.getByText('Loading meanings…',{exact:true})).toHaveCount(0);
  await unchanged(page,before);
  if(desktop)await mouseDoesNotDismiss(page,panel);
  const box=(await panel.boundingBox())!;expect(box.x+box.width).toBeCloseTo(width,0);
  if(width>600)expect(box.width).toBeLessThanOrEqual(355);
  const source=await panel.locator('.word-title h2').innerText();
  const copyWord=panel.getByRole('button',{name:'Copy word',exact:true});
  await expect(copyWord).toHaveText('');await copyWord.click();await expect(copyWord).toHaveAttribute('title','Copied');
  // Paste into an existing unsaved input to verify the real clipboard in both
  // browsers, without replacing clipboard APIs or needing read permission.
  await panel.getByRole('button',{name:'Add meaning',exact:true}).click();const input=panel.getByLabel('Meaning',{exact:true});
  await input.fill('');await input.press('ControlOrMeta+V');await expect(input).toHaveValue(source);
  const sentence=await panel.locator('.sentence-source p').innerText();
  const copySentence=panel.getByRole('button',{name:'Copy sentence',exact:true});
  await expect(copySentence).toHaveText('');await copySentence.click();await expect(copySentence).toHaveAttribute('title','Copied');
  await input.fill('');await input.press('ControlOrMeta+V');await expect(input).toHaveValue(sentence);
  await panel.getByRole('button',{name:'Add meaning',exact:true}).click();
  await panel.locator('.word-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight});await unchanged(page,before);
  // Keyboard focus must remain inside the overlay on desktop as on mobile.
  const close=panel.getByRole('button',{name:'Close word details',exact:true});
  await close.focus();await page.keyboard.press('Shift+Tab');expect(await panel.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');expect(await panel.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await expect.poll(()=>page.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.ended),{timeout:90_000}).toBe(true);
  await panel.locator('.word-scroll').evaluate(el=>{el.scrollTop=0});
  await page.screenshot({path:info.outputPath(`overlay-${width}.png`)});
  await page.keyboard.press('Escape');await expect(panel).toHaveCount(0);await unchanged(page,before);
  expect(await page.evaluate(()=>scrollY)).toBeCloseTo(y,0);
  await token.click();await expect(panel).toBeVisible();await unchanged(page,before);
  await expect.poll(()=>page.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.ended),{timeout:90_000}).toBe(true);
  await page.mouse.click(5,5);await expect(panel).toHaveCount(0);await unchanged(page,before);
  expect(await page.evaluate(()=>scrollY)).toBeCloseTo(y,0);
  await page.waitForTimeout(1200);expect((await(await request.get('/api/v1/texts/'+id)).json()).cursor).toBe(cursor);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  if(width===widths.at(-1)){
   const pair=await page.locator('.token').evaluateAll(tokens=>tokens.filter(el=>{const r=el.getBoundingClientRect();return r.top>100&&r.bottom<innerHeight-40}).slice(0,2).map(el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}));
   expect(pair).toHaveLength(2);
   // Mouse drag starts immediately; no hold or toolbar mode is required.
   await page.mouse.move(pair[0].x,pair[0].y);await page.mouse.down();await page.mouse.move(pair[1].x,pair[1].y,{steps:8});await page.mouse.up();
   const phrase=page.getByRole('dialog',{name:'Selected phrase',exact:true});await expect(phrase).toBeVisible();
   await expect(phrase).toHaveClass('word-panel');await unchanged(page,before);
   if(desktop)await mouseDoesNotDismiss(page,phrase);
   expect(await phrase.boundingBox()).toEqual(box);
   await expect(phrase.locator('.phrase-translation')).toHaveAttribute('aria-busy','false',{timeout:150_000});
   await expect(phrase.locator('input,textarea')).toHaveCount(0);
   const phraseText=(await phrase.locator('.word-title h2').textContent())!;const copy=phrase.getByRole('button',{name:'Copy phrase',exact:true});
   await expect(copy).toHaveText('');await copy.click();await expect(copy).toHaveAttribute('title','Copied');
   await expect.poll(()=>page.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.ended),{timeout:90_000}).toBe(true);
   await page.screenshot({path:info.outputPath(`phrase-overlay-${width}.png`)});
   await phrase.getByRole('button',{name:'Close',exact:true}).click();await unchanged(page,before);
   await page.locator('.reader .back-button').evaluate((el:HTMLButtonElement)=>el.click());
   await page.getByRole('button',{name:'Import text',exact:true}).click();const importDialog=page.getByRole('dialog',{name:'Import text',exact:true});const paste=importDialog.getByLabel('Japanese text');await paste.fill('');await paste.press('ControlOrMeta+V');await expect(paste).toHaveValue(phraseText);await importDialog.getByRole('button',{name:'Close',exact:true}).click();
  }
 }
 if(desktop){
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Settings',exact:true});
  await expect(settings).toBeVisible();await mouseDoesNotDismiss(page,settings);
  await settings.getByRole('button',{name:'Close',exact:true}).click();
 }
 await page.goto('/');
});
