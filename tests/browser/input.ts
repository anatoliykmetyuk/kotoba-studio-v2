import type {Page,Locator} from '@playwright/test';

// Chromium supplies trusted pen events. WebKit has no remote pen API, so its
// test exercises a pointer-only tap without claiming hardware QA. No synthetic
// click is supplied: Safari Pencil input may omit that compatibility event.
export async function penTap(page:Page,target:Locator,browserName:string,point?:{x:number;y:number}){
 await target.scrollIntoViewIfNeeded();
 const box=(await target.boundingBox())!,{x,y}=point??{x:box.x+box.width/2,y:box.y+box.height/2};
 if(browserName==='chromium'){
  const session=await page.context().newCDPSession(page);
  try{
   await session.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1,pointerType:'pen'});
   await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1,pointerType:'pen'});
  }finally{await session.detach()}
 }else await target.evaluate((el,{x,y})=>{
  for(const type of ['pointerdown','pointerup'])el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:7,pointerType:'pen',isPrimary:true,clientX:x,clientY:y,button:0,buttons:type==='pointerdown'?1:0}));
 },{x,y});
}
