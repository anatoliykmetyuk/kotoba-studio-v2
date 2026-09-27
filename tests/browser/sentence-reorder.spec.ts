import {test,expect,type APIRequestContext,type Locator,type Page} from '@playwright/test';
import {muteTestOutput} from './audio-output';
import {penTap} from './input';

type Point={x:number;y:number};
type Input='mouse'|'touch'|'pen';
const answer=(page:Page)=>page.locator('.sentence-answer .sentence-assembly-token');
const order=(page:Page)=>answer(page).evaluateAll(buttons=>buttons.map(button=>Number((button as HTMLElement).dataset.piece)));
async function center(locator:Locator):Promise<Point>{const box=(await locator.boundingBox())!;return {x:box.x+box.width/2,y:box.y+box.height/2}}

async function openSentence(page:Page,request:APIRequestContext){
 await muteTestOutput(page);
 const response=await request.post('/api/v1/imports',{data:{title:'Sentence reordering acceptance',body:'今日は友達と一緒に近くの図書館で面白い日本語の本をゆっくり読みます。',folder:'Acceptance'}});
 expect(response.ok()).toBe(true);const submitted=await response.json();let id=submitted.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();expect(job.state,job.error).not.toBe('failed');id=job.result.textId;return job.state},{timeout:90_000}).toBe('ready');
 await page.goto('/#'+id);await expect(page.locator('.reader')).toBeVisible();
 await page.locator('.reader-finish').getByRole('button',{name:'Practice',exact:true}).click();
 await page.getByRole('button',{name:'Build a sentence',exact:true}).click();
 await expect(page.locator('.pieces button').first()).toBeVisible({timeout:180_000});
 const count=await page.locator('.pieces button').count();expect(count).toBeGreaterThan(6);return count;
}

async function placeAll(page:Page,count:number,reverse=true){
 while(await answer(page).count())await answer(page).first().click();
 for(const piece of Array.from({length:count},(_,index)=>reverse?count-index-1:index))await page.locator(`.pieces [data-piece="${piece}"]`).click();
 await expect(answer(page)).toHaveCount(count);
}

async function drag(page:Page,browserName:string,input:Input,source:Locator,to:Point,cancel=false){
 const from=await center(source);
 const cdp=browserName==='chromium'&&input!=='mouse'?await page.context().newCDPSession(page):null;
 async function dispatch(type:'down'|'move'|'up',point:Point){
  if(input==='mouse'){
   if(type==='down'){await page.mouse.move(point.x,point.y);await page.mouse.down()}
   else if(type==='move')await page.mouse.move(point.x,point.y);else await page.mouse.up();
  }else if(cdp){
   if(input==='touch')await cdp.send('Input.dispatchTouchEvent',{type:type==='down'?'touchStart':type==='move'?'touchMove':'touchEnd',touchPoints:type==='up'?[]:[point]});
   else await cdp.send('Input.dispatchMouseEvent',{type:type==='down'?'mousePressed':type==='move'?'mouseMoved':'mouseReleased',...point,button:'left',buttons:type==='up'?0:1,clickCount:type==='move'?0:1,pointerType:'pen'});
  }else{
   // WebKit exposes no trusted pen or touch-drag protocol. Exercise its real
   // PointerSensor with DOM pointer events, without claiming hardware coverage.
   const event={bubbles:true,cancelable:true,pointerId:41,pointerType:input,isPrimary:true,button:0,buttons:type==='up'?0:1,clientX:point.x,clientY:point.y};
   if(type==='down')await source.dispatchEvent('pointerdown',event);
   else await page.evaluate(({type,event})=>document.dispatchEvent(new PointerEvent('pointer'+type,event)),{type,event});
  }
 }
 try{
  await dispatch('down',from);
  for(let step=1;step<=12;step++){await dispatch('move',{x:from.x+(to.x-from.x)*step/12,y:from.y+(to.y-from.y)*step/12});await page.waitForTimeout(20)}
  await expect(source).toHaveAttribute('data-dragging','true');
  if(cancel)await page.keyboard.press('Escape');
  await dispatch('up',to);
 }finally{await cdp?.detach()}
}

