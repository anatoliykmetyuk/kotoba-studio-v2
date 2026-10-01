import {test,expect,type Locator,type Page} from './fixtures';

type Point={x:number;y:number};

// Chromium uses native touch input. Playwright WebKit exposes no native touch
// dispatch API, so those projects exercise the same captured-pointer handlers
// with real mouse input, and the scroll guard with DOM touch events separately.
async function pointer(page:Page,browserName:string){
 const session=browserName==='chromium'?await page.context().newCDPSession(page):null;
 return {
  session,
  async down(point:Point){if(session)await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});else{await page.mouse.move(point.x,point.y);await page.mouse.down()}},
  async move(point:Point){if(session)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point]});else await page.mouse.move(point.x,point.y)},
  async up(){if(session)await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else await page.mouse.up()},
  async close(){await session?.detach()}
 };
}

async function thumb(slider:Locator){
 const rect=(await slider.boundingBox())!;
 const {min,max,value}=await slider.evaluate((input:HTMLInputElement)=>({min:Number(input.min),max:Number(input.max),value:Number(input.value)}));
 return {x:rect.x+22+(value-min)/(max-min)*(rect.width-44),y:rect.y+rect.height/2,travel:rect.width-44};
}

async function swipe(page:Page,browserName:string,from:Point,to:Point){
 if(browserName==='chromium'){
  const input=await pointer(page,browserName);await input.down(from);
  for(let n=1;n<=8;n++){await input.move({x:from.x+(to.x-from.x)*n/8,y:from.y+(to.y-from.y)*n/8});await page.waitForTimeout(20)}
  await input.up();await input.close();
 }else{
  await page.evaluate(({from,to})=>{
   const target=document.elementFromPoint(from.x,from.y)!;
   function dispatch(name:string,point:Point){const touch={identifier:1,clientX:point.x,clientY:point.y};const event=new Event(name,{bubbles:true,cancelable:true});Object.assign(event,{touches:name==='touchend'?[]:[touch],changedTouches:[touch]});target.dispatchEvent(event)}
   dispatch('touchstart',from);dispatch('touchmove',to);dispatch('touchend',to);
  },{from,to});
 }
}

