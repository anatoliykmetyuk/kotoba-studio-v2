import {test,expect} from './fixtures';
import type {TextItem} from '../../web/src/api';
const origin=process.env.KOTOBA_TEST_BASE_URL??'https://localhost:8443';
test.use({baseURL:origin});

test('mobile sheet, example destination, practice preparation, instant audio and PWA',async({page,request,context},info)=>{
 test.setTimeout(240_000);page.setDefaultTimeout(15_000);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const submitted=await (await request.post('/api/v1/imports',{data:{title:'Mobile correction fixture',body:'猫は寝る。\n犬は走る。\n鳥が飛ぶ。\n魚が泳ぐ。',folder:'Acceptance'}})).json();
 let textId=submitted.textId;
 if(!textId){await expect.poll(async()=>{const job=await (await request.get('/api/v1/jobs/'+submitted.jobId)).json();textId=job.result.textId;return job.state},{timeout:60_000}).toBe('ready')}
 try{
  await page.goto('/#'+textId);await expect(page.locator('.book-body')).toBeVisible();
  expect(await page.evaluate(()=>isSecureContext)).toBeTruthy();
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();await expect(page.locator('.book-body')).toBeVisible();
  const manifest=await (await request.get('/manifest.webmanifest')).json();expect(manifest.display).toBe('standalone');expect(manifest.icons.some((i:{purpose:string})=>i.purpose==='maskable')).toBeTruthy();
  const detail:TextItem=await (await request.get('/api/v1/texts/'+textId)).json();
  await page.locator(`[data-token-id="${detail.sentences[0].tokens[0].id}"]`).tap();
  const panel=page.getByLabel('Word details',{exact:true});await expect(panel).toBeVisible();
  await expect(panel.getByRole('group',{name:'Learning Status'})).toHaveCount(1);
  await expect(panel.locator('.word-meanings li').first()).toBeVisible();
  await panel.getByRole('button',{name:'Close word details'}).click();await expect(panel).toHaveCount(0);
  await page.locator(`[data-token-id="${detail.sentences[0].tokens[0].id}"]`).tap();
  await panel.locator('.example-link').filter({hasText:detail.title}).first().click();await expect(panel).toHaveCount(0);await expect(page.locator('.example-highlight')).toBeVisible();await expect(page.locator('.example-highlight')).toHaveCount(0,{timeout:5000});
  for(const base of new Set(detail.sentences.flatMap(s=>s.tokens.map(w=>w.baseId))))await request.put('/api/v1/words/'+base+'/status',{data:{state:'learning'}});
  await page.locator('.reader-finish').getByRole('button',{name:'Practice',exact:true}).click();await expect(page.getByLabel('Include all statuses')).toHaveCount(0);
  await expect(page.locator('.answer-grid button').first()).toBeVisible();
  const pool=(await (await request.get('/api/v1/practice?'+new URLSearchParams({textId,states:'new,learning,familiar,known'}))).json()).words;
  const orders=[];
  for(let i=0;i<4;i++){
   const challenge=await page.locator('[data-challenge]').getAttribute('data-challenge');orders.push((await page.locator('.answer-grid button').allTextContents()).join('|'));
   const word=await page.locator('.practice-card h2').textContent();const meaning=pool.find((w:{base:string})=>w.base===word).meaning;
   await page.locator('.answer-grid').getByRole('button',{name:meaning,exact:true}).click();await expect(page.locator('.practice-feedback')).toContainText('Correct');
   await expect(page.getByRole('button',{name:'Next',exact:true})).toHaveCount(0);await expect(page.locator('[data-challenge]')).not.toHaveAttribute('data-challenge',challenge!);
  }
  expect(new Set(orders).size).toBeGreaterThan(1);
  await page.getByRole('button',{name:'Build a sentence'}).click();
  await expect(page.locator('.pieces button').first()).toBeVisible({timeout:150_000});await expect(page.locator('.sentence-translation')).not.toBeEmpty();await expect(page.getByRole('button',{name:'Show English hint'})).toHaveCount(0);
  await page.screenshot({path:`test-results/${info.project.name}-prepared-practice.png`});
  await page.evaluate(()=>{(window as any).playDelay=null;document.querySelector('audio')!.addEventListener('playing',()=>{(window as any).playDelay=performance.now()-(window as any).tapTime},{once:true});(window as any).tapTime=performance.now()});
  await page.locator('.pieces button').first().tap();await expect.poll(()=>page.evaluate(()=>(window as any).playDelay),{timeout:3000}).not.toBeNull();
  expect(await page.evaluate(()=>(window as any).playDelay)).toBeLessThan(700);expect(await page.locator('audio').getAttribute('src')).toMatch(/^blob:/);
  const count=await page.locator('.pieces button').count();for(let i=0;i<count;i++){const selected=page.locator('.sentence-answer button');if(await selected.count())await selected.first().click()}
  for(let i=0;i<count;i++)await page.locator(`.pieces [data-piece="${i}"]`).tap();
  await page.getByRole('button',{name:'Check sentence'}).click();await expect(page.locator('.practice-feedback')).toContainText('Correct');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
  await page.goto('/#'+textId);await expect(page.locator('.book-body')).toBeVisible();
  if(info.project.use.browserName!=='webkit'){await context.setOffline(true);await page.reload();await expect(page.locator('.book-body')).toBeVisible();await expect(page.locator('.connection-banner')).toContainText('Offline');await context.setOffline(false);}
  expect(errors).toEqual([]);
 }finally{
  await context.setOffline(false);
 }
});
