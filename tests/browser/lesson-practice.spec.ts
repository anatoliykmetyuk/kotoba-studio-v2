import {test,expect,type APIRequestContext,type Page} from '@playwright/test';
import type {Example,TextItem} from '../../web/src/api';
import {muteTestOutput} from './audio-output';
import {pauseAcceptanceWorker} from './acceptance-worker';
test.beforeEach(async({page})=>muteTestOutput(page));

async function importLesson(request:APIRequestContext,title:string,body:string):Promise<TextItem>{
 const response=await request.post('/api/v1/imports',{data:{title,body,folder:'Acceptance'}});expect(response.ok()).toBeTruthy();
 const submitted=await response.json();let textId=submitted.textId;
 if(!textId)await expect.poll(async()=>{const job=await (await request.get('/api/v1/jobs/'+submitted.jobId)).json();expect(job.state,job.error).not.toBe('failed');textId=job.result.textId;return job.state},{timeout:120_000}).toBe('ready');
 const text=await (await request.get('/api/v1/texts/'+textId)).json();
 expect((await request.patch('/api/v1/texts/'+textId,{data:{archived:false}})).ok()).toBeTruthy();
 return text;
}
async function practicePool(request:APIRequestContext,textId:string){
 const response=await request.get('/api/v1/practice?'+new URLSearchParams({textId,states:'new,learning,familiar,known'}));
 expect(response.ok()).toBeTruthy();return response.json() as Promise<{words:Example['words'];sentences:Example[]}>;
}
async function enterPractice(page:Page,text:TextItem){
 await page.goto('/#'+text.id);await expect(page.locator('.reader')).toBeVisible();
 await page.locator('.reader-finish').getByRole('button',{name:'Practice',exact:true}).click();
 await expect(page.locator('.practice-page')).toHaveAttribute('data-text-id',text.id);
 await expect(page.locator('.practice-page .page-heading')).toContainText(text.title);
 await expect(page).toHaveURL(new RegExp('#'+text.id+'\\?mode=practice$'));
 await page.getByLabel('Include all statuses').check();
}

