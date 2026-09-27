import {test,expect} from '@playwright/test';

test('reader toolbar and popups respect nonzero device safe areas after scrolling and rotation',async({page,request,browserName},info)=>{
 const cdp=browserName==='chromium'?await page.context().newCDPSession(page):null;
 async function insets(top:number,left:number,right:number,bottom:number){
  if(cdp)await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top,left,right,bottom}});
  else await page.evaluate(({top,left,right,bottom})=>{for(const [key,value] of Object.entries({top,left,right,bottom}))document.documentElement.style.setProperty('--safe-'+key,value+'px')},{top,left,right,bottom});
 }
 const texts=await(await request.get('/api/v1/texts')).json();const text=texts.find((t:{title:string})=>t.title==='Settings gesture acceptance');expect(text).toBeTruthy();
 await page.goto('/#'+text.id);await expect(page.locator('.book-body')).toBeVisible();await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content','default');
 const initial=page.viewportSize()!;
 for(const shape of [{width:390,height:844,top:47,left:0,right:0,bottom:34},{width:844,height:390,top:0,left:47,right:47,bottom:21},{width:1024,height:768,top:24,left:0,right:0,bottom:20}]){
  await page.setViewportSize({width:shape.width,height:shape.height});await insets(shape.top,shape.left,shape.right,shape.bottom);await page.evaluate(()=>scrollTo(0,800));
  const toolbar=page.locator('.reader-toolbar');await expect.poll(()=>toolbar.evaluate(el=>el.getBoundingClientRect().top)).toBeCloseTo(shape.top,0);
  for(const button of await toolbar.locator('button').all()){
   const box=(await button.boundingBox())!;expect(box.y).toBeGreaterThanOrEqual(shape.top);expect(box.x).toBeGreaterThanOrEqual(shape.left);expect(box.x+box.width).toBeLessThanOrEqual(shape.width-shape.right+1);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
  await page.screenshot({path:`test-results/${info.project.name}-safe-area-${shape.width}.png`});
  await page.getByRole('button',{name:'Reading options'}).click();const dialog=page.getByRole('dialog',{name:'Settings',exact:true});await expect(dialog).toBeVisible();const box=(await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(shape.top);expect(box.y+box.height).toBeLessThanOrEqual(shape.height-shape.bottom+1);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('.token').first().tap();const word=page.getByLabel('Word details',{exact:true});await expect(word).toBeVisible();const close=word.getByRole('button',{name:'Close word details',exact:true});const closeBox=(await close.boundingBox())!;expect(closeBox.y).toBeGreaterThanOrEqual(shape.top);expect(closeBox.y+closeBox.height).toBeLessThanOrEqual(shape.height-shape.bottom+1);await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.ended),{timeout:90_000}).toBe(true);await close.click();
 }
 await insets(0,0,0,0);await page.setViewportSize(initial);await cdp?.detach();
});
