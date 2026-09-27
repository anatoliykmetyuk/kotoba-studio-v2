import {test,expect,type Locator,type Page,type Request,type APIRequestContext} from '@playwright/test';
import type {TextItem,Token} from '../../web/src/api';

type Playback={src:string;time:number;duration:number;muted:boolean;volume:number};
declare global{interface Window{pronunciations:Playback[]}}

async function longPressToken(page:Page,browserName:string,token:Locator){
 await token.scrollIntoViewIfNeeded();const box=(await token.boundingBox())!,point={x:box.x+box.width/2,y:box.y+box.height/2};
 if(browserName==='chromium'){
  const cdp=await page.context().newCDPSession(page);
  try{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await page.waitForTimeout(500);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})}
  finally{await cdp.detach()}
 }else{
  // Playwright WebKit has no native touch dispatch. No playback is expected here.
  await token.evaluate((el,{x,y})=>{const touch={identifier:1,clientX:x,clientY:y};const event=new Event('touchstart',{bubbles:true,cancelable:true});Object.assign(event,{touches:[touch],changedTouches:[touch]});el.dispatchEvent(event)},point);
  await page.waitForTimeout(500);
  await token.evaluate(el=>{const event=new Event('touchend',{bubbles:true,cancelable:true});Object.assign(event,{touches:[],changedTouches:[]});el.dispatchEvent(event)});
 }
}

async function pronunciationLesson(request:APIRequestContext):Promise<TextItem>{
 const submitted=await(await request.post('/api/v1/imports',{data:{title:'Pronunciation acceptance',body:'猫は庭を歩く。犬は水を飲む。',folder:'Acceptance'}})).json();
 let id=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();if(job.state==='failed')throw new Error(job.error);id=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 return(await request.get('/api/v1/texts/'+id)).json();
}

