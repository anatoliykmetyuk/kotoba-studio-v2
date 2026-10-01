import {test,expect,type APIRequestContext,type Page} from './fixtures';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {pauseAcceptanceWorker} from './acceptance-worker';
import type {ExistingFolder} from '../../web/src/import-filing';
const execute=promisify(execFile);

test.beforeEach(async({baseURL})=>{
 test.skip(process.env.KOTOBA_FOLDER_SELECTOR!=='1','Requires exclusive access to the isolated acceptance API and native worker.');
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);
 const labels=JSON.parse((await execute('docker',['inspect','--format','{{json .Config.Labels}}','kotoba-v2-acceptance-api-1'])).stdout);
 expect(labels['com.docker.compose.project']).toBe('kotoba-v2-acceptance');
});

async function createFolder(request:APIRequestContext,folder:ExistingFolder={id:randomUUID(),name:'Folder selector '+randomUUID()}){
 const response=await request.post('/api/v1/graph/transaction',{data:{statements:[{query:'CREATE (f:Entity:Folder) SET f=$properties RETURN f.id',params:{properties:{...folder,identityKey:'folder-selector:'+folder.id,revision:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}}]}});
 expect(response.ok(),await response.text()).toBe(true);return folder;
}
async function deleteFolder(request:APIRequestContext,folder:ExistingFolder){
 const response=await request.post('/api/v1/graph/transaction',{data:{statements:[{query:'MATCH (f:Folder {id:$id}) DETACH DELETE f',params:{id:folder.id}}]}});expect(response.ok()).toBe(true);
}
async function foldersOf(request:APIRequestContext,textId:string){
 const texts=await(await request.get('/api/v1/texts')).json();return texts.find((text:{id:string})=>text.id===textId)?.folders?.map((folder:ExistingFolder)=>folder.id)??[];
}
async function openImport(page:Page,folder:ExistingFolder|null,title='Folder selector '+randomUUID()){
 await page.getByRole('button',{name:'Import text',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Import text',exact:true});
 await dialog.getByLabel('Title',{exact:true}).fill(title);await dialog.getByLabel('Japanese text',{exact:true}).fill('猫は庭を歩きます。\n'+title);
 const selector=dialog.getByRole('combobox',{name:'Folder',exact:true});await expect(selector).toBeEnabled();await expect(dialog.getByRole('textbox',{name:'Folder',exact:true})).toHaveCount(0);
 if(folder)await selector.selectOption(folder.id);else await selector.selectOption('');return dialog;
}
async function savedText(request:APIRequestContext,result:{textId?:string;jobId?:string}){
 if(result.textId)return result.textId;
 let textId='';await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+result.jobId)).json();expect(job.state,job.error).not.toBe('failed');textId=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');return textId;
}

test('existing and empty folders can be selected; metadata and revisions file separately without moving the original',async({page,request},info)=>{
 const first=await createFolder(request),second=await createFolder(request);
 try{
  await page.goto('/');const dialog=await openImport(page,first);
  for(const folder of [first,second])await expect(dialog.getByRole('combobox',{name:'Folder',exact:true}).locator('option').filter({hasText:folder.name})).toHaveAttribute('value',folder.id);
  await page.screenshot({path:info.outputPath('folder-selector.png')});
  const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
  await dialog.getByRole('button',{name:'Import & read',exact:true}).click();const accepted=await response;expect(accepted.ok()).toBe(true);
  expect(accepted.request().postDataJSON()).not.toHaveProperty('folder');expect(accepted.request().postDataJSON()).not.toHaveProperty('folderId');
  const textId=await savedText(request,await accepted.json());await expect.poll(()=>foldersOf(request,textId)).toEqual([first.id]);
  await expect(page.locator('.reader')).toHaveAttribute('data-text-id',textId);const original=await(await request.get('/api/v1/texts/'+textId)).json();
  await page.getByRole('button',{name:'Text options',exact:true}).click();await page.getByRole('button',{name:'Edit text',exact:true}).click();
  const edit=page.getByRole('dialog',{name:'Edit text',exact:true});await expect(edit.getByRole('combobox',{name:'Folder',exact:true})).toHaveValue(first.id);
  await edit.getByLabel('Title',{exact:true}).fill(original.title+' edited');await edit.getByRole('combobox',{name:'Folder',exact:true}).selectOption(second.id);
  await edit.getByRole('button',{name:'Save revision',exact:true}).click();await expect(edit).toHaveCount(0);
  await expect.poll(async()=>[...await foldersOf(request,textId)].sort()).toEqual([first.id,second.id].sort());
  const metadata=await(await request.get('/api/v1/texts/'+textId)).json();expect(metadata.body).toBe(original.body);expect(metadata.cursor).toBe(original.cursor);
  await page.getByRole('button',{name:'Text options',exact:true}).click();await page.getByRole('button',{name:'Edit text',exact:true}).click();
  await edit.getByLabel('Japanese text',{exact:true}).fill(original.body+'\n犬は水を飲みます。');await edit.getByRole('combobox',{name:'Folder',exact:true}).selectOption(second.id);
  const revisionResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');await edit.getByRole('button',{name:'Save revision',exact:true}).click();
  const revisionId=await savedText(request,await(await revisionResponse).json());expect(revisionId).not.toBe(textId);await expect.poll(()=>foldersOf(request,revisionId)).toEqual([second.id]);
  expect((await(await request.get('/api/v1/texts/'+textId)).json()).body).toBe(original.body);expect([...await foldersOf(request,textId)].sort()).toEqual([first.id,second.id].sort());
  await expect(page.locator('.reader')).toHaveAttribute('data-text-id',revisionId);
  await page.locator('.reader-toolbar').getByRole('button',{name:'Library',exact:true}).click();const unfiled=await openImport(page,null);
  const unfiledResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');await unfiled.getByRole('button',{name:'Import & read',exact:true}).click();
  const unfiledId=await savedText(request,await(await unfiledResponse).json());expect(await foldersOf(request,unfiledId)).toEqual([]);
 }finally{await deleteFolder(request,first);await deleteFolder(request,second)}
});

test('filing survives closing and reloading a queued import, including an immediate duplicate result',async({page,request})=>{
 const first=await createFolder(request),second=await createFolder(request);let resumeWorker:()=>void=()=>{};
 try{
  await page.goto('/');resumeWorker=await pauseAcceptanceWorker();const dialog=await openImport(page,first);
  const title=await dialog.getByLabel('Title',{exact:true}).inputValue(),body=await dialog.getByLabel('Japanese text',{exact:true}).inputValue();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
  await dialog.evaluate(element=>{element.querySelector('form')!.requestSubmit();element.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()});
  const result=await(await response).json();expect(result.jobId).toBeTruthy();await expect(dialog).toHaveCount(0);
  await expect.poll(()=>page.evaluate(()=>Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)).filter(key=>key?.startsWith('kotoba:import-filing:')).length)).toBe(1);
  await page.reload();await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();resumeWorker();
  const textId=await savedText(request,result);await expect.poll(()=>foldersOf(request,textId)).toEqual([first.id]);expect(new URL(page.url()).hash).toBe('');
  const duplicate=await openImport(page,second,title);await duplicate.getByLabel('Japanese text',{exact:true}).fill(body);
  const duplicateResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
  await duplicate.evaluate(element=>{element.querySelector('form')!.requestSubmit();element.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()});
  expect((await(await duplicateResponse).json()).textId).toBe(textId);await expect.poll(async()=>[...await foldersOf(request,textId)].sort()).toEqual([first.id,second.id].sort());expect(new URL(page.url()).hash).toBe('');
 }finally{resumeWorker();await deleteFolder(request,first);await deleteFolder(request,second)}
});

