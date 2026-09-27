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
  // A canceled touch click must not swallow a later, independent pen/mouse tap.
  // Those inputs need not generate touchstart, which also resets this flag.
  const pointerDown=()=>{suppress=false};
  const click=(e:MouseEvent)=>{if(suppress&&e.detail!==0){e.preventDefault();e.stopPropagation();suppress=false}};
  el.addEventListener('touchstart',touchStart,{passive:true});el.addEventListener('touchmove',touchMove,{passive:false});
  el.addEventListener('touchend',end);el.addEventListener('touchcancel',cancel);
  el.addEventListener('pointerdown',pointerDown,true);el.addEventListener('click',click,true);
  return()=>{el.removeEventListener('touchstart',touchStart);el.removeEventListener('touchmove',touchMove);el.removeEventListener('touchend',end);el.removeEventListener('touchcancel',cancel);el.removeEventListener('pointerdown',pointerDown,true);el.removeEventListener('click',click,true)};
 },[ref,mobileOnly]);
 return drag;
}

/** Hold then tap an endpoint, or drag, across contiguous tokens and lines. */
export function useTokenSelection(ref:RefObject<HTMLElement|null>,textId:string,onSelect:(anchor:string,end:string,finished:boolean)=>void){
 const callback=useRef(onSelect);callback.current=onSelect;
 useEffect(()=>{
  const el=ref.current;if(!el)return;
  let gesture:{anchor:string;end:string;x:number;y:number;active:boolean;input:'mouse'|'pen'|'touch';pointerId?:number}|null=null;
  let awaitingEnd:string|null=null;
  let timer:ReturnType<typeof setTimeout>|undefined;let suppress=false;
  let boxes:{id:string;box:DOMRect}[]=[];
  function cancel(clearSelection=false){
   if(clearSelection){const anchor=awaitingEnd??(gesture?.active?gesture.anchor:null);awaitingEnd=null;if(anchor)callback.current(anchor,anchor,true)}
   clearTimeout(timer);gesture=null;boxes=[];
  }
  function activate(){
   if(!gesture)return;clearTimeout(timer);gesture.active=true;suppress=true;
   boxes=Array.from(el!.querySelectorAll<HTMLElement>('[data-selection-id]'),token=>({id:token.dataset.selectionId!,box:token.getBoundingClientRect()}));
   callback.current(gesture.anchor,gesture.end,false);
  }
  function begin(target:EventTarget|null,x:number,y:number,input:'mouse'|'pen'|'touch',pointerId?:number){
   cancel();suppress=false;const token=(target as Element)?.closest<HTMLElement>('[data-selection-id]');if(!token){cancel(true);return}
   gesture={anchor:awaitingEnd??token.dataset.selectionId!,end:token.dataset.selectionId!,x,y,active:false,input,pointerId};
   if(awaitingEnd)activate();else timer=setTimeout(activate,420);
  }
  function move(x:number,y:number,event:Event){
   if(!gesture)return;
   if(!gesture.active){
    const distance=Math.hypot(x-gesture.x,y-gesture.y);
    if(gesture.input!=='mouse'){if(distance>10)cancel();return}
    if(distance<5)return;activate();
   }
   if(event.cancelable)event.preventDefault();
   const direct=document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-selection-id]');
   let id=direct&&el!.contains(direct)?direct.dataset.selectionId:undefined;
   if(!id){let best=Infinity;for(const {id:candidate,box} of boxes){const dx=Math.max(box.left-x,0,x-box.right),dy=Math.max(box.top-y,0,y-box.bottom);const distance=dx*dx+dy*dy*4;if(distance<best){best=distance;id=candidate}}}
   if(id&&id!==gesture.end){gesture.end=id;callback.current(gesture.anchor,id,false)}
  }
  function end(event:Event){
   if(gesture?.active){
    if(event.cancelable)event.preventDefault();
    const finished=gesture.anchor!==gesture.end;
    awaitingEnd=finished?null:gesture.anchor;
    callback.current(gesture.anchor,gesture.end,finished);
   }
   cancel();
  }
  const touchStart=(e:TouchEvent)=>{if(e.touches.length!==1){cancel(true);return}if(gesture?.input==='pen')return;begin(e.target,e.touches[0].clientX,e.touches[0].clientY,'touch')};
  const touchMove=(e:TouchEvent)=>{
   // Some Pencil implementations also emit TouchEvents. Pen coordinates and
   // completion belong to its PointerEvents; only suppress native pan here.
   if(gesture?.input==='pen'){if(gesture.active&&e.cancelable)e.preventDefault();return}
   if(gesture?.input!=='touch')return;
   if(e.touches.length!==1){cancel(true);return}move(e.touches[0].clientX,e.touches[0].clientY,e);
  };
  const touchEnd=(e:TouchEvent)=>{if(gesture?.input==='touch')end(e)};
  const touchCancel=()=>{if(gesture?.input==='touch')cancel(true)};
  const pointerDown=(e:PointerEvent)=>{if(e.pointerType==='touch'||e.button!==0)return;begin(e.target,e.clientX,e.clientY,e.pointerType==='pen'?'pen':'mouse',e.pointerId)};
  const ownsPointer=(e:PointerEvent)=>gesture?.input===e.pointerType&&gesture?.pointerId===e.pointerId;
  const pointerMove=(e:PointerEvent)=>{if(ownsPointer(e))move(e.clientX,e.clientY,e)};
  const pointerUp=(e:PointerEvent)=>{if(ownsPointer(e))end(e)};
  const click=(e:MouseEvent)=>{
   if(e.detail===0){cancel(true);suppress=false;return}
   if(suppress){e.preventDefault();e.stopPropagation();suppress=false}
  };
  const context=(e:Event)=>e.preventDefault();
  const blur=()=>cancel(true);
  const pointerCancel=(e:PointerEvent)=>{if(ownsPointer(e))cancel(true)};
  const outside=(e:PointerEvent)=>{if(e.target instanceof Node&&!el.contains(e.target))cancel(true)};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&(awaitingEnd||gesture?.active)){e.preventDefault();cancel(true)}};
  el.addEventListener('touchstart',touchStart,{passive:true});el.addEventListener('touchmove',touchMove,{passive:false});el.addEventListener('touchend',touchEnd,{passive:false});el.addEventListener('touchcancel',touchCancel);
  el.addEventListener('pointerdown',pointerDown);window.addEventListener('pointermove',pointerMove);window.addEventListener('pointerup',pointerUp);window.addEventListener('pointercancel',pointerCancel);window.addEventListener('blur',blur);
  document.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',key);
  el.addEventListener('click',click,true);el.addEventListener('contextmenu',context);
  return()=>{cancel();el.removeEventListener('touchstart',touchStart);el.removeEventListener('touchmove',touchMove);el.removeEventListener('touchend',touchEnd);el.removeEventListener('touchcancel',touchCancel);el.removeEventListener('pointerdown',pointerDown);window.removeEventListener('pointermove',pointerMove);window.removeEventListener('pointerup',pointerUp);window.removeEventListener('pointercancel',pointerCancel);window.removeEventListener('blur',blur);document.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',key);el.removeEventListener('click',click,true);el.removeEventListener('contextmenu',context)};
 },[ref,textId]);
}
