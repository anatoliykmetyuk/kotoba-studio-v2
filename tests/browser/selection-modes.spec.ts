import {test,expect,type Page,type Locator} from './fixtures';
import {muteTestOutput} from './audio-output';
type Point={x:number;y:number};
type Input='touch'|'pen'|'mouse';
async function center(locator:Locator):Promise<Point>{const b=(await locator.boundingBox())!;return {x:b.x+b.width/2,y:b.y+b.height/2}}
async function pointer(page:Page,browserName:string,input:Input){
 const cdp=browserName==='chromium'&&input!=='mouse'?await page.context().newCDPSession(page):null;
 let point:Point={x:0,y:0};
 async function dispatch(type:'down'|'move'|'up',p:Point){
  point=p;
  if(input==='mouse'){
   if(type==='down'){await page.mouse.move(p.x,p.y);await page.mouse.down()}
   else if(type==='move')await page.mouse.move(p.x,p.y);else await page.mouse.up();
  }else if(cdp){
   if(input==='touch')await cdp.send('Input.dispatchTouchEvent',{type:type==='down'?'touchStart':type==='move'?'touchMove':'touchEnd',touchPoints:type==='up'?[]:[p]});
   else await cdp.send('Input.dispatchMouseEvent',{type:type==='down'?'mousePressed':type==='move'?'mouseMoved':'mouseReleased',...p,button:'left',buttons:type==='up'?0:1,clickCount:type==='move'?0:1,pointerType:'pen'});
  }else await page.evaluate(({input,type,p})=>{
   if(type==='down')(window as any).selectionTarget=document.elementFromPoint(p.x,p.y);
   const target=(window as any).selectionTarget as Element;
   if(input==='pen')target.dispatchEvent(new PointerEvent('pointer'+type,{bubbles:true,cancelable:true,pointerId:12,pointerType:'pen',isPrimary:true,button:0,buttons:type==='up'?0:1,clientX:p.x,clientY:p.y}));
   else{
    const name=type==='down'?'touchstart':type==='move'?'touchmove':'touchend';
    const touch={identifier:12,clientX:p.x,clientY:p.y};const event=new Event(name,{bubbles:true,cancelable:true});Object.assign(event,{touches:type==='up'?[]:[touch],changedTouches:[touch]});target.dispatchEvent(event);
   }
  },{input,type,p});
 }
 return {down:(p:Point)=>dispatch('down',p),move:(p:Point)=>dispatch('move',p),up:()=>dispatch('up',point),close:()=>cdp?.detach()};
}

