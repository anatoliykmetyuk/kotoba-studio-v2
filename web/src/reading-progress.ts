import {useLayoutEffect,type RefObject} from 'react';

const readingLine=.8;
type Position={wordEnd:number;offset:number};
function storedPosition(key:string):Position|null{
 try{
  const value=JSON.parse(localStorage.getItem(key)??'null') as Position|null;
  return value&&Number.isFinite(value.wordEnd)&&value.wordEnd>0&&Number.isFinite(value.offset)?value:null;
 }catch{return null}
}

/** Scrolling saves only a device-local viewport bookmark. */
export function useReadingPosition(id:string,root:RefObject<HTMLElement|null>){
 useLayoutEffect(()=>{
  const positionKey='kotoba:position:'+id,position=storedPosition(positionKey);
  let restoring=true,hasScrolled=false;
  const words=()=>Array.from(root.current?.querySelectorAll<HTMLElement>('[data-word-end]')??[]);
  const resume=position?words().find(el=>Number(el.dataset.wordEnd)===position.wordEnd):undefined;
  const explicitDestination=new URLSearchParams(location.hash.split('?')[1]).has('sentence');
  const previousRestoration=history.scrollRestoration;history.scrollRestoration='manual';
  function blocked(){return root.current?.dataset.textId!==id||document.body.style.position==='fixed'||!!document.querySelector('.word-panel,dialog[open]')}
  function restore(){
   if(explicitDestination||blocked())return;
   if(resume)window.scrollBy({top:resume.getBoundingClientRect().bottom-innerHeight*(position?.offset??readingLine),behavior:'instant'});
   else window.scrollTo({top:0,behavior:'instant'});
  }
  function layout(){return [innerWidth,innerHeight,root.current?.offsetHeight].join(':')}
  function documentTop(){return (root.current?.getBoundingClientRect().top??0)+scrollY}
  restore();let lastY=scrollY,lastTop=documentTop(),lastLayout=layout();
  function rebase(){lastY=scrollY;lastTop=documentTop();lastLayout=layout()}
  const restoreFrame=requestAnimationFrame(()=>{restoring=false;rebase()});
  const observer=new ResizeObserver(()=>{
   if(blocked()||layout()===lastLayout)return;
   if(!hasScrolled)restore();rebase();
  });
  if(root.current)observer.observe(root.current);
  function scroll(){
   if(restoring||blocked())return;
   if(layout()!==lastLayout){rebase();return}
   const pageDelta=scrollY-lastY,delta=pageDelta-(documentTop()-lastTop);rebase();
   if(Math.abs(pageDelta)<1||Math.abs(delta)<1)return;
   hasScrolled=true;
   let anchor:HTMLElement|undefined,distance=Infinity;
   for(const el of words()){
    const difference=Math.abs(el.getBoundingClientRect().bottom-innerHeight*readingLine);
    if(difference<distance){anchor=el;distance=difference}
   }
   if(anchor)try{localStorage.setItem(positionKey,JSON.stringify({wordEnd:Number(anchor.dataset.wordEnd),offset:anchor.getBoundingClientRect().bottom/innerHeight} satisfies Position))}catch{}
  }
  addEventListener('scroll',scroll,{passive:true});
  return()=>{cancelAnimationFrame(restoreFrame);observer.disconnect();history.scrollRestoration=previousRestoration;removeEventListener('scroll',scroll)};
 },[id,root]);
}