for(const storageFailure of [false,true])test(storageFailure?'readable browser storage with failed writes retains in-memory filing and retry':'filing failure preserves the saved lesson and retries only folder assignment',async({page,request})=>{
 const folder=await createFolder(request);let resumeWorker:()=>void=()=>{};
 try{
  if(storageFailure)await page.addInitScript(()=>{
   localStorage.setItem('kotoba:import-filing','[]');const write=Storage.prototype.setItem;
   Storage.prototype.setItem=function(key,value){if(key==='kotoba:import-filing'||key.startsWith('kotoba:import-filing:'))throw new DOMException('Fixture quota exceeded','QuotaExceededError');return write.call(this,key,value)};
  });
  await page.goto('/');resumeWorker=await pauseAcceptanceWorker();const dialog=await openImport(page,folder);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'Import & read',exact:true}).click();const result=await(await response).json();
  await deleteFolder(request,folder);resumeWorker();const textId=await savedText(request,result);await expect(page.locator('.reader')).toHaveAttribute('data-text-id',textId);
  const failure=page.getByRole('alert').filter({hasText:'Folder assignment failed.'});await expect(failure).toBeVisible();expect(await foldersOf(request,textId)).toEqual([]);
  if(storageFailure)expect(await page.evaluate(()=>localStorage.getItem('kotoba:import-filing'))).toBe('[]');
  const saved=await(await request.get('/api/v1/texts/'+textId)).json();let repeatedImports=0;page.on('request',r=>{if(r.url().endsWith('/api/v1/imports')&&r.method()==='POST')repeatedImports++});
  await createFolder(request,folder);await failure.getByRole('button',{name:'Retry folder assignment',exact:true}).click();await expect.poll(()=>foldersOf(request,textId)).toEqual([folder.id]);await expect(failure).toHaveCount(0);
  expect(repeatedImports).toBe(0);const recovered=await(await request.get('/api/v1/texts/'+textId)).json();expect(recovered.body).toBe(saved.body);expect(recovered.cursor).toBe(saved.cursor);expect(recovered.textState).toBe(saved.textState);
 }finally{resumeWorker();await deleteFolder(request,folder)}
});

