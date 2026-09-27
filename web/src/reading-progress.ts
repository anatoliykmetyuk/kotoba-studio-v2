import {useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api} from './api';

const readingLine=.8;
type Position={wordEnd:number;offset:number;cursor:number};
function storedPosition(key:string):Position|null{
 try{
  const value=JSON.parse(localStorage.getItem(key)??'null') as Position|null;
  return value&&Number.isFinite(value.wordEnd)&&value.wordEnd>0&&Number.isFinite(value.offset)&&Number.isFinite(value.cursor)?value:null;
 }catch{return null}
}

/** Visual position is local; the queued/server cursor remains the furthest read. */
export function useReadingProgress(id:string,initialCursor:number,root:RefObject<HTMLElement|null>){
 const client=useQueryClient();const [state,setState]=useState<'saved'|'saving'|'pending'>('saved');const latest=useRef(initialCursor);latest.current=initialCursor;
 const refreshCursor=useRef<((cursor:number)=>void)|null>(null);
 useLayoutEffect(()=>{
  const key='kotoba:cursor:'+id,positionKey='kotoba:position:'+id;
  let confirmed=latest.current,pending=Math.max(confirmed,Number(localStorage.getItem(key))||0);
  let sending=false,mounted=true,restoring=true,hasScrolled=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const position=storedPosition(positionKey);
  // A newer cursor from another device supersedes this device's older bookmark.
  const words=()=>Array.from(root.current?.querySelectorAll<HTMLElement>('[data-word-end]')??[]);
  const savedWord=position&&position.cursor>=pending?words().find(el=>Number(el.dataset.wordEnd)===position.wordEnd):undefined;
  let bookmark=savedWord?position:null;
  let resume=savedWord??words().filter(el=>Number(el.dataset.wordEnd)<=pending).at(-1);
  let restoredCursor=pending;
  const explicitDestination=new URLSearchParams(location.hash.split('?')[1]).has('sentence');
  const previousRestoration=history.scrollRestoration;history.scrollRestoration='manual';
  function blocked(){return root.current?.dataset.textId!==id||document.body.style.position==='fixed'||!!document.querySelector('.word-panel,dialog[open]')}
  function restore(){
   if(explicitDestination||blocked())return;
   // Saving and the cross-device fallback use the same line. Restoring the
   // first unread word at the top used to skip most of a viewport on each open.
   if(resume)window.scrollBy({top:resume.getBoundingClientRect().bottom-innerHeight*(bookmark?.offset??readingLine),behavior:'instant'});
   else window.scrollTo({top:0,behavior:'instant'});
  }
  function layout(){return [innerWidth,innerHeight,root.current?.offsetHeight].join(':')}
  function documentTop(){return (root.current?.getBoundingClientRect().top??0)+scrollY}
  restore();let lastY=scrollY,lastTop=documentTop(),lastLayout=layout();
  function rebase(){lastY=scrollY;lastTop=documentTop();lastLayout=layout()}
  refreshCursor.current=cursor=>{
   confirmed=Math.max(confirmed,cursor);pending=Math.max(pending,cursor);
   if(Number(localStorage.getItem(key))<=confirmed)localStorage.removeItem(key);
   // A cached query may mount the reader before its fresh server cursor arrives.
   // Only untouched readers follow that newer cursor; save acknowledgements
   // and background refetches must not move someone who has started scrolling.
   if(!hasScrolled&&cursor>restoredCursor){
    restoredCursor=cursor;bookmark=null;resume=words().filter(el=>Number(el.dataset.wordEnd)<=cursor).at(-1);restore();rebase();
   }
  };
  const restoreFrame=requestAnimationFrame(()=>{restoring=false;rebase()});
  // Settings can arrive after the text. Preserve the initial anchor through
  // that layout change, but never credit browser scroll anchoring as reading.
  const observer=new ResizeObserver(()=>{
   if(blocked()||layout()===lastLayout)return;
   if(!hasScrolled)restore();rebase();
  });
  if(root.current)observer.observe(root.current);
  setState(pending>confirmed?'saving':'saved');
  function collect(forward:boolean){
   let next=Math.max(pending,latest.current),anchor:HTMLElement|undefined,distance=Infinity;
   for(const el of words()){
    const bottom=el.getBoundingClientRect().bottom;
    if(forward&&bottom>0&&bottom<innerHeight*readingLine)next=Math.max(next,Number(el.dataset.wordEnd));
    const delta=Math.abs(bottom-innerHeight*readingLine);
    if(delta<distance){anchor=el;distance=delta}
   }
   if(next>pending){pending=next;localStorage.setItem(key,String(pending));setState('saving')}
   if(anchor)localStorage.setItem(positionKey,JSON.stringify({wordEnd:Number(anchor.dataset.wordEnd),offset:anchor.getBoundingClientRect().bottom/innerHeight,cursor:pending} satisfies Position));
  }
  async function send(keepalive=false){
   if(pending<=confirmed||sending&&!keepalive)return;
   const target=pending;sending=true;
   try{
    await api('/texts/'+id+'/progress',{cursor:target},'PUT',{keepalive});confirmed=Math.max(confirmed,target);
    if(Number(localStorage.getItem(key))<=confirmed)localStorage.removeItem(key);
    if(mounted){
     setState(pending>confirmed?'saving':'saved');void client.invalidateQueries({queryKey:['text',id]});void client.invalidateQueries({queryKey:['library']});void client.invalidateQueries({queryKey:['activity']});
     if(pending>confirmed){clearTimeout(timer);timer=setTimeout(()=>{void send()},1000)}
    }
   }catch{if(mounted){setState('pending');clearTimeout(timer);timer=setTimeout(()=>{void send()},5000)}}
   finally{sending=false}
  }
  function scroll(){
   // Keep the pre-popup baseline while body locking temporarily makes scrollY
   // zero. Unlocking restores that same value and must not create progress.
   if(restoring||blocked())return;
   const currentY=scrollY;
   if(layout()!==lastLayout){rebase();return}
   // A banner outside the reader can change the page height and browser scroll
   // anchoring. Subtract that reader displacement instead of discarding the
   // next real scroll, including an immediate scroll after going offline.
   const pageDelta=currentY-lastY,delta=pageDelta-(documentTop()-lastTop);rebase();
   if(Math.abs(pageDelta)<1||Math.abs(delta)<1)return;
   // Without browser anchoring, removing a banner can make the adjusted delta
   // positive even during a backward scroll. Both movements must be forward.
   hasScrolled=true;collect(pageDelta>0&&delta>0);
   clearTimeout(timer);timer=setTimeout(()=>{void send()},1000);
  }
  function hide(){if(document.visibilityState==='hidden')void send(true)}
  function leave(){void send(true)}
  function online(){void send()}
  void send();
  addEventListener('scroll',scroll,{passive:true});addEventListener('pagehide',leave);addEventListener('online',online);document.addEventListener('visibilitychange',hide);
  return()=>{
   mounted=false;refreshCursor.current=null;clearTimeout(timer);cancelAnimationFrame(restoreFrame);observer.disconnect();void send(true);
   history.scrollRestoration=previousRestoration;
   removeEventListener('scroll',scroll);removeEventListener('pagehide',leave);removeEventListener('online',online);document.removeEventListener('visibilitychange',hide);
  };
 },[id,client,root]);
 useLayoutEffect(()=>{refreshCursor.current?.(initialCursor)},[id,initialCursor]);
 return state;
}

/** Flush all pending text cursors, including texts closed while offline. */
export function useProgressSync(){
 const client=useQueryClient();
 useEffect(()=>{
  let sending=false;let disposed=false;
  async function flush(){
   if(sending||!navigator.onLine)return;sending=true;
   try{for(const key of Object.keys(localStorage).filter(k=>k.startsWith('kotoba:cursor:'))){
    if(disposed)break;const cursor=Number(localStorage.getItem(key));if(!Number.isFinite(cursor)||cursor<=0)continue;
    try{await api('/texts/'+key.slice('kotoba:cursor:'.length)+'/progress',{cursor},'PUT');if(Number(localStorage.getItem(key))<=cursor)localStorage.removeItem(key);void client.invalidateQueries({queryKey:['text']});void client.invalidateQueries({queryKey:['library']})}catch{break}
   }}finally{sending=false}
  }
  const online=()=>{void flush()};online();addEventListener('online',online);const timer=setInterval(online,5000);
  return()=>{disposed=true;clearInterval(timer);removeEventListener('online',online)};
 },[client]);
}
