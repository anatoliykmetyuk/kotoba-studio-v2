import {test,expect,type Locator,type Page} from './fixtures';
import type {TextItem} from '../../web/src/api';

// Chromium exercises the real mobile touch pipeline. WebKit has no remote touch
// dispatch API in Playwright, so the same DOM TouchEvents exercise its handlers.
async function gesture(page:Page,browserName:string,from:{x:number;y:number},to:{x:number;y:number},hold=0){
 if(browserName==='chromium'){
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
  if(hold)await page.waitForTimeout(hold);
  for(let i=1;i<=8;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*i/8,y:from.y+(to.y-from.y)*i/8}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
 }else{
  await page.evaluate(({from})=>{(window as any).touchTarget=document.elementFromPoint(from.x,from.y);const touch={identifier:1,clientX:from.x,clientY:from.y};const e=new Event('touchstart',{bubbles:true,cancelable:true});Object.assign(e,{touches:[touch],changedTouches:[touch]});(window as any).touchTarget.dispatchEvent(e)}, {from});
  if(hold)await page.waitForTimeout(hold);
  for(let i=1;i<=8;i++)await page.evaluate(({x,y})=>{const touch={identifier:1,clientX:x,clientY:y};const e=new Event('touchmove',{bubbles:true,cancelable:true});Object.assign(e,{touches:[touch],changedTouches:[touch]});(window as any).touchTarget.dispatchEvent(e)}, {x:from.x+(to.x-from.x)*i/8,y:from.y+(to.y-from.y)*i/8});
  await page.evaluate(()=>{const e=new Event('touchend',{bubbles:true,cancelable:true});Object.assign(e,{touches:[],changedTouches:[]});(window as any).touchTarget.dispatchEvent(e)});
 }
}

async function selectPhrase(page:Page,browserName:string,start:Locator,end:Locator){
 await end.scrollIntoViewIfNeeded();await start.scrollIntoViewIfNeeded();
 const a=(await start.boundingBox())!,b=(await end.boundingBox())!;
 const from={x:a.x+a.width/2,y:a.y+a.height/2},to={x:b.x+b.width/2,y:b.y+b.height/2};
 if(browserName==='chromium')await gesture(page,browserName,from,to,500);
 else{
  // Trusted mouse input retains WebKit media activation and must need no hold.
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up();
 }
}