test('Library Retry resumes a failed import and automatically completes its pending folder assignment',async({page,request})=>{
 const folder=await createFolder(request);let resumeWorker:()=>void=()=>{};
 try{
  await page.goto('/');resumeWorker=await pauseAcceptanceWorker();const dialog=await openImport(page,folder);const title=await dialog.getByLabel('Title',{exact:true}).inputValue();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'Import & read',exact:true}).click();const result=await(await response).json();expect(result.jobId).toBeTruthy();
  const failed=await request.post('/api/v1/graph/transaction',{data:{statements:[{query:'MATCH (j:Job {id:$id}) SET j.jobState=$state, j.error=$error',params:{id:result.jobId,state:'failed',error:'Fixture transient import failure'}}]}});expect(failed.ok()).toBe(true);
  await expect(dialog.getByRole('alert')).toContainText('Fixture transient import failure');await dialog.getByRole('button',{name:'Close',exact:true}).click();
  const waiting=page.getByRole('alert').filter({hasText:'Folder assignment is waiting for the import.'});await expect(waiting).toBeVisible();
  const retryResponse=page.waitForResponse(r=>r.url().endsWith('/api/v1/jobs/'+result.jobId+'/retry')&&r.request().method()==='POST');await page.locator('.job-card').filter({hasText:title}).getByRole('button',{name:'Retry',exact:true}).click();expect((await retryResponse).ok()).toBe(true);
  resumeWorker();const textId=await savedText(request,result);await expect.poll(()=>foldersOf(request,textId)).toEqual([folder.id]);await expect(waiting).toHaveCount(0);
 }finally{resumeWorker();await deleteFolder(request,folder)}
});

test('two service-worker-controlled tabs retain both accepted folder assignments before storage events and after reload',async({page,context,request,baseURL},info)=>{
 expect(new URL(baseURL!).protocol).toBe('https:');
 const first=await createFolder(request),second=await createFolder(request),other=await context.newPage();let resumeWorker:()=>void=()=>{};
 try{
  for(const tab of [page,other]){
   // Delay cross-tab delivery deterministically while each independent tab
   // accepts an import. The actual localStorage and network stay unmodified.
   await tab.addInitScript(()=>window.addEventListener('storage',event=>{if(event.key?.startsWith('kotoba:import-filing'))event.stopImmediatePropagation()},true));
   await tab.goto('/');expect(await tab.evaluate(()=>isSecureContext)).toBe(true);await tab.evaluate(()=>navigator.serviceWorker.ready);await tab.reload();
   await expect.poll(()=>tab.evaluate(()=>!!navigator.serviceWorker.controller)).toBe(true);
  }
  resumeWorker=await pauseAcceptanceWorker();
  const firstDialog=await openImport(page,first),secondDialog=await openImport(other,second);
  const submit=async(tab:Page,dialog:ReturnType<Page['getByRole']>)=>{
   const response=tab.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
   await dialog.evaluate(element=>{element.querySelector('form')!.requestSubmit();element.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()});
   return (await response).json() as Promise<{jobId:string}>;
  };
  const results=await Promise.all([submit(page,firstDialog),submit(other,secondDialog)]);
  for(const result of results)expect(result.jobId).toBeTruthy();
  await expect.poll(()=>page.evaluate(()=>Array.from({length:localStorage.length},(_,index)=>localStorage.key(index)).filter(key=>key?.startsWith('kotoba:import-filing:')).length)).toBe(2);
  await Promise.all([page.reload(),other.reload()]);resumeWorker();
  const textIds=await Promise.all(results.map(result=>savedText(request,result)));
  await expect.poll(()=>foldersOf(request,textIds[0])).toEqual([first.id]);await expect.poll(()=>foldersOf(request,textIds[1])).toEqual([second.id]);
  for(const [index,tab] of [page,other].entries()){
   expect(new URL(tab.url()).hash).toBe('');await expect(tab.getByRole('alert').filter({hasText:'Folder assignment failed.'})).toHaveCount(0);
   expect(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await tab.screenshot({path:info.outputPath('concurrent-filing-tab-'+index+'.png')});
  }
 }finally{resumeWorker();await other.close();await deleteFolder(request,first);await deleteFolder(request,second)}
});
