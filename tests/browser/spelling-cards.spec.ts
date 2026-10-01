import {test,expect} from './fixtures';
import type {TextItem} from '../../web/src/api';
import {muteTestOutput} from './audio-output';

test('same-reading kanji spellings open separate canonical cards and learn independently',async({page,request,baseURL},info)=>{
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);expect(new URL(baseURL!).protocol).toBe('https:');
 await muteTestOutput(page);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const response=await request.post('/api/v1/imports',{data:{title:'Spelling card acceptance',body:'速く走ります。早く起きます。'}});expect(response.ok()).toBe(true);
 const submitted=await response.json();let id=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();expect(job.state,job.error).not.toBe('failed');id=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 const text=await(await request.get('/api/v1/texts/'+id)).json() as TextItem;
 const speed=text.sentences.flatMap(s=>s.tokens).find(t=>t.surface==='速く')!,early=text.sentences.flatMap(s=>s.tokens).find(t=>t.surface==='早く')!;
 expect(speed.base).toBe('速い');expect(early.base).toBe('早い');expect(speed.baseId).not.toBe(early.baseId);
 for(const token of [speed,early])expect((await request.put('/api/v1/words/'+token.baseId+'/status',{data:{state:'new'}})).ok()).toBe(true);
 await page.goto('/#'+id);await expect(page.locator('.reader')).toBeVisible();expect(await page.evaluate(()=>isSecureContext)).toBe(true);
 for(const token of [speed,early]){
  await page.locator(`[data-token-id="${token.id}"]`).tap();const panel=page.getByRole('dialog',{name:'Word details'});
  await expect(panel.locator('.word-title h2')).toContainText(token.base);
  await expect(panel.getByRole('group',{name:'Learning Status'}).getByRole('button',{name:'Learning',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>new URL(a.src).searchParams.get('text'))).toBe(token.base);
  await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.ended&&a.currentTime>0),{timeout:90_000}).toBe(true);
  if(token===speed){expect((await(await request.get('/api/v1/words/'+early.baseId)).json()).status.state).toBe('new');await page.screenshot({path:`test-results/${info.project.name}-spelling-card.png`})}
  await panel.getByRole('button',{name:'Close word details'}).tap();
 }
 expect((await(await request.get('/api/v1/words/'+speed.baseId)).json()).status.state).toBe('learning');
 expect((await(await request.get('/api/v1/words/'+early.baseId)).json()).status.state).toBe('learning');
 expect(errors).toEqual([]);
});