test('finish a lesson and practice only its words, distractors and prepared sentences',async({page,request},info)=>{
 test.setTimeout(240_000);
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const first=await importLesson(request,'Lesson practice animals','猫は魚を見ます。\n鳥は空を飛びます。');
 const second=await importLesson(request,'Lesson practice outdoors','犬と馬は山を歩きます。\n牛は草を食べます。');
 await request.patch('/api/v1/settings',{data:{area:'reading',theme:'light'}});
 await request.put('/api/v1/texts/'+first.id+'/status',{data:{state:'new'}});
 const pool=await practicePool(request,first.id),other=await practicePool(request,second.id);
 const lessonBases=new Set(first.sentences.flatMap(sentence=>sentence.tokens.map(word=>word.baseId)));
 expect(pool.words.length).toBeGreaterThan(3);expect(pool.words.every(word=>lessonBases.has(word.baseId))).toBeTruthy();
 expect(pool.sentences.every(sentence=>sentence.textId===first.id)).toBeTruthy();
 expect(other.words.some(word=>!lessonBases.has(word.baseId))).toBeTruthy();
 await page.goto('/');
 await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
 await expect(page.locator('nav').getByRole('button',{name:'Practice',exact:true})).toHaveCount(0);
 await page.goto('/#'+first.id);await expect(page.locator('.reader')).toBeVisible();
 await page.getByRole('button',{name:'Complete text',exact:true}).click();
 const confirmation=page.getByRole('dialog',{name:'Complete lesson',exact:true});
 await expect(confirmation).toBeVisible();
 const preview=await(await request.get('/api/v1/texts/'+first.id+'/completion')).json();
 await expect(confirmation).toContainText(String(preview.wordCount));
 await confirmation.getByRole('button',{name:'Cancel',exact:true}).click();
 expect((await(await request.get('/api/v1/texts/'+first.id)).json()).textState).toBe('new');
 await page.getByRole('button',{name:'Complete text',exact:true}).click();
 await expect(confirmation).toBeVisible();await confirmation.getByRole('button',{name:'Complete lesson',exact:true}).click();
 await expect(page.getByRole('button',{name:'Mark as New',exact:true})).toBeVisible();
 const completed=await (await request.get('/api/v1/texts/'+first.id)).json() as TextItem;
 expect(completed.textState).toBe('completed');
 await page.locator('.reader-finish').getByRole('button',{name:'Practice',exact:true}).click();
 await expect(page.locator('.practice-page')).toHaveAttribute('data-text-id',first.id);
 await page.getByLabel('Include all statuses').check();
 for(let round=0;round<3;round++){
  await expect(page.locator('.answer-grid button').first()).toBeVisible();
  const challenge=await page.locator('[data-challenge]').getAttribute('data-challenge');
  const base=await page.locator('.practice-card h2').innerText();const word=pool.words.find(word=>word.base===base);expect(word).toBeTruthy();
  const meanings=await page.locator('.answer-grid button').allTextContents();
  expect(meanings.every(meaning=>pool.words.some(word=>word.meaning===meaning))).toBeTruthy();
  await page.locator('.answer-grid').getByRole('button',{name:word!.meaning,exact:true}).click();
  await expect(page.locator('.practice-feedback')).toContainText('Correct');
  await expect(page.locator('[data-challenge]')).not.toHaveAttribute('data-challenge',challenge!);
 }
 await page.getByRole('button',{name:'Build a sentence',exact:true}).click();
 await expect(page.locator('.pieces button').first()).toBeVisible({timeout:150_000});
 await expect(page.locator('.sentence-translation')).toHaveAttribute('data-ready','true',{timeout:120_000});await expect(page.locator('.sentence-translation')).not.toBeEmpty();
 const assembled=await page.locator('.pieces button').evaluateAll(buttons=>buttons.sort((a,b)=>Number((a as HTMLElement).dataset.piece)-Number((b as HTMLElement).dataset.piece)).map(button=>button.textContent).join(''));
 expect(first.sentences.some(sentence=>sentence.body===assembled)).toBeTruthy();
 await page.screenshot({path:`test-results/${info.project.name}-lesson-practice.png`});
 await page.locator('audio').evaluate(audio=>{audio.dataset.played='false';audio.addEventListener('ended',()=>{audio.dataset.played='true'},{once:true})});
 await page.locator('.pieces [data-piece="0"]').tap();
 await expect(page.locator('audio')).toHaveAttribute('src',/^(blob:|\/api\/v1\/speech\/play\?)/);
 await expect(page.locator('audio')).toHaveAttribute('data-played','true',{timeout:60_000});
 expect(await page.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.currentTime)).toBeGreaterThan(0);
 const count=await page.locator('.pieces button').count();
 for(let index=1;index<count;index++)await page.locator(`.pieces [data-piece="${index}"]`).tap();
 await page.getByRole('button',{name:'Check sentence',exact:true}).click();
 await expect(page.locator('.practice-feedback')).toContainText('Correct');
 await page.getByRole('button',{name:'Back to lesson',exact:true}).click();
 await expect(page.locator('.reader')).toBeVisible();await expect(page).toHaveURL(new RegExp('#'+first.id+'$'));
 await enterPractice(page,second);
 await expect(page.locator('.answer-grid button').first()).toBeVisible();
 const secondBase=await page.locator('.practice-card h2').innerText();
 expect(other.words.some(word=>word.base===secondBase)).toBeTruthy();
 await page.reload();await expect(page.locator('.practice-page')).toHaveAttribute('data-text-id',second.id);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
 expect(errors).toEqual([]);
});

test('a small lesson keeps its own limited exercises and an empty lesson stays empty',async({page,request})=>{
 const single=await importLesson(request,'Lesson practice single word','桜。');
 await enterPractice(page,single);await expect(page.locator('.answer-grid button')).toHaveCount(1);
 await page.getByRole('button',{name:'Build a sentence',exact:true}).click();
 await expect(page.getByRole('heading',{name:'No matching sentences',exact:true})).toBeVisible();
 await expect(page.locator('.pieces button')).toHaveCount(0);
 const empty=await importLesson(request,'Lesson practice no vocabulary','Plain English only.');
 await enterPractice(page,empty);
 await expect(page.getByRole('heading',{name:'No matching words',exact:true})).toBeVisible();
 await expect(page.locator('.answer-grid button')).toHaveCount(0);
 await page.getByRole('button',{name:'Build a sentence',exact:true}).click();
 await expect(page.getByRole('heading',{name:'No matching sentences',exact:true})).toBeVisible();
});


