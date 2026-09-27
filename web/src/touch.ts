import {useEffect,useRef,useState,type RefObject} from 'react';

/** A gesture beginning below the top scrolls for its entire duration. */
export function useSwipeDismiss(ref:RefObject<HTMLElement|null>,close:()=>void,mobileOnly=false){
 const [drag,setDrag]=useState(0);const callback=useRef(close);callback.current=close;
 useEffect(()=>{
  const el=ref.current;if(!el)return;
  let start:{x:number;y:number;direction:'pending'|'down'|'scroll';proxy?:HTMLElement;scrollTop?:number}|null=null;
  let distance=0,suppress=false;
  const begin=(target:EventTarget|null,x:number,y:number)=>{
   start=null;distance=0;suppress=false;
   if(mobileOnly&&!matchMedia('(max-width:900px)').matches)return;
   const origin=target instanceof Element?target:null;if(!origin)return;
   // Sliders retain their own gestures. A sheet already scrolled away from
   // the top must scroll back first; never switch to dismissal mid-gesture.
   if(origin.closest('input[type="range"]'))return;
   const scrolled=[el,...el.querySelectorAll<HTMLElement>('*')].find(node=>node.scrollTop>1&&node.scrollHeight>node.clientHeight+1);
   const proxy=scrolled&&!scrolled.contains(origin)?scrolled:undefined;
   start={x,y,direction:scrolled?'scroll':'pending',proxy,scrollTop:proxy?.scrollTop};
  };
  const move=(x:number,y:number,event:Event)=>{
   if(!start)return;const dx=x-start.x,dy=y-start.y;
   if(start.direction==='pending'&&Math.max(Math.abs(dx),Math.abs(dy))>10)start.direction=dy>0&&dy>Math.abs(dx)?'down':'scroll';
   if(start.direction==='scroll'&&start.proxy){if(event.cancelable)event.preventDefault();start.proxy.scrollTop=start.scrollTop!-dy;suppress=Math.abs(dy)>10;return}
   if(start.direction!=='down')return;
   if(event.cancelable)event.preventDefault();distance=Math.max(0,dy);suppress=true;setDrag(distance);
  };
  const end=()=>{const dismiss=start?.direction==='down'&&distance>=72;start=null;distance=0;setDrag(0);if(dismiss)callback.current()};
  const cancel=()=>{start=null;distance=0;setDrag(0)};
  const touchStart=(e:TouchEvent)=>{if(e.touches.length!==1){cancel();return}begin(e.target,e.touches[0].clientX,e.touches[0].clientY)};
  const touchMove=(e:TouchEvent)=>{if(e.touches.length!==1){cancel();return}move(e.touches[0].clientX,e.touches[0].clientY,e)};
  const click=(e:MouseEvent)=>{if(suppress){e.preventDefault();e.stopPropagation();suppress=false}};
  el.addEventListener('touchstart',touchStart,{passive:true});el.addEventListener('touchmove',touchMove,{passive:false});
  el.addEventListener('touchend',end);el.addEventListener('touchcancel',cancel);
  el.addEventListener('click',click,true);
  return()=>{el.removeEventListener('touchstart',touchStart);el.removeEventListener('touchmove',touchMove);el.removeEventListener('touchend',end);el.removeEventListener('touchcancel',cancel);el.removeEventListener('click',click,true)};
 },[ref,mobileOnly]);
 return drag;
}