test('base forms, Latin text, both learning areas, conditional swipe and transient phrase tools',async({page,request,browserName},info)=>{
 test.setTimeout(240_000);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{(window as any).mediaEvents=[];for(const name of ['play','playing','pause','ended','waiting','stalled','loadeddata','error','visibilitychange'])document.addEventListener(name,event=>{const a=document.querySelector('audio');if(a)(window as any).mediaEvents.push({event:event.type,time:a.currentTime,paused:a.paused,ready:a.readyState,visibility:document.visibilityState,at:performance.now(),src:a.currentSrc})},true)});
 const response=await request.post('/api/v1/imports',{data:{title:'Reader selection acceptance',body:'Good morning!\n箱を持って歩いた。\n猫は窓のそばで眠っています。',folder:'Acceptance'}});expect(response.ok()).toBeTruthy();const submitted=await response.json();let id=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await (await request.get('/api/v1/jobs/'+submitted.jobId)).json();id=job.result.textId;return job.state},{timeout:60_000}).toBe('ready');
 const detail:TextItem=await (await request.get('/api/v1/texts/'+id)).json();const box=detail.sentences[1].tokens[0];
 await request.patch('/api/v1/settings',{data:{area:info.project.name.includes('landscape')?'listening':'reading',fontSize:20,lineHeight:1.85}});
 for(const area of ['listening','reading'])expect((await request.put('/api/v1/words/'+box.wordId+'/status',{data:{area,state:'new'}})).ok()).toBeTruthy();
 await page.goto('/#'+id);await expect(page.locator('.reader-literal').first()).toHaveText('Good');await page.locator('.reader-literal').first().tap();await expect(page.getByLabel('Word details',{exact:true})).toHaveCount(0);expect(detail.sentences[0].tokens).toHaveLength(0);const token=page.locator(`[data-token-id="${box.id}"]`);await token.tap();
 const panel=page.getByLabel('Word details',{exact:true});await expect(panel).toBeVisible();await expect(panel).toHaveAttribute('role','dialog');await expect(panel).toHaveClass(/word-panel/);await expect(page.getByRole('button',{name:/^(Select phrase|Cancel selection)$/,includeHidden:true})).toHaveCount(0);
 for(const area of ['listening','reading'])await expect(panel.getByRole('group',{name:area+' status'}).getByRole('button',{name:'Learning',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(panel.locator('.word-meanings li')).toHaveCount(3);await panel.getByRole('button',{name:/Show all meanings/}).click();expect(await panel.locator('.word-meanings li').count()).toBeGreaterThan(3);await panel.getByRole('button',{name:'Show fewer meanings'}).click();await expect(panel.locator('.word-meanings li')).toHaveCount(3);
 await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.ended),{timeout:90_000}).toBe(true);
 await page.screenshot({path:`test-results/${info.project.name}-three-meanings.png`});
 const scroll=panel.locator('.word-scroll');await scroll.evaluate(el=>{el.scrollTop=120});const rect=(await scroll.boundingBox())!;
 const from={x:rect.x+rect.width/2,y:rect.y+Math.min(90,rect.height/3)};
 await gesture(page,browserName,from,{x:from.x,y:from.y-55});await expect(panel).toBeVisible();
 await gesture(page,browserName,from,{x:from.x,y:from.y+100});await expect(panel).toBeVisible();await scroll.evaluate(el=>{el.scrollTop=0});await gesture(page,browserName,from,{x:from.x,y:from.y+100});await expect(panel).toHaveCount(0);
 // Phrase selection must not learn or play any individual word.
 for(const area of ['listening','reading'])await request.put('/api/v1/words/'+box.wordId+'/status',{data:{area,state:'new'}});
 await page.reload();await expect(token).toBeVisible();
 const nativeSelection=await token.evaluate(el=>({select:getComputedStyle(el).getPropertyValue('user-select')||getComputedStyle(el).getPropertyValue('-webkit-user-select'),callout:CSS.supports('-webkit-touch-callout','none')?getComputedStyle(el).getPropertyValue('-webkit-touch-callout'):null}));expect(nativeSelection.select).toBe('none');if(nativeSelection.callout!==null)expect(nativeSelection.callout).toBe('none');
 const last=detail.sentences[2].tokens[1];const end=page.locator(`[data-token-id="${last.id}"]`);
 const translations:string[]=[];page.on('request',r=>{if(r.url().endsWith('/phrase-tools/translation'))translations.push(r.postData()??'')});
 await selectPhrase(page,browserName,token,end);
 const phrase=page.getByRole('dialog',{name:'Selected phrase'});await expect(phrase).toBeVisible();await expect(phrase).toHaveClass(/word-panel/);await expect(phrase.locator('.word-scroll')).toBeVisible();await expect(phrase.locator('.word-title h2.phrase-japanese')).toBeVisible();
 await expect(phrase.locator('.phrase-japanese')).toContainText('箱を持って歩いた。\n猫は');await expect(phrase.locator('.phrase-translation')).toHaveAttribute('aria-busy','false',{timeout:150_000});await expect(phrase.locator('.phrase-translation')).not.toBeEmpty();await expect(phrase.locator('textarea,input')).toHaveCount(0);await expect(phrase.getByRole('button',{name:/Save phrase|Translate again/})).toHaveCount(0);
 expect(translations).toHaveLength(1);
 const word=await (await request.get('/api/v1/words/'+box.wordId)).json();expect(word.statuses.listening.state).toBe('new');expect(word.statuses.reading.state).toBe('new');
 const audio=page.locator('audio');await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>({ended:a.ended,paused:a.paused,time:a.currentTime,duration:a.duration,ready:a.readyState,error:a.error?.message})),{timeout:90_000}).toMatchObject({ended:true});
 const firstUrl=await audio.getAttribute('src');expect(firstUrl).toContain('/phrase-tools/speech/play?');
 await phrase.getByRole('button',{name:'Pronounce phrase',exact:true}).tap();await expect(audio).not.toHaveAttribute('src',firstUrl!);await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>a.ended),{timeout:90_000}).toBe(true);expect(translations).toHaveLength(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();await page.screenshot({path:`test-results/${info.project.name}-transient-phrase.png`});
 const cachedUrls=await page.evaluate(async()=>{const urls:string[]=[];for(const name of await caches.keys())for(const key of await (await caches.open(name)).keys())urls.push(key.url);return urls});expect(cachedUrls.some(url=>url.includes('/phrase-tools/')||url.includes('/jobs/phrase-'))).toBe(false);
 await phrase.locator('.word-scroll').evaluate(el=>{el.scrollTop=0});const phraseBox=(await phrase.locator('.phrase-japanese').boundingBox())!;await gesture(page,browserName,{x:phraseBox.x+20,y:phraseBox.y+12},{x:phraseBox.x+20,y:phraseBox.y+112});await expect(phrase).toHaveCount(0);await expect(panel).toHaveCount(0);await expect(page.locator('.range-selected')).toHaveCount(0);
 // Drag across an English-to-Japanese span and verify the original text
 // reaches both language services, while standalone English has no word action.
 await selectPhrase(page,browserName,page.locator('.reader-literal').first(),token);await expect(phrase).toBeVisible();await expect(phrase.locator('.phrase-japanese')).toHaveText('Good morning!\n箱');
 await expect(phrase.locator('.phrase-translation')).toHaveAttribute('aria-busy','false',{timeout:150_000});expect(JSON.parse(translations.at(-1)!).text).toBe('Good morning!\n箱');expect(new URL(await audio.evaluate((el:HTMLAudioElement)=>el.src)).searchParams.get('text')).toBe('Good morning!\n箱');await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>a.ended),{timeout:90_000}).toBe(true);await phrase.getByRole('button',{name:'Close',exact:true}).click();
 const inflected=detail.sentences.flatMap(sentence=>sentence.tokens).find(t=>t.surface!==t.base)!;
 await page.locator(`[data-token-id="${inflected.id}"]`).tap();await expect(panel.locator('.word-title h2')).toHaveText(inflected.base);await expect(panel.locator('.base-note')).toContainText(inflected.surface);await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>a.ended),{timeout:90_000}).toBe(true);expect(new URL(await audio.evaluate((el:HTMLAudioElement)=>el.src)).searchParams.get('text')).toBe(inflected.base);await panel.getByRole('button',{name:'Close word details',exact:true}).click();
 await page.locator('.reader .back-button').click();expect(errors).toEqual([]);
});

test.afterEach(async({page},info)=>{if(info.status!==info.expectedStatus)await info.attach('media-events',{body:JSON.stringify(await page.evaluate(()=>(window as any).mediaEvents)),contentType:'application/json'})});
