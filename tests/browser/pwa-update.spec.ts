import {test,expect} from '@playwright/test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const execute=promisify(execFile);
const origin=process.env.KOTOBA_TEST_BASE_URL??'https://localhost:8443';
test.use({baseURL:origin});

test('installed app exposes and activates a service worker update',async({page,baseURL})=>{
 test.skip(process.env.KOTOBA_PWA_UPDATE!=='1','Requires exclusive access to the isolated acceptance web container.');
 expect(baseURL).toBe(origin);
 const container='kotoba-v2-acceptance-web-1',target='/usr/share/nginx/html/sw.js';
 const labels=JSON.parse((await execute('docker',['inspect','--format','{{json .Config.Labels}}',container])).stdout);
 expect(labels['com.docker.compose.project']).toBe('kotoba-v2-acceptance');
 const original=(await execute('docker',['exec',container,'cat',target])).stdout;
 const directory=await mkdtemp(join(tmpdir(),'kotoba-pwa-update-'));
 const saved=join(directory,'original.js'),changed=join(directory,'changed.js');
 await writeFile(saved,original);await writeFile(changed,original+'\n// Acceptance update '+Date.now()+'\n');
 try{
  await page.goto('/');await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  await execute('docker',['cp',changed,container+':'+target]);
  await page.evaluate(async()=>{await(await navigator.serviceWorker.getRegistration())!.update()});
  await expect(page.locator('.connection-banner')).toContainText('Update available');
  await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Reload',exact:true}).click()]);
  await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Reload',exact:true})).toHaveCount(0);
  await expect.poll(()=>page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();return {active:registration?.active?.state,waiting:!!registration?.waiting,controlled:!!navigator.serviceWorker.controller}})).toEqual({active:'activated',waiting:false,controlled:true});
 }finally{
  await execute('docker',['cp',saved,container+':'+target]);await rm(directory,{recursive:true,force:true});
 }
});
