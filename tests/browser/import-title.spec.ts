import {test,expect} from './fixtures';
import {randomUUID} from 'node:crypto';

test('blank title imports generate a short title and preserve duplicate lessons',async({page,request,baseURL},info)=>{
 test.setTimeout(240_000);
 test.skip(process.env.KOTOBA_IMPORT_TITLES!=='1','Requires isolated acceptance services and local model.');
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);
 expect(new URL(baseURL!).port).toBe('8443');
 const body='猫は窓のそばで眠っています。庭では鳥が歌っています。\nFixture '+randomUUID();
 await page.goto('/');
 await page.evaluate(()=>{
  for(const [name,value] of Object.entries({top:24,bottom:20,left:12,right:12}))document.documentElement.style.setProperty('--safe-'+name,value+'px');
 });
 await page.getByRole('button',{name:'Import text',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Import text',exact:true});
 const title=dialog.getByRole('textbox',{name:'Title',exact:true});
 await expect(title).not.toHaveAttribute('required','');
 await title.fill('   ');
 await dialog.getByRole('textbox',{name:'Japanese text',exact:true}).fill(body);
 const button=dialog.getByRole('button',{name:'Import & read',exact:true});
 await expect(button).toBeEnabled();
 await page.screenshot({path:info.outputPath('blank-title-form.png')});
 const accepted=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
 await button.click();const response=await accepted;expect(response.status()).toBe(202);
 const {jobId}=await response.json();expect(jobId).toBeTruthy();
 let id='';
 await expect.poll(async()=>{
  const job=await(await request.get('/api/v1/jobs/'+jobId)).json();
  expect(job.state,job.error).not.toBe('failed');id=job.result.textId;return job.state;
 },{timeout:210_000}).toBe('ready');
 await expect(page.locator('.reader')).toHaveAttribute('data-text-id',id);
 const text=await(await request.get('/api/v1/texts/'+id)).json();
 expect(text.body).toBe(body);expect(text.title.trim()).toBe(text.title);
 expect(text.title.length).toBeGreaterThan(0);expect(text.title.length).toBeLessThanOrEqual(30);
 await expect(page.locator('.reader-heading h1')).toHaveText(text.title);
 await page.screenshot({path:info.outputPath('generated-title-reader.png')});
 const duplicate=await request.post('/api/v1/imports',{data:{body}});
 expect(duplicate.status()).toBe(202);expect(await duplicate.json()).toEqual({textId:id,duplicate:true});
 expect((await(await request.get('/api/v1/texts/'+id)).json()).title).toBe(text.title);
});
