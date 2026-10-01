import {test,expect,type APIRequestContext,type Page} from './fixtures';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {pauseAcceptanceWorker} from './acceptance-worker';
import type {Job,TextItem} from '../../web/src/api';

const execute=promisify(execFile);

test.beforeEach(async({baseURL})=>{
 test.skip(process.env.KOTOBA_IMPORT_LIFECYCLE!=='1','Requires exclusive access to the isolated acceptance API and native worker.');
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);
 const labels=JSON.parse((await execute('docker',['inspect','--format','{{json .Config.Labels}}','kotoba-v2-acceptance-api-1'])).stdout);
 expect(labels['com.docker.compose.project']).toBe('kotoba-v2-acceptance');
});


async function submitImport(page:Page,title:string,body:string){
 await page.getByRole('button',{name:'Import text',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Import text',exact:true});
 await dialog.getByRole('textbox',{name:'Title',exact:true}).fill(title);
 await dialog.getByRole('textbox',{name:'Japanese text',exact:true}).fill(body);
 await dialog.getByRole('combobox',{name:'Folder',exact:true}).selectOption('');
 const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
 await dialog.getByRole('button',{name:'Import & read',exact:true}).click();
 const accepted=await response;expect(accepted.ok()).toBe(true);
 return accepted.json() as Promise<{jobId?:string;textId?:string}>;
}

async function completedJob(request:APIRequestContext,jobId:string){
 let job:Job|undefined;
 await expect.poll(async()=>{
  const response=await request.get('/api/v1/jobs/'+jobId);expect(response.ok()).toBe(true);
  job=await response.json() as Job;expect(job.state,job.error).not.toBe('failed');return job.state;
 },{timeout:90_000}).toBe('ready');
 return job!;
}

test('dismissed import stops polling, preserves a new draft, and refreshes Library on completion',async({page,request},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/');await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
 const resumeWorker=await pauseAcceptanceWorker();
 try{
  const unique=randomUUID(),title='Detached import '+unique;
  let jobId='',detailRequests=0;
  page.on('request',request=>{if(jobId&&new URL(request.url()).pathname==='/api/v1/jobs/'+jobId)detailRequests++});
  const submitted=await submitImport(page,title,'猫は窓のそばで眠っています。\nDetached import '+unique);
  expect(submitted.jobId).toBeTruthy();jobId=submitted.jobId!;
  const dialog=page.getByRole('dialog',{name:'Import text',exact:true});
  await expect(dialog.getByRole('status')).toContainText('Queued');
  detailRequests=0;await page.waitForTimeout(2300);
  // One job observer polls once a second, without a parallel waitJob loop.
  expect(detailRequests).toBeGreaterThanOrEqual(2);expect(detailRequests).toBeLessThanOrEqual(3);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(dialog).toHaveCount(0);detailRequests=0;
  await page.getByRole('button',{name:'Import text',exact:true}).click();
  await dialog.getByRole('textbox',{name:'Title',exact:true}).fill('Next import draft');
  await dialog.getByRole('textbox',{name:'Japanese text',exact:true}).fill('犬は庭を歩きます。');
  await page.waitForTimeout(1300);expect(detailRequests).toBe(0);
  resumeWorker();const completed=await completedJob(request,jobId);
  await expect(page.locator('.text-card').filter({hasText:title})).toHaveCount(1);
  await expect(dialog).toBeVisible();await expect(dialog.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Next import draft');
  await expect(dialog.getByRole('textbox',{name:'Japanese text',exact:true})).toHaveValue('犬は庭を歩きます。');
  expect(new URL(page.url()).hash).toBe('');expect(detailRequests).toBe(0);
  await page.screenshot({path:info.outputPath('import-completed-with-new-draft.png')});
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('.text-card').filter({hasText:title}).click();
  await expect(page.locator('.reader')).toHaveAttribute('data-text-id',completed.result.textId);
  expect(errors).toEqual([]);
 }finally{resumeWorker()}
});

test('active imports navigate, metadata edits reuse the text, and body edits create revisions',async({page,request})=>{
 const unique=randomUUID(),title='Active import '+unique,body='鳥は空を飛びます。\nActive import '+unique;
 await page.goto('/');
 const submitted=await submitImport(page,title,body);expect(submitted.jobId).toBeTruthy();
 const completed=await completedJob(request,submitted.jobId!);
 await expect(page.locator('.reader')).toHaveAttribute('data-text-id',completed.result.textId);
 await expect(page.locator('.reader-heading h1')).toHaveText(title);
 await page.getByRole('button',{name:'Text options',exact:true}).click();
 await page.getByRole('button',{name:'Edit text',exact:true}).click();
 const edit=page.getByRole('dialog',{name:'Edit text',exact:true}),editedTitle=title+' edited';
 await edit.getByRole('textbox',{name:'Title',exact:true}).fill(editedTitle);
 await edit.getByRole('combobox',{name:'Folder',exact:true}).selectOption('');
 await edit.getByRole('textbox',{name:'Source link optional',exact:true}).fill('https://example.com/import-lifecycle');
 const metadataResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
 await edit.getByRole('button',{name:'Save revision',exact:true}).click();
 expect((await(await metadataResponse).json()).textId).toBe(completed.result.textId);
 await expect(edit).toHaveCount(0);await expect(page.locator('.reader-heading h1')).toHaveText(editedTitle);
 const saved=await(await request.get('/api/v1/texts/'+completed.result.textId)).json() as TextItem;
 expect(saved.body).toBe(body);const library=await(await request.get('/api/v1/texts')).json() as TextItem[];expect(library.find(text=>text.id===saved.id)?.folders).toEqual([]);
 expect(saved.sources.some(source=>source.url==='https://example.com/import-lifecycle')).toBe(true);
 await page.getByRole('button',{name:'Text options',exact:true}).click();await page.getByRole('button',{name:'Edit text',exact:true}).click();
 const revisedBody=body+'\n犬は庭を歩きます。';
 await edit.getByRole('textbox',{name:'Japanese text',exact:true}).fill(revisedBody);
 const revisionResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
 await edit.getByRole('button',{name:'Save revision',exact:true}).click();
 const revision=await(await revisionResponse).json();expect(revision.jobId).toBeTruthy();
 const revised=await completedJob(request,revision.jobId);
 expect(revised.result.textId).not.toBe(completed.result.textId);
 await expect(page.locator('.reader')).toHaveAttribute('data-text-id',revised.result.textId);
 expect((await(await request.get('/api/v1/texts/'+revised.result.textId)).json()).body).toBe(revisedBody);
 expect((await(await request.get('/api/v1/texts/'+completed.result.textId)).json()).body).toBe(body);
 // Dismiss in the same browser turn as submission, before the real response can
 // resolve. A deduplicated import returns textId directly instead of a job ID.
 await page.locator('.reader-toolbar').getByRole('button',{name:'Library',exact:true}).click();
 await page.getByRole('button',{name:'Import text',exact:true}).click();
 const duplicate=page.getByRole('dialog',{name:'Import text',exact:true});
 await duplicate.getByRole('textbox',{name:'Title',exact:true}).fill(title);
 await duplicate.getByRole('textbox',{name:'Japanese text',exact:true}).fill(body);
 const duplicateResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
 await duplicate.evaluate(dialog=>{
  dialog.querySelector('form')!.requestSubmit();
  dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
 });
 expect((await(await duplicateResponse).json()).textId).toBe(completed.result.textId);
 await expect(duplicate).toHaveCount(0);
 await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
 expect(new URL(page.url()).hash).toBe('');
});
