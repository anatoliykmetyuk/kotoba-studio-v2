import {useEffect,useMemo,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {ArrowLeft,Layers,Volume2} from 'lucide-react';
import {api,waitJob,type Area,type Example} from './api';
import {prepareSpeech,type Pronunciation} from './speech';
const empty:Example[]=[];const emptyWords:Example['words']=[];
function shuffle<T>(items:readonly T[]):T[]{const result=[...items];for(let i=result.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[result[i],result[j]]=[result[j],result[i]]}return result}
const slice=(s:string,a:number,b?:number)=>Array.from(s).slice(a,b).join('');

export function Practice({textId,title,onClose,area,onError,speak}:{textId:string;title:string;onClose:()=>void;area:Area;onError:(e:string)=>void;speak:(input:Pronunciation)=>Promise<void>}){
 const [kind,setKind]=useState<'matching'|'sentence'>('matching');const [index,setIndex]=useState(0);const [answer,setAnswer]=useState('');const [result,setResult]=useState<boolean|null>(null);const [all,setAll]=useState(true);const [pieces,setPieces]=useState<number[]>([]);const [checking,setChecking]=useState(false);
 const {data,isLoading,error,refetch}=useQuery({queryKey:['practice',textId,area,all],queryFn:({signal})=>api<{words:Example['words'];sentences:Example[]}>('/practice?'+new URLSearchParams({textId,area,states:all?'new,learning,familiar,known':'learning,familiar'}),undefined,undefined,{signal})});
 const words=useMemo(()=>shuffle(data?.words??emptyWords),[data?.words]);
 const examples=useMemo(()=>shuffle((data?.sentences??empty).filter(s=>s.words.length>=2&&s.body.length<=160)),[data?.sentences]);
 const word=words[index%Math.max(1,words.length)];const sentence=examples[index%Math.max(1,examples.length)];
 const blocks=useMemo(()=>sentence?.words.map((w,i)=>({text:slice(sentence.body,i===0?0:w.start,sentence.words[i+1]?.start),audio:{occurrenceId:w.occurrenceId}}))??[],[sentence]);
 const shuffled=useMemo(()=>shuffle(blocks.map((block,i)=>({...block,i}))),[blocks,index]);
 const options=useMemo(()=>{
  if(!word)return [];
  const seen=new Set([word.meaning]);const candidates=shuffle(words).filter(w=>{if(seen.has(w.meaning))return false;seen.add(w.meaning);return true});
  return shuffle([word,...candidates.slice(0,3)]);
 },[word,words,index]);
 const [hint,setHint]=useState('');const [prepared,setPrepared]=useState('');const [preparation,setPreparation]=useState({done:0,total:0});const [loadError,setLoadError]=useState('');const [retry,setRetry]=useState(0);
 const challenge=textId+':'+area+':'+all+':'+kind+':'+index+':'+(kind==='sentence'?sentence?.occurrenceId:word?.baseId);const active=useRef(challenge);active.current=challenge;const event=useRef('');
 function next(){setIndex(i=>i+1);setResult(null);setAnswer('');setPieces([]);setChecking(false)}
 useEffect(()=>{
  event.current=globalThis.crypto?.randomUUID?.()??Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);setResult(null);setAnswer('');setPieces([]);setChecking(false);
 },[challenge]);
 useEffect(()=>{
  if(result!==true)return;const timer=setTimeout(next,850);return()=>clearTimeout(timer);
 },[result,challenge]);
 useEffect(()=>{
  let cancelled=false;setPrepared('');setHint('');setLoadError('');
  if(kind!=='sentence'||!sentence)return;
  const total=blocks.length+2;let done=0;setPreparation({done,total});
  const finished=()=>{done++;if(!cancelled)setPreparation({done,total})};
  const translate=async()=>{const r=await api<{translation?:string;jobId?:string}>('/translations',{text:sentence.body});const text=r.translation??(await waitJob(r.jobId!)).translation;if(!cancelled)setHint(text);finished()};
  const tasks=[translate(),prepareSpeech({text:sentence.body}).then(finished),...blocks.map(b=>prepareSpeech(b.audio).then(finished))];
  void Promise.all(tasks).then(()=>{if(!cancelled)setPrepared(challenge)}).catch(e=>{if(!cancelled)setLoadError((e as Error).message)});
  return()=>{cancelled=true};
 },[challenge,retry]);
 async function check(value:string){
  if(checking||result===true)return;const current=challenge;setChecking(true);
  try{const r=await api<{correct:boolean}>('/practice/answer',{textId,kind,targetId:kind==='matching'?word.baseId:sentence.sentenceId,answer:value,eventId:event.current+':'+value});if(active.current===current)setResult(r.correct)}catch(e){onError((e as Error).message)}finally{if(active.current===current)setChecking(false)}
 }
 const noChallenge=kind==='matching'?!word:!sentence;
 return <section className="page practice-page" data-text-id={textId}><header className="page-heading"><div><button className="back-button" onClick={onClose}><ArrowLeft size={18}/>Back to lesson</button><h1>Practice</h1><p>{title}</p></div></header><div className="practice-options"><div className="tabs"><button className={kind==='matching'?'active':''} onClick={()=>{setKind('matching');next()}}>Match meanings</button><button className={kind==='sentence'?'active':''} onClick={()=>{setKind('sentence');next()}}>Build a sentence</button></div><label><input type="checkbox" checked={all} onChange={e=>{setAll(e.target.checked);next()}}/>Include all statuses</label></div>
 {isLoading?<p role="status">Loading practice…</p>:error?<div className="empty" role="alert"><p>{error.message}</p><button onClick={()=>{void refetch()}}>Retry</button></div>:noChallenge?<div className="empty"><Layers size={36}/><h3>{kind==='matching'?'No matching words':'No matching sentences'}</h3><p>{kind==='matching'?'This lesson has no words with stored meanings for the selected statuses.':'This lesson has no sentences with the selected statuses, at least two tokens, and at most 160 characters.'}</p>{!all&&<p>Include all statuses to use New and Known words.</p>}</div>:kind==='sentence'&&prepared!==challenge?<div className="practice-card" role="status">{loadError?<><p>{loadError}</p><button onClick={()=>setRetry(i=>i+1)}>Retry preparation</button></>:<><p>Preparing translation and audio</p><progress max={preparation.total||1} value={preparation.done}/><p>{preparation.done}/{preparation.total} ready</p></>}</div>:<div className="practice-card" data-challenge={challenge}>{kind==='matching'?<><h2 lang="ja">{word.base}</h2><button className="text-button" onClick={()=>{void speak({text:word.baseReading||word.base})}}><Volume2 size={17}/>Listen</button><div className="answer-grid">{options.map(o=><button key={o.baseId} className={answer===o.meaning?'selected':''} onClick={()=>{setAnswer(o.meaning);void check(o.meaning)}} disabled={checking||result===true}>{o.meaning}</button>)}</div></>:<><p className="sentence-translation">{hint}</p><button className="text-button" onClick={()=>{void speak({text:sentence.body})}}><Volume2 size={18}/>Listen to the sentence</button><div className="sentence-answer" lang="ja">{pieces.map(i=><button key={i} disabled={result===true} onClick={()=>{void speak(blocks[i].audio);setPieces(p=>p.filter(x=>x!==i));setResult(null)}}>{blocks[i].text}</button>)}</div><div className="pieces" lang="ja">{shuffled.map(({text,audio,i})=><button key={i} data-piece={i} disabled={pieces.includes(i)||result===true} onClick={()=>{void speak(audio);setPieces(p=>[...p,i]);setResult(null)}}>{text}</button>)}</div><button className="primary" disabled={pieces.length!==blocks.length||checking||result===true} onClick={()=>{void check(pieces.map(i=>blocks[i].text).join(''))}}>Check sentence</button></>}{result!==null&&<div className={'practice-feedback '+(result?'correct':'')} role="status">{result?'Correct':'Incorrect'}{result&&<span lang={kind==='sentence'?'ja':undefined}>{kind==='sentence'?sentence.body:word.meaning}</span>}</div>}</div>}
 </section>
}
