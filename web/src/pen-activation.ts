import {useEffect} from 'react';

// Native mouse/touch/keyboard activation stays unchanged. Only bridge Safari's
// missing pen click, once, at the application boundary. Components use onClick.
function actionAt(target:EventTarget|null,x:number,y:number):HTMLElement|null{
 if(!(target instanceof Element))return null;
 const element=target.closest<HTMLElement>('button,a[href],input,label,dialog');
 if(!element)return null;
 let action:HTMLElement=element;
 if(element instanceof HTMLLabelElement){
  if(!(element.control instanceof HTMLInputElement))return null;
  action=element.control;
 }
 if(action instanceof HTMLInputElement&&!['checkbox','radio','file','button','submit','reset'].includes(action.type))return null;
 if(action instanceof HTMLDialogElement){
  const box=action.getBoundingClientRect();
  if(x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom)return null;
 }
 if(action.matches(':disabled,[aria-disabled="true"]')||action.closest('[inert]'))return null;
 return action;
}

/** Normalize pen taps for every current or future native action in the app. */
export function useUnifiedActivation(){
 useEffect(()=>{
  let press:{id:number;x:number;y:number;action:HTMLElement;moved:boolean}|null=null;
  let compatibility:{x:number;y:number}|null=null;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const clearClick=()=>{clearTimeout(timer);compatibility=null};
  const consumeClick=(x:number,y:number)=>{clearClick();compatibility={x,y};timer=setTimeout(clearClick,1000)};
  const click=(event:MouseEvent)=>{
   if(!compatibility||event.detail===0||Math.hypot(event.clientX-compatibility.x,event.clientY-compatibility.y)>10)return;
   event.preventDefault();event.stopImmediatePropagation();clearClick();
  };
  const down=(event:PointerEvent)=>{
   clearClick();press=null;
   if(event.pointerType!=='pen'||!event.isPrimary||event.button!==0)return;
   const action=actionAt(event.target,event.clientX,event.clientY);
   if(action)press={id:event.pointerId,x:event.clientX,y:event.clientY,action,moved:false};
  };
  const move=(event:PointerEvent)=>{if(press?.id===event.pointerId&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>10)press.moved=true};
  const cancel=(event:PointerEvent)=>{if(press?.id===event.pointerId)press=null};
  const scroll=()=>{if(press)press.moved=true};
  const blur=()=>{press=null;clearClick()};
  const up=(event:PointerEvent)=>{
   if(press?.id!==event.pointerId)return;
   move(event);const current=press;press=null;
   // Selection/drag handlers claim pointerup during capture. Never convert
   // those gestures into a click, even when the pointer stayed on one token.
   if(event.defaultPrevented||current.moved){consumeClick(event.clientX,event.clientY);return}
   const hit=document.elementFromPoint(event.clientX,event.clientY);
   if(!current.action.isConnected||actionAt(hit,event.clientX,event.clientY)!==current.action)return;
   event.preventDefault();
   // Synchronous native click preserves form defaults and user activation for
   // clipboard, media, file pickers and target=_blank links.
   current.action.focus({preventScroll:true});current.action.click();
   consumeClick(event.clientX,event.clientY);
  };
  document.addEventListener('pointerdown',down,true);document.addEventListener('pointermove',move,true);
  document.addEventListener('pointercancel',cancel,true);document.addEventListener('scroll',scroll,true);
  document.addEventListener('click',click,true);window.addEventListener('pointerup',up);window.addEventListener('blur',blur);
  return()=>{blur();document.removeEventListener('pointerdown',down,true);document.removeEventListener('pointermove',move,true);document.removeEventListener('pointercancel',cancel,true);document.removeEventListener('scroll',scroll,true);document.removeEventListener('click',click,true);window.removeEventListener('pointerup',up);window.removeEventListener('blur',blur)};
 },[]);
}
