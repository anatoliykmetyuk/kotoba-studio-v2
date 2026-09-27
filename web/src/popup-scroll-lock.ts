import {useLayoutEffect,type RefObject} from 'react';

type SavedStyle={element:HTMLElement;property:string;value:string;priority:string};
const popups=new Map<symbol,HTMLElement>();
let restoreDocument:(()=>void)|undefined;

function lockDocument(){
 const root=document.documentElement,body=document.body;
 const x=window.scrollX,y=window.scrollY;
 const saved:SavedStyle[]=[];
 function set(element:HTMLElement,property:string,value:string){
  saved.push({element,property,value:element.style.getPropertyValue(property),priority:element.style.getPropertyPriority(property)});
  element.style.setProperty(property,value);
 }
 const scrollbar=Math.max(0,window.innerWidth-root.clientWidth);
 const padding=parseFloat(getComputedStyle(body).paddingRight)||0;
 set(root,'overflow','hidden');set(root,'overscroll-behavior','none');set(root,'scroll-behavior','auto');
 set(body,'position','fixed');set(body,'top',`${-y}px`);set(body,'left',`${-x}px`);set(body,'width','100%');set(body,'overflow','hidden');
 if(scrollbar)set(body,'padding-right',`${padding+scrollbar}px`);

 let touch:{x:number;y:number}|null=null;
 const start=(event:TouchEvent)=>{touch=event.touches.length===1?{x:event.touches[0].clientX,y:event.touches[0].clientY}:null};
 const move=(event:TouchEvent)=>{
  if(!touch||event.touches.length!==1)return;
  const point=event.touches[0],dx=point.clientX-touch.x,dy=point.clientY-touch.y;
  touch={x:point.clientX,y:point.clientY};
  const popup=Array.from(popups.values()).at(-1);
  const target=event.target instanceof Element?event.target:null;
  if(popup&&target&&popup.contains(target)){
   // Range controls own their pointer gesture. They already disable native pan.
   if(target.closest('input[type="range"]'))return;
   for(let element:Element|null=target;element&&popup.contains(element);element=element.parentElement){
    const style=getComputedStyle(element),vertical=Math.abs(dy)>=Math.abs(dx);
    const overflow=vertical?style.overflowY:style.overflowX;
    const delta=vertical?dy:dx;
    const position=vertical?element.scrollTop:element.scrollLeft;
    const remaining=vertical?element.scrollHeight-element.clientHeight:element.scrollWidth-element.clientWidth;
    if(/auto|scroll|overlay/.test(overflow)&&remaining>1&&((delta>0&&position>0)||(delta<0&&position<remaining-1)))return;
   }
  }
  // Fixed body prevents page movement in Safari; this also prevents overscroll
  // chaining from a popup boundary and touches on its backdrop.
  if(event.cancelable)event.preventDefault();
 };
 document.addEventListener('touchstart',start,{passive:true});
 document.addEventListener('touchmove',move,{passive:false});
 return ()=>{
  document.removeEventListener('touchstart',start);document.removeEventListener('touchmove',move);
  for(const {element,property,value,priority} of saved.filter(entry=>entry.property!=='scroll-behavior')){
   if(value)element.style.setProperty(property,value,priority);else element.style.removeProperty(property);
  }
  window.scrollTo(x,y);
  const behavior=saved.find(entry=>entry.property==='scroll-behavior')!;
  if(behavior.value)root.style.setProperty(behavior.property,behavior.value,behavior.priority);else root.style.removeProperty(behavior.property);
 };
}

/** Keep the document at its current reading position while any popup is open. */
export function usePopupScrollLock(ref:RefObject<HTMLElement|null>,mobileOnly=false){
 useLayoutEffect(()=>{
  const element=ref.current;if(!element)return;
  const owner=Symbol('popup'),media=window.matchMedia('(max-width:900px)');
  function release(){
   if(!popups.delete(owner))return;
   if(!popups.size){restoreDocument?.();restoreDocument=undefined}
  }
  function sync(){
   if(mobileOnly&&!media.matches){release();return}
   if(popups.has(owner))return;
   if(!popups.size)restoreDocument=lockDocument();
   popups.set(owner,element!);
  }
  sync();if(mobileOnly)media.addEventListener('change',sync);
  return()=>{media.removeEventListener('change',sync);release()};
 },[ref,mobileOnly]);
}
