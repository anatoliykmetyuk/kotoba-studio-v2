import {useEffect,type RefObject} from 'react';

// Safari can omit click after a Pencil tap. Activate buttons on pen release and
// consume a later compatibility click before it reaches an uncovered lesson.
function suppressCompatibilityClick(x:number,y:number){
 const clear=()=>{clearTimeout(timer);document.removeEventListener('click',click,true);document.removeEventListener('pointerdown',clear,true)};
 const click=(event:MouseEvent)=>{
  if(event.detail===0||Math.hypot(event.clientX-x,event.clientY-y)>10)return;
  event.preventDefault();event.stopImmediatePropagation();clear();
 };
 const timer=setTimeout(clear,1000);
 document.addEventListener('click',click,true);document.addEventListener('pointerdown',clear,true);
}

/** Retain native button/keyboard behavior while supporting pen taps without click. */
export function usePenButtonActivation(ref:RefObject<HTMLElement|null>){
 useEffect(()=>{
  const root=ref.current;if(!root)return;
  let press:{id:number;x:number;y:number;button:HTMLButtonElement;moved:boolean}|null=null;
  const down=(event:PointerEvent)=>{
   press=null;if(event.pointerType!=='pen'||!event.isPrimary||event.button!==0)return;
   const button=event.target instanceof Element?event.target.closest('button'):null;
   if(button instanceof HTMLButtonElement&&root.contains(button)&&!button.disabled)press={id:event.pointerId,x:event.clientX,y:event.clientY,button,moved:false};
  };
  const move=(event:PointerEvent)=>{if(press?.id===event.pointerId&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>10)press.moved=true};
  const cancel=()=>{press=null};
  const up=(event:PointerEvent)=>{
   move(event);const current=press;press=null;
   if(!current||current.id!==event.pointerId||current.moved||current.button.disabled||!current.button.isConnected)return;
   const hit=document.elementFromPoint(event.clientX,event.clientY);
   if(!hit||!current.button.contains(hit))return;
   event.preventDefault();event.stopPropagation();
   // click() runs synchronously within the pen's user activation, so clipboard
   // and playback handlers retain access to gesture-gated browser APIs.
   current.button.focus({preventScroll:true});current.button.click();
   suppressCompatibilityClick(event.clientX,event.clientY);
  };
  root.addEventListener('pointerdown',down,true);root.addEventListener('pointermove',move,true);
  root.addEventListener('pointerup',up,true);root.addEventListener('pointercancel',cancel,true);
  return()=>{root.removeEventListener('pointerdown',down,true);root.removeEventListener('pointermove',move,true);root.removeEventListener('pointerup',up,true);root.removeEventListener('pointercancel',cancel,true)};
 },[ref]);
}
