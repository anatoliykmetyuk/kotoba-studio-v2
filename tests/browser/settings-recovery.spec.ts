import {test,expect} from '@playwright/test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

test('failed settings edits retry together without losing newer slider values',async({page,request,baseURL})=>{
 test.skip(process.env.KOTOBA_SETTINGS_OUTAGE!=='1','Requires exclusive access to the isolated acceptance API.');
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);
 const container='kotoba-v2-acceptance-api-1';
 const labels=JSON.parse((await execute('docker',['inspect','--format','{{json .Config.Labels}}',container])).stdout);
 expect(labels['com.docker.compose.project']).toBe('kotoba-v2-acceptance');
 expect((await request.patch('/api/v1/settings',{data:{fontSize:20,lineHeight:1.85,readerLayout:'book'}})).ok()).toBeTruthy();
 await page.goto('/');await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
 await page.locator('.top-actions').getByRole('button',{name:'Settings',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
 const size=dialog.getByRole('slider',{name:'Reading size',exact:true});
 const spacing=dialog.getByRole('slider',{name:'Line spacing',exact:true});
 try{
  await execute('docker',['stop','--time','2',container]);
  await size.focus();await size.press('ArrowRight');
  await expect(page.locator('.error[role="alert"]')).toBeAttached();
  await size.press('ArrowRight');await spacing.focus();await spacing.press('ArrowRight');
  await page.waitForTimeout(800);
  await expect(size).toHaveValue('22');await expect(spacing).toHaveValue('1.9');
 }finally{
  await execute('docker',['start',container]);
  await expect.poll(async()=>{try{return (await request.get('/api/v1/health')).ok()}catch{return false}},{timeout:60_000}).toBe(true);
 }
 await expect.poll(async()=>{try{return (await request.get('/api/v1/health')).ok()}catch{return false}},{timeout:60_000}).toBe(true);
 await dialog.getByRole('button',{name:'Close',exact:true}).click();
 await page.locator('.error[role="alert"]').getByRole('button',{name:'Retry',exact:true}).click();
 await expect.poll(async()=>{const saved=await (await request.get('/api/v1/settings')).json();return [saved.fontSize,saved.lineHeight]}).toEqual([22,1.9]);
 await page.reload();await page.locator('.top-actions').getByRole('button',{name:'Settings',exact:true}).click();
 await expect(size).toHaveValue('22');await expect(spacing).toHaveValue('1.9');
});