test('word taps promote only New, play audible media, replay, and leave no selection after a single-token long press',async({page,request,browserName},info)=>{
 const settings=await request.patch('/api/v1/settings',{data:{area:'reading',theme:'light',fontSize:20,lineHeight:1.85}});expect(settings.ok()).toBeTruthy();
 const text=await pronunciationLesson(request);
 const unique=[...new Map(text.sentences.flatMap(s=>s.tokens).map(t=>[t.baseId,t])).values()];
 const [first,second,third]=unique;
 async function status(token:Token,area:string,state:string){expect((await request.put('/api/v1/words/'+token.wordId+'/status',{data:{area,state}})).ok()).toBeTruthy()}
 await status(first,'reading','new');await status(first,'listening','familiar');await status(second,'reading','familiar');await status(third,'reading','known');
 await page.addInitScript(()=>{window.pronunciations=[];document.addEventListener('ended',event=>{const audio=event.target;if(audio instanceof HTMLAudioElement)window.pronunciations.push({src:audio.currentSrc,time:audio.currentTime,duration:audio.duration,muted:audio.muted,volume:audio.volume})},true)});
 await page.goto('/');await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();await page.locator('.text-card').filter({has:page.getByRole('heading',{name:text.title,exact:true})}).click();
 const token=(t:Token)=>page.locator(`[data-token-id="${t.id}"]`);
 await expect(token(first)).toHaveClass(/new/);
 const color=(t:Token)=>token(t).evaluate(el=>getComputedStyle(el).backgroundColor);
 const newColor=await color(first),familiarColor=await color(second),knownColor=await color(third);
 expect(new Set([newColor,familiarColor,knownColor]).size).toBe(3);expect(newColor).not.toBe('rgba(0, 0, 0, 0)');expect(familiarColor).not.toBe('rgba(0, 0, 0, 0)');
 await token(first).tap();
 const panel=page.getByLabel('Word details',{exact:true});
 await expect(panel.getByRole('group',{name:'reading status'}).getByRole('button',{name:'Learning',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(panel.getByRole('group',{name:'listening status'}).getByRole('button',{name:'Familiar',exact:true})).toHaveAttribute('aria-pressed','true');
 try{await expect.poll(()=>page.evaluate(()=>window.pronunciations.length),{timeout:90_000}).toBe(1)}catch(error){await info.attach('media-state',{body:JSON.stringify(await page.locator('audio').evaluate((audio:HTMLAudioElement)=>({src:audio.currentSrc,paused:audio.paused,ended:audio.ended,error:audio.error?.message,readyState:audio.readyState,time:audio.currentTime,duration:audio.duration,visibility:document.visibilityState}))),contentType:'application/json'});throw error}
 const actual=await page.evaluate(()=>window.pronunciations[0]);expect(actual.time).toBeGreaterThan(.1);expect(actual.duration).toBeGreaterThan(.1);expect(actual.muted).toBe(false);expect(actual.volume).toBe(1);
 const wav=Buffer.from(await page.evaluate(async src=>{const response=await fetch(src);if(!response.ok)throw new Error('Pronunciation bytes could not load');return Array.from(new Uint8Array(await response.arrayBuffer()))},actual.src));expect(wav.toString('ascii',0,4)).toBe('RIFF');let peak=0;for(let offset=12;offset+8<wav.length;){const size=wav.readUInt32LE(offset+4);if(wav.toString('ascii',offset,offset+4)==='data'){for(let i=offset+8;i+1<Math.min(offset+8+size,wav.length);i+=2)peak=Math.max(peak,Math.abs(wav.readInt16LE(i)));break}offset+=8+size+(size%2)}expect(peak,'Generated pronunciation must contain an audio signal').toBeGreaterThan(256);
 const learningColor=await color(first);expect(new Set([newColor,learningColor,familiarColor,knownColor]).size).toBe(4);
 await panel.getByRole('button',{name:'Pronounce word'}).click();await expect.poll(()=>page.evaluate(()=>window.pronunciations.length),{timeout:30_000}).toBe(2);
 // A new tap replaces a pending/playing request, rather than being dropped by a global busy flag.
 await panel.getByRole('button',{name:'Pronounce word'}).click();await panel.getByRole('button',{name:'Close word details',exact:true}).click();await token(second).tap();
 await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>new URL(a.src).searchParams.get('text'))).toBe(second.base);
 await expect.poll(()=>page.evaluate(id=>window.pronunciations.some(p=>new URL(p.src).searchParams.get('text')===id),second.base),{timeout:90_000}).toBe(true);
 await expect(panel.getByRole('group',{name:'reading status'}).getByRole('button',{name:'Familiar',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('alert')).toHaveCount(0);await panel.getByRole('button',{name:'Close word details',exact:true}).click();
 await page.screenshot({path:`test-results/${info.project.name}-token-highlights.png`});
 await token(second).tap();await page.goBack();await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();await expect.poll(()=>page.locator('audio').evaluate(el=>(el as HTMLAudioElement).paused)).toBe(true);await page.goForward();await expect(token(first)).toBeAttached();
 await status(first,'reading','new');await page.reload();await expect(token(first)).toHaveClass(/new/);
 const beforeHold=await (await request.get('/api/v1/words/'+first.wordId)).json();
 const holdRequests:string[]=[];const recordHoldRequest=(r:Request)=>{if(/\/api\/v1\/(?:speech(?:\/|$)|phrase-tools\/|words\/[^/]+\/(?:learn|status)$)/.test(new URL(r.url()).pathname))holdRequests.push(r.url())};page.on('request',recordHoldRequest);
 await longPressToken(page,browserName,token(first));
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.range-selected')).toHaveCount(0);await expect(page.locator('audio')).not.toHaveAttribute('src',/.+/);await expect(page.locator('audio')).toHaveJSProperty('paused',true);expect(await page.evaluate(()=>window.pronunciations)).toEqual([]);
 const saved=await (await request.get('/api/v1/words/'+first.wordId)).json();expect(saved.statuses).toEqual(beforeHold.statuses);expect(saved.statuses.reading.state).toBe('new');expect(holdRequests).toEqual([]);page.off('request',recordHoldRequest);
 const beforeFinal=await page.evaluate(()=>window.pronunciations.length);await token(first).tap();await panel.getByRole('group',{name:'reading status'}).getByRole('button',{name:'Known',exact:true}).click();await expect(panel.getByRole('group',{name:'reading status'}).getByRole('button',{name:'Known',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('alert')).toHaveCount(0);
 await expect.poll(()=>page.evaluate(()=>window.pronunciations.length),{timeout:30_000}).toBe(beforeFinal+1);
 await panel.getByRole('button',{name:'Close word details',exact:true}).click();await page.locator('.reader .back-button').click();
 await expect(page.locator('audio')).toHaveJSProperty('paused',true);
});

test('automatic learning preserves known reading while promoting new listening',async({page,request},info)=>{
 test.skip(info.project.name!=='phone-chromium-portrait','Shared status behavior is also covered by domain tests.');
 const text=await pronunciationLesson(request);const first=text.sentences.flatMap(s=>s.tokens)[0];
 await request.put('/api/v1/words/'+first.wordId+'/status',{data:{area:'reading',state:'known'}});await request.put('/api/v1/words/'+first.wordId+'/status',{data:{area:'listening',state:'new'}});await request.patch('/api/v1/settings',{data:{area:'listening'}});
 await page.goto('/#'+text.id);await page.locator(`[data-token-id="${first.id}"]`).tap();
 await expect(page.getByRole('group',{name:'listening status'}).getByRole('button',{name:'Learning',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('group',{name:'reading status'}).getByRole('button',{name:'Known',exact:true})).toHaveAttribute('aria-pressed','true');
 await request.patch('/api/v1/settings',{data:{area:'reading'}});
 await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.ended),{timeout:90_000}).toBe(true);
 await page.getByRole('button',{name:'Close word details',exact:true}).click();
 await page.locator('.reader .back-button').click();
});