/** Mouse drag or touch long-press drag across contiguous tokens and lines. */
export function useTokenSelection(ref:RefObject<HTMLElement|null>,textId:string,onSelect:(anchor:string,end:string,finished:boolean)=>void){
 const callback=useRef(onSelect);callback.current=onSelect;
 useEffect(()=>{
  const el=ref.current;if(!el)return;
  let gesture:{anchor:string;end:string;x:number;y:number;active:boolean;touch:boolean}|null=null;
  let timer:ReturnType<typeof setTimeout>|undefined;let suppress=false;
  let boxes:{id:string;box:DOMRect}[]=[];
  function cancel(clearSelection=false){
   if(clearSelection&&gesture?.active)callback.current(gesture.anchor,gesture.anchor,true);
   clearTimeout(timer);gesture=null;boxes=[];
  }
  function activate(){
   if(!gesture)return;gesture.active=true;suppress=true;
   boxes=Array.from(el!.querySelectorAll<HTMLElement>('[data-selection-id]'),token=>({id:token.dataset.selectionId!,box:token.getBoundingClientRect()}));
   callback.current(gesture.anchor,gesture.end,false);
  }
  function begin(target:EventTarget|null,x:number,y:number,touch:boolean){
   cancel(true);suppress=false;const token=(target as Element)?.closest<HTMLElement>('[data-selection-id]');if(!token)return;
   gesture={anchor:token.dataset.selectionId!,end:token.dataset.selectionId!,x,y,active:false,touch};
   if(touch)timer=setTimeout(activate,420);
  }
  function move(x:number,y:number,event:Event){
   if(!gesture)return;
   if(!gesture.active){
    const distance=Math.hypot(x-gesture.x,y-gesture.y);
    if(gesture.touch){if(distance>10)cancel();return}
    if(distance<5)return;activate();
   }
   if(event.cancelable)event.preventDefault();
   const direct=document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-selection-id]');
   let id=direct&&el!.contains(direct)?direct.dataset.selectionId:undefined;
   if(!id){let best=Infinity;for(const {id:candidate,box} of boxes){const dx=Math.max(box.left-x,0,x-box.right),dy=Math.max(box.top-y,0,y-box.bottom);const distance=dx*dx+dy*dy*4;if(distance<best){best=distance;id=candidate}}}
   if(id&&id!==gesture.end){gesture.end=id;callback.current(gesture.anchor,id,false)}
  }
  function end(event:Event){if(gesture?.active){if(event.cancelable)event.preventDefault();callback.current(gesture.anchor,gesture.end,true)}cancel()}
  const touchStart=(e:TouchEvent)=>{if(e.touches.length!==1){cancel(true);return}begin(e.target,e.touches[0].clientX,e.touches[0].clientY,true)};
  const touchMove=(e:TouchEvent)=>{if(e.touches.length!==1){cancel(true);return}move(e.touches[0].clientX,e.touches[0].clientY,e)};
  const pointerDown=(e:PointerEvent)=>{if(e.pointerType==='touch'||e.button!==0)return;begin(e.target,e.clientX,e.clientY,false)};
  const pointerMove=(e:PointerEvent)=>{if(e.pointerType!=='touch')move(e.clientX,e.clientY,e)};
  const pointerUp=(e:PointerEvent)=>{if(e.pointerType!=='touch')end(e)};
  const click=(e:MouseEvent)=>{if(suppress){e.preventDefault();e.stopPropagation();suppress=false}};
  const context=(e:Event)=>e.preventDefault();
  const blur=()=>cancel(true);
  el.addEventListener('touchstart',touchStart,{passive:true});el.addEventListener('touchmove',touchMove,{passive:false});el.addEventListener('touchend',end,{passive:false});el.addEventListener('touchcancel',blur);
  el.addEventListener('pointerdown',pointerDown);window.addEventListener('pointermove',pointerMove);window.addEventListener('pointerup',pointerUp);window.addEventListener('blur',blur);
  el.addEventListener('click',click,true);el.addEventListener('contextmenu',context);
  return()=>{cancel();el.removeEventListener('touchstart',touchStart);el.removeEventListener('touchmove',touchMove);el.removeEventListener('touchend',end);el.removeEventListener('touchcancel',blur);el.removeEventListener('pointerdown',pointerDown);window.removeEventListener('pointermove',pointerMove);window.removeEventListener('pointerup',pointerUp);window.removeEventListener('blur',blur);el.removeEventListener('click',click,true);el.removeEventListener('contextmenu',context)};
 },[ref,textId]);
}
