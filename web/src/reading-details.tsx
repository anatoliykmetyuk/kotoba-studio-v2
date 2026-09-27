import {useEffect,useRef,type ReactNode} from 'react';
import {RefreshCw,Volume2,X} from 'lucide-react';
import {useSwipeDismiss} from './touch';
import {usePopupScrollLock} from './popup-scroll-lock';
import {CopyButton} from './copy-button';

/** The same overlay, heading and playback control for a word or selected phrase. */
export function ReadingDetails({label,closeLabel,text,reading,textClass,copyLabel,pronounceLabel,speak,busy,close,children}:{
 label:string;closeLabel:string;text:string;reading?:string;textClass?:string;copyLabel:string;
 pronounceLabel:string;speak:()=>Promise<void>;busy:boolean;close:()=>void;children:ReactNode;
}){
 const ref=useRef<HTMLElement>(null);const drag=useSwipeDismiss(ref,close);usePopupScrollLock(ref);
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;
  ref.current?.focus({preventScroll:true});
  return()=>{if(previous?.isConnected)previous.focus({preventScroll:true})};
 },[]);
 useEffect(()=>{
  function key(event:KeyboardEvent){
   if(event.key==='Escape'){event.preventDefault();close()}
   if(event.key!=='Tab')return;
   const nodes=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')??[]).filter(node=>node.getClientRects().length>0);
   event.preventDefault();
   const current=nodes.indexOf(document.activeElement as HTMLElement);
   const next=event.shiftKey?(current<=0?nodes.length-1:current-1):(current+1)%nodes.length;
   nodes[next]?.focus();
  }
  addEventListener('keydown',key);return()=>removeEventListener('keydown',key);
 },[close]);
 return <><div className="sheet-backdrop" onClick={close}/><aside ref={ref} style={{transform:drag?`translateY(${drag}px)`:undefined}} tabIndex={-1} className="word-panel" role="dialog" aria-modal="true" aria-label={label}>
  <div className="sheet-drag-area" role="button" tabIndex={0} aria-label="Drag down to close" onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();close()}}}><div className="sheet-handle"/></div>
  <div className="word-panel-head"><button className="icon-button" aria-label={closeLabel} title={closeLabel} onClick={close}><X size={20}/></button></div>
  <div className="word-scroll"><div className="word-title"><CopyButton text={text} label={copyLabel}/><div>{reading&&<span className="word-reading" lang="ja">{reading}</span>}<h2 lang="ja" className={textClass}>{text}</h2></div><button className="icon-button" aria-label={pronounceLabel} title={pronounceLabel} onClick={()=>void speak()} disabled={busy}>{busy?<RefreshCw className="spin" size={21}/>:<Volume2 size={24}/>}</button></div>{children}</div>
 </aside></>;
}
