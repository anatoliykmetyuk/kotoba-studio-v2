import {test,expect,type Page} from '@playwright/test';
const body='猫は窓のそばで眠っています。私は温かいお茶を飲みました。';
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy()}
async function visibleButton(page:Page,name:string){return page.getByRole('button',{name,exact:true}).filter({visible:true}).first()}
async function selectFirstPhrase(page:Page,browserName:string){
 const first=page.locator('.token').nth(0),last=page.locator('.token').nth(1);
 await last.scrollIntoViewIfNeeded();await first.scrollIntoViewIfNeeded();
 const a=(await first.boundingBox())!,b=(await last.boundingBox())!;
 const from={x:a.x+a.width/2,y:a.y+a.height/2},to={x:b.x+b.width/2,y:b.y+b.height/2};
 if(browserName==='chromium'){
  const cdp=await page.context().newCDPSession(page);
  try{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});await page.waitForTimeout(500);
   for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*i/8,y:from.y+(to.y-from.y)*i/8}]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }finally{await cdp.detach()}
 }else{
  // WebKit needs trusted input for automatic phrase playback.
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up();
 }
}

test('import, token status, pronunciation, phrase, completion, settings and navigation over Tailscale',async({page,request,browserName},info)=>{
 const settings=await request.patch('/api/v1/settings',{data:{fontSize:20,lineHeight:1.85,theme:'light'}});expect(settings.ok()).toBeTruthy();
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)errors.push(`${r.status()} ${r.url()}`)});page.on('console',e=>{if(e.type()==='error')errors.push(e.text())});
 await page.goto('/');await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();await noOverflow(page);await page.screenshot({path:`test-results/${info.project.name}-library.png`,fullPage:false});
 const controls=await page.locator('.library-tools .tabs button, .library-tools .search-field, .library-tools select').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}}));for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++){const a=controls[i],b=controls[j];expect(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1,'Library controls must not overlap').toBeFalsy()}
 await page.getByRole('button',{name:'Import text',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 await dialog.getByLabel('Title',{exact:true}).fill('雨の午後 · usability test');await dialog.getByLabel('Japanese text').fill(body);await dialog.getByLabel('Folder',{exact:true}).selectOption({label:'Acceptance'});await dialog.getByLabel('Source link',{exact:false}).fill('https://example.com/kotoba');
 await dialog.getByRole('button',{name:'Import & read'}).click();await expect(page.locator('.reader')).toBeVisible({timeout:110_000});await expect(dialog).toHaveCount(0);await noOverflow(page);const importedTextId=new URL(page.url()).hash.slice(1);
 const first=page.locator('.token').first();await first.tap();const panel=page.getByLabel('Word details',{exact:true});await expect(panel).toBeVisible();await expect(panel.getByRole('heading',{name:'Learning Status'})).toBeVisible();
 await panel.getByRole('group',{name:'Learning Status'}).getByRole('button',{name:'Known',exact:true}).click();await expect(panel.getByRole('group',{name:'Learning Status'}).getByRole('button',{name:'Known',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.screenshot({path:`test-results/${info.project.name}-word.png`});await noOverflow(page);
 await panel.getByRole('button',{name:'Close word details',exact:true}).click();await page.reload();await expect(page.locator('.reader')).toBeVisible();await page.locator('.token').first().tap();await expect(page.getByLabel('Word details',{exact:true}).getByRole('group',{name:'Learning Status'}).getByRole('button',{name:'Known',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.locator('audio').evaluate(audio=>{audio.dataset.replayed='false';audio.addEventListener('ended',()=>{audio.dataset.replayed='true'},{once:true})});await page.getByRole('button',{name:'Pronounce word'}).click();await expect(page.locator('audio')).toHaveAttribute('data-replayed','true',{timeout:90_000});await expect(page.getByRole('alert')).toHaveCount(0);
 await page.getByRole('button',{name:'Close word details',exact:true}).click();
 await selectFirstPhrase(page,browserName);const phrase=page.getByRole('dialog',{name:'Selected phrase'});await expect(phrase).toBeVisible();await expect(phrase.locator('.phrase-translation')).toHaveAttribute('aria-busy','false',{timeout:150_000});await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.ended),{timeout:90_000}).toBe(true);await phrase.getByRole('button',{name:'Close',exact:true}).click();
 const complete=page.getByRole('button',{name:'Complete text',exact:true});if(await complete.count()){await complete.click();await page.getByRole('dialog',{name:'Complete lesson',exact:true}).getByRole('button',{name:'Complete lesson',exact:true}).click();}await expect(page.getByRole('button',{name:'Mark as New',exact:true})).toBeVisible();await page.getByRole('button',{name:'Mark as New',exact:true}).click();await expect(page.getByRole('button',{name:'Complete text',exact:true})).toBeVisible();
 await page.screenshot({path:`test-results/${info.project.name}-reader.png`});await noOverflow(page);
 await page.getByRole('button',{name:'Reading options'}).click();await expect(page.getByRole('dialog')).toBeVisible();const size=page.getByRole('slider',{name:/Reading size/});const spacing=page.getByRole('slider',{name:/Line spacing/});const oldSize=Number(await size.inputValue());const oldSpacing=Number(await spacing.inputValue());await size.focus();await size.press('ArrowRight');await spacing.focus();await spacing.press('ArrowRight');await expect(page.locator('.book-body')).toHaveCSS('font-size',(oldSize+1)+'px');await expect.poll(async()=>page.locator('.book-body').evaluate(el=>Number((el as HTMLElement).style.lineHeight))).toBeCloseTo(oldSpacing+.05,2);await page.getByLabel('Appearance').selectOption('dark');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.getByLabel('Appearance').selectOption('light');await page.getByRole('button',{name:'Close',exact:true}).click();await expect.poll(async()=>{const stored=await (await request.get('/api/v1/settings')).json();return stored.lineHeight}).toBeGreaterThan(1.85);
 await page.locator('.reader .back-button').click();await (await visibleButton(page,'Explore')).click();await page.getByRole('textbox',{name:'Search corpus'}).fill('猫');await expect(page.locator('.explore-card').first()).toBeVisible();await page.getByLabel('At least 80% known').check();await noOverflow(page);
 const detail=await(await request.get('/api/v1/texts/'+importedTextId)).json();for(const base of new Set<string>(detail.sentences.flatMap((s:any)=>s.tokens.map((t:any)=>t.baseId))))await request.put('/api/v1/words/'+base+'/status',{data:{state:'learning'}});await page.goto('/#'+importedTextId);await expect(page.locator('.reader')).toBeVisible();await page.locator('.reader-finish').getByRole('button',{name:'Practice',exact:true}).click();await expect(page.getByLabel('Include all statuses')).toHaveCount(0);await expect(page.locator('.practice-card')).toBeVisible();await page.getByRole('button',{name:'Build a sentence'}).click();await expect(page.locator('.pieces button').first()).toBeVisible({timeout:150_000});await expect(page.locator('.sentence-translation')).not.toBeEmpty();await noOverflow(page);
 expect(errors).toEqual([]);
});

test('long corpus text, emoji offsets and compact import dialog remain usable',async({page,request},info)=>{
 const texts=await (await request.get('/api/v1/texts')).json();const text=texts.find((x:{title:string})=>x.title==='19 aug');
 await page.goto('/#'+text.id);await expect(page.locator('.reader')).toBeVisible();await page.evaluate(()=>scrollTo(0,0));await noOverflow(page);await expect(page.getByRole('button',{name:/Read to here|Read through sentence/})).toHaveCount(0);expect(await page.locator('.book-paragraph').count()).toBeGreaterThan(1);
 const detail=await (await request.get('/api/v1/texts/'+text.id)).json();const sample=detail.sentences.find((x:{body:string})=>x.body.includes('🇺🇦'));
 if(sample){const row=page.locator(`[data-sentence="${sample.id}"] .sentence-content`);const visible=await row.evaluate(el=>{const n=el.cloneNode(true) as HTMLElement;n.querySelectorAll('rt').forEach(x=>x.remove());return n.textContent});expect(visible).toBe(sample.body)}
 await page.getByRole('button',{name:'Import text',exact:true}).click();await page.getByRole('dialog').getByLabel('Japanese text').fill('日本語のテキスト');
 const viewport=page.viewportSize()!;await page.setViewportSize({width:viewport.width,height:Math.max(320,Math.floor(viewport.height*.6))});await page.getByRole('dialog').getByLabel('Title',{exact:true}).fill('Keyboard layout');await page.getByRole('button',{name:'Import & read'}).scrollIntoViewIfNeeded();await expect(page.getByRole('button',{name:'Import & read'})).toBeInViewport();await noOverflow(page);
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.setViewportSize(viewport);
});

test('automatic position survives immediate exit and a real offline interval',async({page,request,context},info)=>{
 test.skip(info.project.name!=='phone-chromium-portrait','Shared persistence scenario runs once against the isolated stack.');
 const texts=await (await request.get('/api/v1/texts')).json();const text=texts.find((x:{title:string})=>x.title==='A quiet study session');
 async function reset(){const r=await request.post('/api/v1/graph/transaction',{data:{statements:[{query:'MATCH (t:Text {id:$id}) SET t.cursor=0 RETURN t.id',params:{id:text.id}}]}});expect(r.ok()).toBeTruthy()}
 async function cursor(){return (await (await request.get('/api/v1/texts/'+text.id)).json()).cursor}
 await reset();await page.goto('/#'+text.id);await expect(page.locator('.book-body')).toBeVisible();await page.waitForTimeout(450);await page.evaluate(()=>scrollTo(0,1000));await page.locator('.reader .back-button').click();await expect.poll(cursor).toBeGreaterThan(0);
 await reset();await page.goto('/#'+text.id);await expect(page.locator('.book-body')).toBeVisible();await page.waitForTimeout(450);await context.setOffline(true);await page.evaluate(()=>scrollTo(0,1400));await page.waitForTimeout(1200);
 const queued=await page.evaluate(id=>Number(localStorage.getItem('kotoba:cursor:'+id)),text.id);expect(queued).toBeGreaterThan(0);expect(await cursor()).toBe(0);
 await context.setOffline(false);await expect.poll(cursor).toBeGreaterThanOrEqual(queued);await expect.poll(()=>page.evaluate(id=>localStorage.getItem('kotoba:cursor:'+id),text.id)).toBeNull();
});
