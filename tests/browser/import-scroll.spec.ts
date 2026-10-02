import {test,expect,chromium,type Locator,type Page} from './fixtures';
import {mkdtemp,rm} from 'node:fs/promises';
import {muteBrowserContext} from './audio-output';

// DOM events prove handler ownership on WebKit too. They do not emulate native
// Safari panning; Chromium additionally receives trusted touch input below.
async function gesture(target:Locator,dy:number){
 return target.evaluate((el,dy)=>{
  const box=el.getBoundingClientRect(),from={x:box.left+8,y:box.top+8};
  let prevented=false;
  for(const [type,offset] of [['touchstart',0],['touchmove',dy],['touchend',dy]] as const){
   const point={identifier:1,clientX:from.x,clientY:from.y+offset};
   const event=new Event(type,{bubbles:true,cancelable:true});
   Object.assign(event,{touches:type==='touchend'?[]:[point],changedTouches:[point]});
   el.dispatchEvent(event);if(type==='touchmove')prevented=event.defaultPrevented;
  }
  return prevented;
 },dy);
}

async function swipe(page:Page,from:{x:number;y:number},dy:number){
 const cdp=await page.context().newCDPSession(page);
 try{
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
  for(let n=1;n<=10;n++){
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x,y:from.y+dy*n/10}]});
   await page.waitForTimeout(25);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(400);
 }finally{await cdp.detach()}
}

test('import gestures belong to the text area or form where they begin',async({page,browserName},info)=>{
 await page.goto('/');await page.getByRole('button',{name:'Import text',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Import text',exact:true});
 const text=dialog.getByRole('textbox',{name:'Japanese text',exact:true});
 await text.fill('猫は窓のそばで眠っています。\n'.repeat(100));
 await expect(text).toBeFocused();
 await page.evaluate(()=>{
  for(const [name,value] of Object.entries({top:24,bottom:20,left:12,right:12}))document.documentElement.style.setProperty('--safe-'+name,value+'px');
 });
 await page.screenshot({path:info.outputPath('import-original-viewport.png')});
 // Short visual viewports occur with the keyboard and on landscape phones.
 const viewport=page.viewportSize()!;
 await page.setViewportSize({width:viewport.width,height:Math.min(420,viewport.height)});
 // WebKit scrolls the focused caret into view after viewport relayout. Finish
 // that adjustment before establishing independent textarea scroll positions.
 await text.evaluate((el:HTMLTextAreaElement)=>el.setSelectionRange(0,0));
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 const titleLabel=dialog.locator('.import-form > label').first();
 const gap=dialog.locator('.import-form');
 for(const containerTop of [0,40]){
  for(const target of [titleLabel,gap]){
   await dialog.evaluate((el,top)=>{el.scrollTop=top},containerTop);
   await text.evaluate(el=>{el.scrollTop=120});
   expect(await gesture(target,-30)).toBe(false);
   expect(await text.evaluate(el=>el.scrollTop)).toBe(120);
   expect(await dialog.evaluate(el=>el.scrollTop)).toBe(containerTop);
   await expect(dialog).toBeVisible();
  }
 }
 // Native controls keep selection and downward scrolling even when the form
 // is at its top. A large downward drag must not dismiss the dialog.
 await dialog.evaluate(el=>{el.scrollTop=0});await text.evaluate(el=>{el.scrollTop=120});
 expect(await gesture(text,100)).toBe(false);await expect(dialog).toBeVisible();
 expect(await text.evaluate(el=>el.scrollTop)).toBe(120);
 if(browserName==='chromium'){
  await dialog.evaluate(el=>{el.scrollTop=40});await text.evaluate(el=>{el.scrollTop=120});
  const box=(await dialog.boundingBox())!;
  await swipe(page,{x:box.x+8,y:box.y+box.height*.65},-80);
  expect(await dialog.evaluate(el=>el.scrollTop)).toBeGreaterThan(40);
  expect(await text.evaluate(el=>el.scrollTop)).toBe(120);
  await dialog.evaluate(el=>{el.scrollTop=0});await text.evaluate(el=>{el.scrollTop=120});
  const field=(await text.boundingBox())!;
  await swipe(page,{x:field.x+field.width/2,y:Math.min(field.y+field.height-20,box.y+box.height-30)},-65);
  expect(await text.evaluate(el=>el.scrollTop)).toBeGreaterThan(120);
  expect(await dialog.evaluate(el=>el.scrollTop)).toBe(0);
 }
 await dialog.evaluate(el=>{el.scrollTop=40});await page.screenshot({path:info.outputPath('import-scroll.png')});
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await expect(dialog).toHaveCount(0);await expect(page.locator('body')).not.toHaveCSS('position','fixed');
});

test('standalone import form scrolls independently of its focused text area',async({browserName,baseURL},info)=>{
 test.skip(browserName!=='chromium'||info.project.name!=='phone-chromium-portrait','One actual Chromium app window; WebKit uses the device matrix.');
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);
 const directory=await mkdtemp('.runtime/import-scroll-app-');
 const context=await chromium.launchPersistentContext(directory,{channel:'chromium',headless:true,args:['--mute-audio','--app='+baseURL],viewport:{width:390,height:420},isMobile:false,hasTouch:true});
 try{
  await muteBrowserContext(context);const page=context.pages()[0];await page.goto(baseURL!);
  await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>matchMedia('(display-mode: standalone)').matches&&isSecureContext)).toBe(true);
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  for(const width of [390,820]){
   await page.setViewportSize({width,height:420});
   await page.getByRole('button',{name:'Import text',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'Import text',exact:true});
   const text=dialog.getByRole('textbox',{name:'Japanese text',exact:true});
   await text.fill('猫は窓のそばで眠っています。\n'.repeat(100));
   await text.evaluate((el:HTMLTextAreaElement)=>{el.setSelectionRange(0,0);el.scrollTop=120});
   await dialog.evaluate(el=>{el.scrollTop=40});
   const box=(await dialog.boundingBox())!;
   await swipe(page,{x:box.x+8,y:box.y+box.height*.65},-80);
   expect(await dialog.evaluate(el=>el.scrollTop)).toBeGreaterThan(40);
   expect(await text.evaluate(el=>el.scrollTop)).toBe(120);
   await page.screenshot({path:info.outputPath(`standalone-import-${width}.png`)});
   await dialog.getByRole('button',{name:'Close',exact:true}).click();await expect(dialog).toHaveCount(0);
  }
 }finally{await context.close();await rm(directory,{recursive:true,force:true})}
});
