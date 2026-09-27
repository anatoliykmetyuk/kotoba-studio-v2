import {useEffect,useMemo,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ArrowLeft,Layers,Volume2} from 'lucide-react';
import {api,waitJob,type Area,type Example} from './api';
import type {Pronunciation} from './speech';
const empty:Example[]=[];const emptyWords:Example['words']=[];
function shuffle<T>(items:readonly T[]):T[]{const result=[...items];for(let i=result.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[result[i],result[j]]=[result[j],result[i]]}return result}
const slice=(s:string,a:number,b?:number)=>Array.from(s).slice(a,b).join('');

export function Practice({textId,title,onClose,area,onError,speak,enqueue,stopSpeech}:{textId:string;title:string;onClose:()=>void;area:Area;onError:(e:string)=>void;speak:(input:Pronunciation)=>Promise<void>;enqueue:(input:Pronunciation)=>void;stopSpeech:()=>void}){
 const [run,setRun]=useState(0);const [session,setSession]=useState(0);const [kind,setKind]=useState<'matching'|'sentence'>('matching');const [index,setIndex]=useState(0);const [answer,setAnswer]=useState('');const [result,setResult]=useState<boolean|null>(null);const [all,setAll]=useState(true);const [pieces,setPieces]=useState<number[]>([]);const [checking,setChecking]=useState(false);
 const {data,isLoading,error,refetch}=useQuery({queryKey:['practice',textId,area,all],refetchOnWindowFocus:false,queryFn:({signal})=>api<{words:Example['words'];sentences:Example[]}>('/practice?'+new URLSearchParams({textId,area,states:all?'new,learning,familiar,known':'learning,familiar'}),undefined,undefined,{signal})});
 const words=useMemo(()=>shuffle(data?.words??emptyWords),[data?.words,run]);
 const examples=useMemo(()=>shuffle((data?.sentences??empty).filter(s=>s.words.length>=2&&s.body.length<=160)),[data?.sentences,run]);
 const word=words[index];const sentence=examples[index];
 const total=kind==='matching'?words.length:examples.length;const complete=total>0&&index>=total;
 const blocks=useMemo(()=>sentence?.words.map((w,i)=>({text:slice(sentence.body,i===0?0:w.start,sentence.words[i+1]?.start),audio:{occurrenceId:w.occurrenceId}}))??[],[sentence]);
 const shuffled=useMemo(()=>shuffle(blocks.map((block,i)=>({...block,i}))),[blocks,index]);
 const options=useMemo(()=>{
  if(!word)return [];
  const seen=new Set([word.meaning]);const candidates=shuffle(words).filter(w=>{if(seen.has(w.meaning))return false;seen.add(w.meaning);return true});
  return shuffle([word,...candidates.slice(0,3)]);
 },[word,words,index]);
 const [hint,setHint]=useState('');const [prepared,setPrepared]=useState('');const [preparation,setPreparation]=useState({seconds:0});const [loadError,setLoadError]=useState('');const [retry,setRetry]=useState(0);
 const challenge=session+':'+textId+':'+area+':'+all+':'+kind+':'+index+':'+(kind==='sentence'?sentence?.occurrenceId:word?.baseId);const active=useRef(challenge);active.current=challenge;const event=useRef('');
 const stopRef=useRef(stopSpeech);stopRef.current=stopSpeech;
 useEffect(()=>()=>{active.current='';stopRef.current()},[]);
 function clearAnswer(){setResult(null);setAnswer('');setPieces([]);setChecking(false)}
 function next(){stopSpeech();setIndex(i=>i+1);clearAnswer()}
 function reset(){active.current='';stopSpeech();setSession(value=>value+1);setIndex(0);clearAnswer()}
 function restart(){setRun(value=>value+1);reset()}
 const context=useRef(textId+':'+area);
 useEffect(()=>{const key=textId+':'+area;if(context.current!==key){context.current=key;reset()}},[textId,area]);
 useEffect(()=>{
  event.current=globalThis.crypto?.randomUUID?.()??Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);setResult(null);setAnswer('');setPieces([]);setChecking(false);
 },[challenge]);
 useEffect(()=>{
  if(result!==true)return;const timer=setTimeout(next,850);return()=>clearTimeout(timer);
 },[result,challenge]);
 useEffect(()=>{
  const controller=new AbortController();let finished=false;setPrepared('');setHint('');setLoadError('');
  if(kind!=='sentence'||!sentence)return;
  const started=Date.now();setPreparation({seconds:0});
  const clock=setInterval(()=>{if(!controller.signal.aborted&&!finished)setPreparation({seconds:Math.floor((Date.now()-started)/1000)})},1000);
  const deadline=setTimeout(()=>{controller.abort();setLoadError('Translation timed out. Retry to continue.');clearInterval(clock)},120_000);
  void (async()=>{
   const r=await api<{translation?:string;jobId?:string}>('/translations',{text:sentence.body},undefined,{signal:controller.signal});
   const text=r.translation??(await waitJob(r.jobId!,controller.signal)).translation;
   if(!controller.signal.aborted){setHint(text);setPrepared(challenge)}
  })().catch(e=>{if(!controller.signal.aborted)setLoadError((e as Error).message)}).finally(()=>{finished=true;clearTimeout(deadline);clearInterval(clock)});
  return()=>{controller.abort();clearTimeout(deadline);clearInterval(clock)};
 },[challenge,retry]);
 async function check(value:string){
  if(checking||result===true)return;const current=challenge;setChecking(true);
  try{const r=await api<{correct:boolean}>('/practice/answer',{textId,kind,targetId:kind==='matching'?word.baseId:sentence.sentenceId,answer:value,eventId:event.current+':'+value});if(active.current===current)setResult(r.correct)}catch(e){if(active.current===current)onError((e as Error).message)}finally{if(active.current===current)setChecking(false)}
 }
 const noChallenge=kind==='matching'?!word:!sentence;
 return <section className="page practice-page" data-text-id={textId}><header className="page-heading"><div><button className="back-button" onClick={onClose}><ArrowLeft size={18}/>Back to lesson</button><h1>Practice</h1><p>{title}</p></div></header><div className="practice-options"><div className="tabs"><button className={kind==='matching'?'active':''} onClick={()=>{setKind('matching');reset()}}>Match meanings</button><button className={kind==='sentence'?'active':''} onClick={()=>{setKind('sentence');reset()}}>Build a sentence</button></div><label><input type="checkbox" checked={all} onChange={e=>{setAll(e.target.checked);reset()}}/>Include all statuses</label></div>
 {!isLoading&&!error&&total>0&&<div className="practice-progress"><span aria-live="polite">{complete?`${total} of ${total} completed`:`Question ${index+1} of ${total}`}</span><progress aria-label="Practice progress" max={total} value={Math.min(index,total)}/></div>}
 {isLoading?<p role="status">Loading practice…</p>:error?<div className="empty" role="alert"><p>{error.message}</p><button onClick={()=>{void refetch()}}>Retry</button></div>:complete?<div className="practice-card"><h3>Practice complete</h3><button className="primary" onClick={restart}>Practice again</button></div>:noChallenge?<div className="empty"><Layers size={36}/><h3>{kind==='matching'?'No matching words':'No matching sentences'}</h3><p>{kind==='matching'?'This lesson has no words with stored meanings for the selected statuses.':'This lesson has no sentences with the selected statuses, at least two tokens, and at most 160 characters.'}</p>{!all&&<p>Include all statuses to use New and Known words.</p>}</div>:<div className="practice-card" data-challenge={challenge}>{kind==='matching'?<><h2 lang="ja">{word.base}</h2><button className="text-button" onClick={()=>{void speak({text:word.baseReading||word.base})}}><Volume2 size={17}/>Listen</button><div className="answer-grid">{options.map(o=><button key={o.baseId} className={answer===o.meaning?'selected':''} onClick={()=>{setAnswer(o.meaning);void check(o.meaning)}} disabled={checking||result===true}>{o.meaning}</button>)}</div></>:<><div className="sentence-translation" aria-live="polite" aria-busy={prepared!==challenge&&!loadError} data-ready={prepared===challenge}>{prepared===challenge?hint:loadError?<><p role="alert">{loadError}</p><button className="text-button" onClick={()=>setRetry(i=>i+1)}>Retry translation</button></>:<span>Translating…{preparation.seconds>0?` ${preparation.seconds}s elapsed`: ''}</span>}</div><button className="text-button" onClick={()=>{void speak({text:sentence.body})}}><Volume2 size={18}/>Listen to the sentence</button><div className="sentence-answer" lang="ja">{pieces.map(i=><button key={i} disabled={checking||result===true} onClick={()=>{setPieces(p=>p.filter(x=>x!==i));setResult(null);enqueue(blocks[i].audio)}}>{blocks[i].text}</button>)}</div><div className="pieces" lang="ja">{shuffled.map(({text,audio,i})=><button key={i} data-piece={i} disabled={checking||pieces.includes(i)||result===true} onClick={()=>{setPieces(p=>[...p,i]);setResult(null);enqueue(audio)}}>{text}</button>)}</div><button className="primary" disabled={pieces.length!==blocks.length||checking||result===true} onClick={()=>{void check(pieces.map(i=>blocks[i].text).join(''))}}>Check sentence</button></>}{result!==null&&<div className={'practice-feedback '+(result?'correct':'')} role="status">{result?'Correct':'Incorrect'}{result&&<span lang={kind==='sentence'?'ja':undefined}>{kind==='sentence'?sentence.body:word.meaning}</span>}</div>}</div>}
 </section>
}