test('sentence assembly stays fixed while the submitted answer is being graded',async({page,request,browserName})=>{
 test.skip(browserName!=='chromium','Uses Chromium transport latency, not mocked responses.');
 const text=await importLesson(request,'Sentence grading acceptance','猫は魚を見ます。\n鳥は空を飛びます。');
 await enterPractice(page,text);await page.getByRole('button',{name:'Build a sentence',exact:true}).click();
 await expect(page.locator('.pieces button').first()).toBeVisible({timeout:150_000});
 const count=await page.locator('.pieces button').count();
 for(let i=0;i<count;i++)await page.locator(`.pieces [data-piece="${i}"]`).click();
 const session=await page.context().newCDPSession(page);
 try{
  await session.send('Network.enable');await session.send('Network.emulateNetworkConditions',{offline:false,latency:1000,downloadThroughput:-1,uploadThroughput:-1});
  const graded=page.waitForResponse(r=>r.url().endsWith('/practice/answer'));await page.getByRole('button',{name:'Check sentence',exact:true}).click();
  await expect(page.locator('.sentence-answer button:not(:disabled)')).toHaveCount(0);
  await expect(page.locator('.pieces button:not(:disabled)')).toHaveCount(0);
  expect((await(await graded).json()).correct).toBe(true);await expect(page.locator('.practice-progress')).toContainText('Question 2 of 2');
 }finally{await session.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await session.detach()}
});

test('matching offers the primary dictionary meaning for 最後',async({page,request},info)=>{
 const text=await importLesson(request,'Primary meaning practice acceptance','最後。籠。接吻。譲り合う。');
 const pool=await practicePool(request,text.id),last=pool.words.find(word=>word.base==='最後');
 expect(last).toBeTruthy();expect(last!.meaning).toBe('end; conclusion');
 await enterPractice(page,text);
 for(let round=0;round<pool.words.length;round++){
  const heading=page.locator('.practice-card h2');await expect(heading).toBeVisible();
  const base=await heading.innerText(),word=pool.words.find(item=>item.base===base)!;
  const challenge=await page.locator('[data-challenge]').getAttribute('data-challenge');
  const answer=page.locator('.answer-grid').getByRole('button',{name:word.meaning,exact:true});await expect(answer).toBeVisible();
  if(base==='最後'){
   await expect(answer).toHaveText('end; conclusion');
   await page.screenshot({path:info.outputPath('last-primary-meaning.png')});
   await answer.click();await expect(page.locator('.practice-feedback')).toContainText('Correct');return;
  }
  await answer.click();await expect(page.locator('.practice-feedback')).toContainText('Correct');
  await expect(page.locator('[data-challenge]')).not.toHaveAttribute('data-challenge',challenge!);
 }
 throw new Error('The lesson did not present 最後 during its first practice cycle');
});