test('settings hold the reading position and sliders stay at the touched value',async({page,request,browserName},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 expect((await request.patch('/api/v1/settings',{data:{fontSize:20,lineHeight:1.85,readerLayout:'book',theme:'light'}})).ok()).toBeTruthy();
 const response=await request.post('/api/v1/imports',{data:{title:'Settings gesture acceptance',body:Array(28).fill('猫は窓のそばで眠っています。私は温かいお茶を飲みました。').join('\n\n'),folder:'Acceptance'}});
 expect(response.ok()).toBeTruthy();const submitted=await response.json();let textId=submitted.textId;
 if(!textId)await expect.poll(async()=>{const job=await (await request.get('/api/v1/jobs/'+submitted.jobId)).json();textId=job.result.textId;return job.state},{timeout:60_000}).toBe('ready');
 await page.goto('/#'+textId);await expect(page.locator('.book-body')).toBeVisible();
 await page.evaluate(()=>scrollTo(0,600));await expect.poll(()=>page.evaluate(()=>scrollY)).toBeGreaterThan(100);
 const originalY=await page.evaluate(()=>scrollY);
 const originalTop=await page.locator('.book-body').evaluate(el=>el.getBoundingClientRect().top);
 // Opening via the existing click handler avoids Playwright first scrolling the
 // offscreen options button into view, which would erase this regression setup.
 await page.getByRole('button',{name:'Reading options'}).evaluate((button:HTMLButtonElement)=>button.click());
 const dialog=page.getByRole('dialog',{name:'Settings',exact:true});await expect(dialog).toBeVisible();
 await expect(page.locator('body')).toHaveCSS('position','fixed');
 expect(await page.locator('.book-body').evaluate(el=>el.getBoundingClientRect().top)).toBeCloseTo(originalTop,0);
 const viewport=page.viewportSize()!;
 await page.setViewportSize({width:viewport.width,height:Math.min(viewport.height,420)});
 await dialog.evaluate(el=>{el.scrollTop=80});
 await expect.poll(()=>dialog.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 const dialogBox=(await dialog.boundingBox())!;
 const from={x:dialogBox.x+12,y:dialogBox.y+Math.min(dialogBox.height/2,180)};
 await swipe(page,browserName,from,{x:from.x,y:from.y+80});
 await expect(dialog).toBeVisible();
 expect(await page.locator('.book-body').evaluate(el=>el.getBoundingClientRect().top)).toBeCloseTo(originalTop,0);
 await page.waitForTimeout(500);await dialog.evaluate(el=>{el.scrollTop=0});await expect.poll(()=>dialog.evaluate(el=>el.scrollTop)).toBe(0);
 await swipe(page,browserName,from,{x:from.x,y:from.y-50});
 await expect(dialog).toBeVisible();
 await page.waitForTimeout(500);await dialog.evaluate(el=>{el.scrollTop=0});await expect.poll(()=>dialog.evaluate(el=>el.scrollTop)).toBe(0);
 await swipe(page,browserName,from,{x:from.x,y:from.y+100});
 await expect(dialog).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>scrollY)).toBeCloseTo(originalY,0);
 await page.setViewportSize(viewport);

 await page.getByRole('button',{name:'Reading options'}).click();
 const input=await pointer(page,browserName);
 // Delay real service responses to cover an older save completing while the
 // user's finger is stationary on a later value. No API routes are mocked.
 if(input.session)await input.session.send('Network.emulateNetworkConditions',{offline:false,latency:450,downloadThroughput:-1,uploadThroughput:-1});
 try{
  for(const [label,min,max,step] of [['Reading size',16,32,1],['Line spacing',1.4,2.4,.05]] as const){
   const slider=dialog.getByRole('slider',{name:label,exact:true});await slider.scrollIntoViewIfNeeded();
   const box=(await slider.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);
   const initial=Number(await slider.inputValue());const center=await thumb(slider);
   // The point is outside the visible knob but inside its 44px hit area.
   const start={x:center.x+18,y:center.y+18};await input.down(start);
   await expect(slider).toHaveValue(String(initial));
   await input.move({x:start.x+center.travel*.10,y:start.y});
   await page.waitForTimeout(425);
   await input.move({x:start.x+center.travel*.25,y:start.y});
   const expected=Number(Math.min(max,min+Math.round((initial+(max-min)*.25-min)/step)*step).toFixed(2));
   await expect(slider).toHaveValue(String(expected));
   // Sample through acknowledgements, checking reader layout as well as the
   // draft: a thumb alone could conceal a stale settings response in the reader.
   const samples=await slider.evaluate(async(input:HTMLInputElement,label)=>{
    const result:{value:number;reader:number}[]=[];
    for(let n=0;n<28;n++){
     const book=document.querySelector<HTMLElement>('.book-body')!;
     result.push({value:Number(input.value),reader:parseFloat(label==='Reading size'?book.style.fontSize:book.style.lineHeight)});
     await new Promise(resolve=>setTimeout(resolve,60));
    }
    return result;
   },label);
   for(const sample of samples){expect(sample.value).toBeCloseTo(expected,2);expect(sample.reader).toBeCloseTo(expected,2)}
   await input.up();await expect(slider).toHaveValue(String(expected));
   await page.waitForTimeout(500);await expect(slider).toHaveValue(String(expected));
   await slider.focus();await slider.press('ArrowLeft');
   await expect(slider).toHaveValue(String(Number((expected-step).toFixed(2))));
   // A native track tap is applied once and does not change on release.
   const track=(await slider.boundingBox())!;await input.down({x:track.x+22+(track.width-44)*.75,y:track.y+track.height/2});
   const tapped=await slider.inputValue();await input.up();await expect(slider).toHaveValue(tapped);
  }
 }finally{
  if(input.session)await input.session.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await input.close();
 }
 const size=Number(await dialog.getByRole('slider',{name:'Reading size',exact:true}).inputValue());
 const spacing=Number(await dialog.getByRole('slider',{name:'Line spacing',exact:true}).inputValue());
 await expect.poll(async()=>{const settings=await (await request.get('/api/v1/settings')).json();return [settings.fontSize,settings.lineHeight]}).toEqual([size,spacing]);
 await page.screenshot({path:`test-results/${info.project.name}-settings-gestures.png`});
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await page.reload();await page.getByRole('button',{name:'Reading options'}).click();
 await expect(dialog.getByRole('slider',{name:'Reading size',exact:true})).toHaveValue(String(size));
 await expect(dialog.getByRole('slider',{name:'Line spacing',exact:true})).toHaveValue(String(spacing));
 expect(errors).toEqual([]);
});
