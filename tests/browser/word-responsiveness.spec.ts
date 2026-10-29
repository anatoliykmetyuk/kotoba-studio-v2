import {test,expect,type APIRequestContext} from './fixtures';
import type {TextItem} from '../../web/src/api';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);

async function fixture(request:APIRequestContext){
 const submitted=await request.post('/api/v1/imports',{data:{title:'Word responsiveness acceptance',body:'猫は庭で遊びます。猫と犬は庭で遊びました。\n'.repeat(6)}});expect(submitted.ok()).toBe(true);
 const result=await submitted.json();let id=result.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+result.jobId)).json();expect(job.state,job.error).not.toBe('failed');id=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 const text=await(await request.get('/api/v1/texts/'+id)).json() as TextItem;
 const tokens=text.sentences.flatMap(sentence=>sentence.tokens).filter(token=>token.base==='遊ぶ');
 expect(new Set(tokens.map(token=>token.surface)).size).toBeGreaterThan(1);
 expect((await request.put('/api/v1/words/'+tokens[0].baseId+'/status',{data:{state:'new'}})).ok()).toBe(true);
 return {text,tokens};
}

test('word changes update the whole family without lesson reloads; examples load only on request',async({page,request,baseURL},info)=>{
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);
 const errors:string[]=[],reads:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const {text,tokens}=await fixture(request),token=tokens[0];
 await page.goto('/#'+text.id);await expect(page.locator('.book-body')).toBeVisible();
 await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
 await page.reload();await expect(page.locator('.book-body')).toBeVisible();
 const cdp=info.project.name.includes('chromium')?await page.context().newCDPSession(page):null;
 if(cdp)await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:24,left:12,right:12,bottom:20}});
 else await page.evaluate(()=>{for(const [key,value] of Object.entries({top:24,left:12,right:12,bottom:20}))document.documentElement.style.setProperty('--safe-'+key,value+'px')});
 page.on('request',r=>{if(r.method()==='GET'&&r.url().includes('/api/v1/'))reads.push(new URL(r.url()).pathname)});
 await page.locator(`[data-token-id="${token.id}"]`).tap();
 const panel=page.getByRole('dialog',{name:'Word details'}),group=panel.getByRole('group',{name:'Learning Status'});
 await expect(panel.locator('.word-meanings ol')).toBeVisible();
 await expect(group.getByRole('button',{name:'Learning',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect.poll(async()=>(await(await request.get('/api/v1/words/'+token.baseId)).json()).status.state).toBe('learning');
 await expect(panel.getByText('Saving status…',{exact:true})).toHaveCount(0);
 expect(reads.filter(path=>path==='/api/v1/words/'+token.baseId)).toHaveLength(1);
 expect(reads.some(path=>path.endsWith('/examples'))).toBe(false);
 expect(reads.filter(path=>path==='/api/v1/texts'||path==='/api/v1/texts/'+text.id)).toEqual([]);
 reads.length=0;
 // Issue several intentions in one event loop so the intermediate saves cannot
 // overwrite the latest click. Pure tests cover controlled failures and delays.
 await group.evaluate(group=>{for(const name of ['Known','Familiar','Known'])[...group.querySelectorAll('button')].find(button=>button.textContent===name)!.click()});
 await expect(group.getByRole('button',{name:'Known',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(panel.getByText('Saving status…',{exact:true})).toHaveCount(0);
 for(const occurrence of tokens)await expect(page.locator(`[data-token-id="${occurrence.id}"]`)).toHaveClass(/known/);
 expect(reads.filter(path=>path==='/api/v1/texts'||path==='/api/v1/texts/'+text.id||path==='/api/v1/words/'+token.baseId)).toEqual([]);
 await expect.poll(async()=>{
  return page.evaluate(async({id,base})=>{
   const cache=await caches.open('kotoba-read-cache-v2'),cached=await cache.match('/api/v1/texts/'+id);
   if(!cached)return false;
   const data=await cached.json();return data.sentences.flatMap((s:{tokens:{baseId:string;state:string}[]})=>s.tokens).filter((t:{baseId:string})=>t.baseId===base).every((t:{state:string})=>t.state==='known');
  },{id:text.id,base:token.baseId});
 }).toBe(true);
 await panel.getByRole('button',{name:'Show examples',exact:true}).tap();await expect(panel.locator('.example-link').first()).toBeVisible();
 expect(reads.filter(path=>path==='/api/v1/words/'+token.baseId+'/examples')).toHaveLength(1);
 await panel.getByRole('button',{name:'Hide examples',exact:true}).tap();await panel.getByRole('button',{name:'Show examples',exact:true}).tap();
 await expect(panel.locator('.example-link').first()).toBeVisible();expect(reads.filter(path=>path.endsWith('/examples'))).toHaveLength(1);
 expect(await panel.evaluate(el=>{const box=el.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth+1})).toBe(true);
 await page.screenshot({path:info.outputPath('word-response-examples.png')});
 await panel.locator('.example-link').filter({hasText:text.title}).first().tap();await expect(panel).toHaveCount(0);await expect(page.locator('.example-highlight')).toBeVisible();
 await page.reload();for(const occurrence of tokens)await expect(page.locator(`[data-token-id="${occurrence.id}"]`)).toHaveClass(/known/);
 const saved=await(await request.get('/api/v1/texts/'+text.id)).json();expect(saved.readingProgress).toBe(text.readingProgress);expect(saved.cursor).toBe(text.cursor);
 await cdp?.detach();expect(errors).toEqual([]);
});

test('a real API outage rolls status back and leaves acknowledged offline data intact',async({page,request,baseURL})=>{
 test.skip(process.env.KOTOBA_UI_OUTAGE!=='1','Requires exclusive acceptance API access.');
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);
 const {text,tokens}=await fixture(request),token=tokens[0];
 expect((await request.put('/api/v1/words/'+token.baseId+'/status',{data:{state:'familiar'}})).ok()).toBe(true);
 await page.goto('/#'+text.id);await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
 await page.reload();await expect(page.locator('.book-body')).toBeVisible();
 await page.locator(`[data-token-id="${token.id}"]`).tap();const panel=page.getByRole('dialog',{name:'Word details'}),group=panel.getByRole('group',{name:'Learning Status'});
 await expect(panel.locator('.word-meanings ol')).toBeVisible();
 try{
  await execute('.venv/bin/python',['-c',"from cli.main import compose; compose('acceptance',['stop','api'])"]);
  await group.getByRole('button',{name:'Known',exact:true}).tap();
  await expect(page.locator('.error')).toBeVisible();await expect(group.getByRole('button',{name:'Familiar',exact:true})).toHaveAttribute('aria-pressed','true');
  for(const occurrence of tokens)await expect(page.locator(`[data-token-id="${occurrence.id}"]`)).toHaveClass(/familiar/);
  const states=await page.evaluate(async id=>(await(await(await caches.open('kotoba-read-cache-v2')).match('/api/v1/texts/'+id))!.json()).sentences.flatMap((s:{tokens:{baseId:string;state:string}[]})=>s.tokens),text.id);
  expect(states.filter((t:{baseId:string})=>t.baseId===token.baseId).every((t:{state:string})=>t.state==='familiar')).toBe(true);
 }finally{await execute('.venv/bin/python',['-c',"from cli.main import compose,wait_ready; compose('acceptance',['start','api']); wait_ready('http://127.0.0.1:3011')"])}
 await group.getByRole('button',{name:'Known',exact:true}).tap();await expect(panel.getByText('Saving status…',{exact:true})).toHaveCount(0);
 await expect.poll(async()=>(await(await request.get('/api/v1/words/'+token.baseId)).json()).status.state).toBe('known');
});
