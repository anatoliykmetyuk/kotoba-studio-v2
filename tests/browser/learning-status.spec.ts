import {test,expect,type APIRequestContext} from './fixtures';
import type {TextItem} from '../../web/src/api';
import {muteTestOutput} from './audio-output';

async function fixture(request:APIRequestContext){
 const submitted=await(await request.post('/api/v1/imports',{data:{title:'Unified status acceptance',body:'猫は寝ます。\n犬は走ります。\n鳥は飛びます。\n魚は泳ぎます。'}})).json();let id=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();expect(job.state,job.error).not.toBe('failed');id=job.result.textId;return job.state},{timeout:120_000}).toBe('ready');
 const text=await(await request.get('/api/v1/texts/'+id)).json() as TextItem;
 for(const base of new Set(text.sentences.flatMap(s=>s.tokens.map(w=>w.baseId))))expect((await request.put('/api/v1/words/'+base+'/status',{data:{state:'new'}})).ok()).toBeTruthy();
 const bySurface=(surface:string)=>text.sentences.flatMap(s=>s.tokens).find(w=>w.surface===surface)!;
 for(const [surface,state] of [['猫','learning'],['犬','familiar'],['鳥','known']])expect((await request.put('/api/v1/words/'+bySurface(surface).baseId+'/status',{data:{state}})).ok()).toBeTruthy();
 return {text,bySurface};
}

test('one Learning Status controls highlights, persists, and filters both lesson exercises',async({page,request},info)=>{
 await muteTestOutput(page);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const {text,bySurface}=await fixture(request);
 await page.goto('/#'+text.id);await expect(page.locator('.reader')).toBeVisible();
 const fish=bySurface('魚');await page.locator(`[data-token-id="${fish.id}"]`).tap();
 const panel=page.getByRole('dialog',{name:'Word details'}),group=panel.getByRole('group',{name:'Learning Status'});
 await expect(group).toHaveCount(1);await expect(group.getByRole('button',{name:'Learning',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(panel.getByRole('group',{name:/reading status|listening status/i})).toHaveCount(0);
 await group.getByRole('button',{name:'Known',exact:true}).tap();await expect(group.getByRole('button',{name:'Known',exact:true})).toHaveAttribute('aria-pressed','true');
 await panel.getByRole('button',{name:'Close word details'}).tap();await page.reload();
 await expect(page.locator(`[data-token-id="${fish.id}"]`)).toHaveClass(/known/);
 const pool=await(await request.get('/api/v1/practice?textId='+text.id)).json();
 expect(new Set(pool.words.map((w:{base:string})=>w.base))).toEqual(new Set(['猫','犬']));
 expect(pool.sentences).toHaveLength(2);expect(pool.sentences.every((s:{words:{state:string}[]})=>s.words.some(w=>['learning','familiar'].includes(w.state)))).toBe(true);
 await page.locator('.reader-finish').getByRole('button',{name:'Practice',exact:true}).tap();
 await expect(page.getByLabel('Include all statuses')).toHaveCount(0);
 for(let question=1;question<=2;question++){
  await expect(page.locator('.practice-progress')).toContainText(`Question ${question} of 2`);
  const base=await page.locator('.practice-card h2').innerText();const word=pool.words.find((w:{base:string})=>w.base===base);
  expect(word).toBeTruthy();await page.locator('.answer-grid').getByRole('button',{name:word.meaning,exact:true}).tap();
  if(question===1)await expect(page.locator('.practice-progress')).toContainText('Question 2 of 2');
 }
 await expect(page.getByRole('heading',{name:'Practice complete'})).toBeVisible();
 await page.getByRole('button',{name:'Practice again',exact:true}).tap();await expect(page.locator('.practice-progress')).toContainText('Question 1 of 2');
 await page.getByRole('button',{name:'Build a sentence',exact:true}).tap();await expect(page.locator('.pieces button').first()).toBeVisible();
 await expect(page.locator('.practice-progress')).toContainText('Question 1 of 2');
 const pieces=await page.locator('.pieces button').evaluateAll(buttons=>buttons.sort((a,b)=>Number((a as HTMLElement).dataset.piece)-Number((b as HTMLElement).dataset.piece)).map(b=>b.textContent).join(''));
 expect(pool.sentences.some((s:{body:string})=>s.body===pieces)).toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:`test-results/${info.project.name}-unified-status-practice.png`});
 expect(errors).toEqual([]);
});
