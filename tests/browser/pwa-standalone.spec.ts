import {test,expect,chromium} from './fixtures';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type {TextItem} from '../../web/src/api';
import {muteTestOutput} from './audio-output';

test('standalone app window keeps phone and tablet reader controls within the viewport',async({request,browserName,baseURL},info)=>{
 test.skip(browserName!=='chromium'||info.project.name!=='phone-chromium-portrait','Chromium app-window coverage; WebKit mobile coverage uses the six device projects.');
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);
 const response=await request.post('/api/v1/imports',{data:{title:'Standalone app acceptance',body:'猫は窓のそばで眠っています。\nStandalone '+randomUUID()}});expect(response.ok()).toBe(true);
 const submitted=await response.json();let textId=submitted.textId;
 if(!textId)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();expect(job.state,job.error).not.toBe('failed');textId=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 const text=await(await request.get('/api/v1/texts/'+textId)).json() as TextItem;
 const token=text.sentences.flatMap(s=>s.tokens)[0];expect(token).toBeTruthy();
 expect((await request.put('/api/v1/words/'+token.baseId+'/status',{data:{state:'known'}})).ok()).toBe(true);
 const directory=await mkdtemp('.runtime/standalone-browser-');
 // Use a real Chromium app window at phone/tablet sizes. Mobile device-metrics
 // emulation replaces its native standalone display mode with browser mode.
 const context=await chromium.launchPersistentContext(directory,{channel:'chromium',headless:true,args:['--mute-audio','--app='+baseURL],viewport:{width:390,height:844},isMobile:false,hasTouch:true});
 try{
  const page=context.pages()[0];await muteTestOutput(page);await page.goto(baseURL!);
  await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>matchMedia('(display-mode: standalone)').matches)).toBe(true);
  expect(await page.evaluate(()=>isSecureContext)).toBe(true);
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  for(const size of [{width:390,height:844},{width:844,height:390},{width:820,height:1180},{width:1180,height:820}]){
   await page.setViewportSize(size);await page.goto(baseURL+'/#'+text.id);await expect(page.locator('.reader')).toBeVisible();
   await page.locator(`[data-token-id="${token.id}"]`).tap();const panel=page.getByRole('dialog',{name:'Word details',exact:true});
   const status=panel.getByRole('group',{name:'Learning Status'});await expect(status).toHaveCount(1);
   await expect(status.getByRole('button',{name:'Known',exact:true})).toHaveAttribute('aria-pressed','true');
   const close=panel.getByRole('button',{name:'Close word details',exact:true});
   for(const control of [close,...await status.getByRole('button').all()]){
    await control.scrollIntoViewIfNeeded();
    const box=(await control.boundingBox())!;expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(size.width+1);expect(box.y+box.height).toBeLessThanOrEqual(size.height+1);
   }
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.screenshot({path:info.outputPath(`standalone-${size.width}.png`)});await close.tap();await expect(panel).toHaveCount(0);
   await page.getByRole('button',{name:'Reading options',exact:true}).tap();const settings=page.getByRole('dialog',{name:'Settings',exact:true});await expect(settings).toBeVisible();await settings.getByRole('button',{name:'Close',exact:true}).tap();
  }
 }finally{
  await context.close();await rm(directory,{recursive:true,force:true});
  await expect.poll(async()=>{const current=await(await request.get('/api/v1/texts/'+textId)).json();return(await request.patch('/api/v1/texts/'+textId,{data:{archived:true,revision:current.revision}})).status()}).toBe(200);
 }
});