test('practice counts questions, retains wrong answers, and finishes each exercise once',async({page,request},info)=>{
 test.setTimeout(240_000);
 const text=await importLesson(request,'Finite matching acceptance','猫。鳥。'),pool=await practicePool(request,text.id);
 expect(pool.words).toHaveLength(2);await enterPractice(page,text);
 const progress=page.locator('.practice-progress');
 for(let round=0;round<2;round++){
  await expect(progress).toContainText(`Question ${round+1} of 2`);
  const base=await page.locator('.practice-card h2').innerText(),word=pool.words.find(item=>item.base===base)!;
  if(round===0){
   const wrong=pool.words.find(item=>item.base!==base)!;
   await page.locator('.answer-grid').getByRole('button',{name:wrong.meaning,exact:true}).click();
   await expect(page.locator('.practice-feedback')).toContainText('Incorrect');await expect(progress).toContainText('Question 1 of 2');
  }
  await page.locator('.answer-grid').getByRole('button',{name:word.meaning,exact:true}).click();
  await expect(page.locator('.practice-feedback')).toContainText('Correct');
 }
 await expect(page.getByRole('heading',{name:'Practice complete',exact:true})).toBeVisible();
 await expect(progress).toContainText('2 of 2 completed');await expect(page.locator('.answer-grid')).toHaveCount(0);
 await page.screenshot({path:info.outputPath('practice-complete.png')});
 await page.getByRole('button',{name:'Practice again',exact:true}).click();await expect(progress).toContainText('Question 1 of 2');
 const sentences=await importLesson(request,'Finite sentence acceptance','猫は魚を見ます。\n鳥は空を飛びます。');
 await enterPractice(page,sentences);await page.getByRole('button',{name:'Build a sentence',exact:true}).click();
 for(let round=0;round<2;round++){
  await expect(progress).toContainText(`Question ${round+1} of 2`);
  await expect(page.locator('.pieces button').first()).toBeVisible({timeout:150_000});
  const count=await page.locator('.pieces button').count();
  for(let i=0;i<count;i++)await page.locator(`.pieces [data-piece="${i}"]`).click();
  await page.getByRole('button',{name:'Check sentence',exact:true}).click();await expect(page.locator('.practice-feedback')).toContainText('Correct');
 }
 await expect(page.getByRole('heading',{name:'Practice complete',exact:true})).toBeVisible();await expect(progress).toContainText('2 of 2 completed');
 await page.getByRole('button',{name:'Practice again',exact:true}).click();await expect(progress).toContainText('Question 1 of 2');
 await expect(page.locator('.pieces button').first()).toBeVisible();await page.screenshot({path:info.outputPath('practice-question-count.png')});
});

test('rapid token taps place immediately and pronounce in sequence',async({page,request})=>{
 const text=await importLesson(request,'Queued token audio acceptance','猫は魚を見ます。');
 await enterPractice(page,text);await page.getByRole('button',{name:'Build a sentence',exact:true}).click();
 await expect(page.locator('.pieces button').first()).toBeVisible({timeout:150_000});
 await page.locator('audio').evaluate((audio:HTMLAudioElement)=>{
  audio.playbackRate=0.25;const events:{kind:string;src:string}[]=[];(window as any).__queuedAudio=events;
  for(const kind of ['playing','ended'])audio.addEventListener(kind,()=>events.push({kind,src:audio.currentSrc}));
 });
 await page.locator('.pieces [data-piece="0"]').tap();
 await expect.poll(()=>page.evaluate(()=>(window as any).__queuedAudio.filter((e:any)=>e.kind==='playing').length)).toBe(1);
 const first=await page.locator('audio').getAttribute('src');
 await page.locator('.pieces [data-piece="1"]').tap();await page.locator('.pieces [data-piece="2"]').tap();
 await expect(page.locator('.sentence-answer button')).toHaveCount(3);
 expect(await page.evaluate(()=>(window as any).__queuedAudio.filter((e:any)=>e.kind==='ended').length)).toBe(0);
 await expect(page.locator('audio')).toHaveAttribute('src',first!);
 await page.locator('audio').evaluate((audio:HTMLAudioElement)=>{audio.playbackRate=1});
 await expect.poll(()=>page.evaluate(()=>(window as any).__queuedAudio.filter((e:any)=>e.kind==='ended').length),{timeout:30_000}).toBe(3);
 const events=await page.evaluate(()=>(window as any).__queuedAudio as {kind:string;src:string}[]);
 expect(events.map(event=>event.kind)).toEqual(['playing','ended','playing','ended','playing','ended']);
 expect(new Set(events.filter(event=>event.kind==='playing').map(event=>event.src)).size).toBe(3);
});