test('hold-release then endpoint tap and hold-drag both select a phrase',async({page,request,browserName},info)=>{
 await muteTestOutput(page);
 await request.patch('/api/v1/settings',{data:{fontSize:20,lineHeight:1.85}});
 const response=await request.post('/api/v1/imports',{data:{title:'Selection modes acceptance',body:'猫は窓のそばで眠っています。私は温かいお茶を飲みました。',folder:'Acceptance'}});
 expect(response.ok()).toBe(true);const submitted=await response.json();let id=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();if(job.state==='failed')throw new Error(job.error);id=job.result.textId;return job.state},{timeout:60_000}).toBe('ready');
 const text=await(await request.get('/api/v1/texts/'+id)).json(),tokens=text.sentences[0].tokens;
 const expected=Array.from(text.sentences[0].body as string).slice(tokens[0].start,tokens[2].end).join('');
 const inputs:Input[]=info.project.name.startsWith('desktop')?['mouse','pen']:info.project.name.startsWith('ipad')?['touch','pen']:['touch'];
 const learns:string[]=[],speech:string[]=[],translations:string[]=[];
 page.on('request',r=>{if(/\/words\/[^/]+\/learn$/.test(r.url()))learns.push(r.url());if(r.url().includes('/speech/play?'))speech.push(r.url());if(r.url().endsWith('/phrase-tools/translation'))translations.push(r.url())});
 for(const inputType of inputs){
  await page.goto('/#'+id);const first=page.locator(`[data-token-id="${tokens[0].id}"]`),last=page.locator(`[data-token-id="${tokens[2].id}"]`);
  await expect(first).toBeVisible();await first.scrollIntoViewIfNeeded();const a=await center(first),b=await center(last);
  const input=await pointer(page,browserName,inputType);
  try{
   await input.down(a);
   // Unrelated hovering pointers must not cancel or finish the held gesture.
   await page.evaluate(input=>{
    for(const type of ['pointermove','pointerup','pointercancel'])window.dispatchEvent(new PointerEvent(type,{pointerId:999,pointerType:input==='mouse'?'pen':'mouse',clientX:700,clientY:20}));
   },inputType);
   await page.waitForTimeout(500);await input.up();
   await expect(page.locator('.range-selected')).toHaveCount(1);
   await expect(page.getByRole('dialog')).toHaveCount(0);expect(learns).toHaveLength(0);expect(translations).toHaveLength(inputs.indexOf(inputType)*2);expect(speech.filter(url=>!url.includes('/phrase-tools/'))).toHaveLength(0);
   if(inputType==='touch')await last.tap();else {await input.down(b);await input.up()}
   const phrase=page.getByRole('dialog',{name:'Selected phrase',exact:true});await expect(phrase).toBeVisible();await expect(phrase.locator('.phrase-japanese')).toHaveText(expected);
   await expect(phrase.locator('.phrase-translation')).toHaveAttribute('aria-busy','false',{timeout:90_000});
   await page.screenshot({path:info.outputPath(`${inputType}-hold-tap.png`)});
   await phrase.getByRole('button',{name:'Close',exact:true}).click();await expect(page.locator('.range-selected')).toHaveCount(0);
   await first.scrollIntoViewIfNeeded();await input.down(await center(first));await page.waitForTimeout(500);await input.move(await center(last));await input.up();
   await expect(phrase).toBeVisible();await expect(phrase.locator('.phrase-japanese')).toHaveText(expected);
   await expect(phrase.locator('.phrase-translation')).toHaveAttribute('aria-busy','false',{timeout:90_000});
   await phrase.getByRole('button',{name:'Close',exact:true}).click();
   // Escape cancels a held anchor, without learning or speaking the word.
   await first.scrollIntoViewIfNeeded();await input.down(await center(first));await page.waitForTimeout(500);await input.up();await expect(page.locator('.range-selected')).toHaveCount(1);
   await page.keyboard.press('Escape');await expect(page.locator('.range-selected')).toHaveCount(0);
  }finally{await input.close()}
 }
 expect(learns).toHaveLength(0);expect(translations).toHaveLength(inputs.length*2);expect(speech.filter(url=>!url.includes('/phrase-tools/'))).toHaveLength(0);
 await expect(page.getByRole('button',{name:'Select phrase',exact:true})).toHaveCount(0);
});

test('keyboard activation works after canceling a pen anchor without a click',async({page,request})=>{
 await muteTestOutput(page);
 const response=await request.post('/api/v1/imports',{data:{title:'Selection modes acceptance',body:'猫は窓のそばで眠っています。私は温かいお茶を飲みました。',folder:'Acceptance'}});
 expect(response.ok()).toBe(true);const submitted=await response.json();let id=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();id=job.result.textId;return job.state}).toBe('ready');
 await page.goto('/#'+id);const first=page.locator('.token').first();await expect(first).toBeVisible();
 // Deliberately omit the compatibility click in either engine.
 const input=await pointer(page,'dom','pen');await input.down(await center(first));await page.waitForTimeout(500);await input.up();
 await expect(page.locator('.range-selected')).toHaveCount(1);
 await page.keyboard.press('Escape');await expect(page.locator('.range-selected')).toHaveCount(0);
 await first.focus();await first.press('Enter');await expect(page.getByRole('dialog',{name:'Word details',exact:true})).toBeVisible();
});