test('placed words reorder across wrapped rows with mouse, touch and pen without removal',async({page,request,browserName},info)=>{
 test.setTimeout(240_000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const count=await openSentence(page,request);
 const inputs:Input[]=info.project.name.startsWith('desktop')?['mouse','pen']:info.project.name.startsWith('ipad')?['touch','pen']:['touch'];
 for(const input of inputs){
  await placeAll(page,count);const before=await order(page),source=answer(page).first();
  // Keep this stationary reorder away from the viewport's auto-scroll edge.
  // Merely making the first token visible can leave its center at y=24px.
  await source.evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
  const boxes=await answer(page).evaluateAll(buttons=>buttons.map(button=>{const rect=button.getBoundingClientRect();return {id:Number((button as HTMLElement).dataset.piece),x:rect.x+rect.width/2,y:rect.y+rect.height/2,height:rect.height,visible:rect.y+rect.height<innerHeight-15}}));
  const target=boxes.find(box=>box.y>boxes[0].y+boxes[0].height/2&&box.visible);expect(target,'A wrapped answer row must be visible').toBeTruthy();
  const destination=before.indexOf(target!.id),expected=[...before];expected.splice(destination,0,...expected.splice(0,1));
  const startScroll=await page.evaluate(()=>scrollY);
  await drag(page,browserName,input,source,target!);
  await expect.poll(()=>order(page)).toEqual(expected);await expect(answer(page)).toHaveCount(count);
  await expect(page.locator('.pieces button:disabled')).toHaveCount(count);
  expect(Math.abs(await page.evaluate(()=>scrollY)-startScroll)).toBeLessThan(3);
  // A late compatibility click from the drag must not become the tap action.
  await page.waitForTimeout(100);
  await page.locator(`.sentence-answer [data-piece="${before[0]}"]`).dispatchEvent('click',{detail:1,clientX:target!.x,clientY:target!.y});
  expect(await order(page)).toEqual(expected);
  await page.screenshot({path:info.outputPath(`${input}-reordered-sentence.png`)});
  const moved=page.locator(`.sentence-answer [data-piece="${before[0]}"]`);
  if(input==='pen')await penTap(page,moved,browserName);else if(input==='touch')await moved.tap();else await moved.click();
  await expect(answer(page)).toHaveCount(count-1);
  await expect(page.locator(`.pieces [data-piece="${before[0]}"]`)).toBeEnabled();
 }
 expect(errors).toEqual([]);
});

test('keyboard reorder and cancellation retain all words, Enter still removes, and correct answers lock',async({page,request})=>{
 test.setTimeout(240_000);const count=await openSentence(page,request);await placeAll(page,count);
 const announcement=page.locator('[role="status"][aria-live="assertive"]');
 async function pickUp(word:Locator){
  await word.focus();await page.keyboard.press('Space');await expect(word).toHaveAttribute('data-dragging','true');
  // KeyboardSensor installs its document listener in a timer after activation.
  // Yield that task before sending the next key, which automation can otherwise
  // send before the browser is ready to receive it.
  await page.evaluate(()=>new Promise<void>(resolve=>setTimeout(resolve,0)));
  await expect(announcement).toContainText(`to position 1 of ${count}.`);
 }
 async function moveRight(){
  await page.keyboard.press('ArrowRight');let destination=0;
  await expect.poll(async()=>{
   const match=(await announcement.textContent())?.match(/to position (\d+) of (\d+)\.$/);
   destination=Number(match?.[1]);
   return Number(match?.[2])===count&&destination>1&&destination<=count;
  }).toBe(true);
  return destination-1;
 }
 const before=await order(page),first=answer(page).first();await first.scrollIntoViewIfNeeded();await first.focus();
 await pickUp(first);const destination=await moveRight();await page.keyboard.press('Space');
 // Wrapped, variable-width words use spatial keyboard navigation. Its next
 // target can be on another row instead of the next item in DOM order.
 const expected=[...before];expected.splice(destination,0,...expected.splice(0,1));
 await expect.poll(()=>order(page)).toEqual(expected);
 const current=answer(page).first();await pickUp(current);await moveRight();await page.keyboard.press('Escape');
 expect(await order(page)).toEqual(expected);await expect(answer(page)).toHaveCount(count);
 await current.focus();await page.keyboard.press('Enter');await expect(answer(page)).toHaveCount(count-1);
 await placeAll(page,count,false);const correct=await order(page);
 await page.getByRole('button',{name:'Check sentence',exact:true}).click();
 await expect(page.locator('.practice-feedback')).toContainText('Correct');
 expect(await answer(page).evaluateAll(buttons=>buttons.every(button=>(button as HTMLButtonElement).disabled))).toBe(true);
 expect(await order(page)).toEqual(correct);
 await expect(page.getByRole('heading',{name:'Practice complete',exact:true})).toBeVisible();
});