test('sentence controls stay usable while translation and speech jobs are pending',async({page,request,baseURL},info)=>{
 test.skip(process.env.KOTOBA_IMPORT_LIFECYCLE!=='1','Requires exclusive access to the isolated acceptance worker.');
 expect(baseURL).toBe(process.env.KOTOBA_ACCEPTANCE_ORIGIN);
 const text=await importLesson(request,'Immediate sentence practice '+Date.now(),`猫は第${Date.now()}番の箱を見ます。`);
 const resume=await pauseAcceptanceWorker();
 try{
  const speech:string[]=[];page.on('request',r=>{if(r.url().includes('/speech'))speech.push(r.url())});
  await enterPractice(page,text);await page.getByRole('button',{name:'Build a sentence',exact:true}).click();
  await expect(page.locator('.pieces button').first()).toBeVisible();
  await expect(page.locator('.sentence-translation')).toHaveAttribute('data-ready','false');
  await expect(page.locator('.sentence-translation')).toContainText('Translating…');
  expect(speech).toHaveLength(0);
  const count=await page.locator('.pieces button').count();
  for(let i=0;i<count;i++)await page.locator(`.pieces [data-piece="${i}"]`).tap();
  await expect(page.locator('.sentence-answer button')).toHaveCount(count);
  await expect(page.locator('.sentence-translation')).toHaveAttribute('data-ready','false');
  await expect.poll(()=>speech.length).toBeGreaterThan(0);
  await page.screenshot({path:info.outputPath('practice-pending-translation.png')});
  await page.getByRole('button',{name:'Check sentence',exact:true}).click();await expect(page.locator('.practice-feedback')).toContainText('Correct');
  await expect(page.getByRole('heading',{name:'Practice complete',exact:true})).toBeVisible();
  expect(await page.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.paused)).toBe(true);
 }finally{resume()}
});

test('incorrect sentence offers a correct-answer hint only when explicitly opened',async({page,request},info)=>{
 const text=await importLesson(request,'Optional sentence hint acceptance','猫は魚を見ます。');
 await enterPractice(page,text);await page.getByRole('button',{name:'Build a sentence',exact:true}).click();
 await expect(page.locator('.pieces button').first()).toBeVisible();
 const count=await page.locator('.pieces button').count();
 for(let i=count-1;i>=0;i--)await page.locator(`.pieces [data-piece="${i}"]`).tap();
 await page.getByRole('button',{name:'Check sentence',exact:true}).click();await expect(page.locator('.practice-feedback')).toContainText('Incorrect');
 const hint=page.getByRole('button',{name:'Show correct sentence',exact:true});await expect(hint).toBeVisible();await expect(hint).toHaveAttribute('aria-expanded','false');
 await expect(page.locator('#practice-correct-sentence')).toHaveCount(0);
 await hint.click();await expect(page.locator('#practice-correct-sentence')).toHaveText(text.sentences[0].body);
 await page.screenshot({path:info.outputPath('optional-sentence-hint.png')});
 await page.getByRole('button',{name:'Hide correct sentence',exact:true}).click();await expect(page.locator('#practice-correct-sentence')).toHaveCount(0);
 await page.locator('.sentence-answer button').first().click();await expect(hint).toHaveCount(0);
});

test('resetting a sentence ignores an answer response from the previous attempt',async({page,request,browserName})=>{
 test.skip(browserName!=='chromium','Uses Chromium transport latency, not mocked responses.');
 const text=await importLesson(request,'Reset grading acceptance','猫は魚を見ます。');
 await enterPractice(page,text);const mode=page.getByRole('button',{name:'Build a sentence',exact:true});await mode.click();
 await expect(page.locator('.pieces button').first()).toBeVisible();
 const count=await page.locator('.pieces button').count();for(let i=0;i<count;i++)await page.locator(`.pieces [data-piece="${i}"]`).click();
 const session=await page.context().newCDPSession(page);
 try{
  await session.send('Network.enable');await session.send('Network.emulateNetworkConditions',{offline:false,latency:1000,downloadThroughput:-1,uploadThroughput:-1});
  const checked=page.waitForResponse(r=>r.url().endsWith('/practice/answer'));
  await page.getByRole('button',{name:'Check sentence',exact:true}).click();await expect(page.locator('.sentence-answer button:not(:disabled)')).toHaveCount(0);
  await mode.click();await checked;await page.waitForTimeout(1200);
  await expect(page.locator('.sentence-answer button')).toHaveCount(0);await expect(page.locator('.practice-feedback')).toHaveCount(0);
  await expect(page.locator('.practice-progress')).toContainText('Question 1 of 1');
 }finally{await session.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await session.detach()}
});
