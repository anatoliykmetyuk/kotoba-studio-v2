import {test,expect} from './fixtures';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const execute=promisify(execFile);
const origin=process.env.KOTOBA_TEST_BASE_URL??'https://localhost:8443';
test.use({baseURL:origin});

test('Settings checks, reports failures, and reloads only a ready app update',async({page,baseURL},info)=>{
 test.skip(process.env.KOTOBA_PWA_UPDATE!=='1','Requires exclusive access to the isolated acceptance web container.');
 expect(baseURL).toBe(origin);
 const container='kotoba-v2-acceptance-web-1',target='/usr/share/nginx/html/sw.js';
 const labels=JSON.parse((await execute('docker',['inspect','--format','{{json .Config.Labels}}',container])).stdout);
 expect(labels['com.docker.compose.project']).toBe('kotoba-v2-acceptance');
 const original=(await execute('docker',['exec',container,'cat',target])).stdout;
 const directory=await mkdtemp(join(tmpdir(),'kotoba-pwa-update-'));
 const saved=join(directory,'original.js'),changed=join(directory,'changed.js'),invalid=join(directory,'invalid.js');
 await writeFile(saved,original);await writeFile(changed,original+'\n// Acceptance update '+Date.now()+'\n');await writeFile(invalid,'invalid javascript !@#');
 try{
  await page.goto('/');await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  await expect(page.locator('.connection-banner').filter({hasText:'Update available'})).toHaveCount(0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Settings',exact:true}),updates=settings.getByRole('region',{name:'App updates',exact:true});
  const check=updates.getByRole('button',{name:'Check for updates',exact:true});
  await check.click();await expect(updates.getByRole('status')).toHaveText('Up to date');
  await expect(updates.getByRole('button',{name:'Reload to update',exact:true})).toHaveCount(0);
  // A real failed worker script fetch/evaluation must never report up to date.
  await execute('docker',['cp',invalid,container+':'+target]);
  await check.click();await expect(updates.getByRole('status')).toContainText('Could not check for updates');
  await expect(check).toBeEnabled();
  await execute('docker',['cp',saved,container+':'+target]);
  await check.click();await expect(updates.getByRole('status')).toHaveText('Up to date');
  await execute('docker',['cp',changed,container+':'+target]);
  await check.click();await expect(updates.getByRole('status')).toHaveText('Update available');
  await expect(page.getByRole('dialog',{name:'Settings',exact:true})).toBeVisible();
  // Closing Settings must retain the ready update, with no automatic reload.
  await settings.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  const reload=updates.getByRole('button',{name:'Reload to update',exact:true});
  await expect(reload).toBeVisible();await reload.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('settings-update-ready.png')});
  const box=(await reload.boundingBox())!,viewport=page.viewportSize()!;
  expect(box.height).toBeGreaterThanOrEqual(44);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);

  await expect(page.locator('.connection-banner')).toContainText('Update available');
  // Applying in another window must not make this older document claim it is current.
  const other=await page.context().newPage();
  try{
   await other.goto('/');
   const target=await other.evaluateHandle(async()=>{
    const registration=await navigator.serviceWorker.getRegistration();
    if(!registration?.waiting)throw new Error('Ready update worker is missing');
    return registration.waiting;
   });
   try{
    await target.evaluate(worker=>worker.postMessage('activate-update'));
    try{await expect.poll(()=>target.evaluate(worker=>worker.state)).toBe('activated')}
    catch(error){
     const states=await target.evaluate(async worker=>{const registration=await navigator.serviceWorker.getRegistration();return {target:worker.state,targetIsWaiting:worker===registration?.waiting,active:registration?.active?.state,waiting:registration?.waiting?.state,installing:registration?.installing?.state,controller:navigator.serviceWorker.controller?.state}});
     await info.attach('service-worker-activation',{body:JSON.stringify(states),contentType:'application/json'});throw error;
    }
   }finally{await target.dispose()}
   await page.bringToFront();
   await expect.poll(()=>page.evaluate(async()=>!(await navigator.serviceWorker.getRegistration())!.waiting)).toBe(true);
   await check.click();await expect(updates.getByRole('status')).toHaveText('Update available');
  }finally{await other.close()}

  await Promise.all([page.waitForEvent('load'),reload.click()]);
  await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Reload to update',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await check.click();await expect(updates.getByRole('status')).toHaveText('Up to date');
  await expect.poll(()=>page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();return {active:registration?.active?.state,waiting:!!registration?.waiting,controlled:!!navigator.serviceWorker.controller}})).toEqual({active:'activated',waiting:false,controlled:true});
 }finally{
  await execute('docker',['cp',saved,container+':'+target]);await rm(directory,{recursive:true,force:true});
 }
});
