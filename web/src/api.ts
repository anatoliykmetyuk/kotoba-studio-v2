import type {components} from './generated-api';
export type State=components['schemas']['Status']['state'];
export type Token={id:string;wordId:string;surface:string;reading:string;meaning:string;baseId:string;base:string;start:number;end:number;state:State;statusRevision:number};
export type Sentence={id:string;sentenceId:string;ordinal:number;body:string;start:number;end:number;tokens:Token[]};
export type TextItem={id:string;title:string;body:string;textState:'new'|'completed';cursor:number;revision:number;archived:boolean;folders?:{id:string;name:string}[];updatedAt:string;sentences:Sentence[];sources:{url:string;sourceType:string}[];phrases:{phrase:{id:string;surface:string;meaning:string};states:{state:State;revision:number}[]}[]};
export type Meaning={id:string;body:string;reading:string;partOfSpeech:string;sourceType:string};
export type ImportProgress={stage:string;percent:number;completed:number;total:number;elapsedSeconds:number;estimatedRemainingSeconds:number|null;secondsSinceProgress:number;stalled:boolean};
export type Job={id:string;kind:string;title:string;state:string;error:string;result:Record<string,string>;progress:ImportProgress};
export type WordDetail={meanings:Meaning[];id:string;surface:string;reading:string;meaning:string;base:{id:string;surface:string};status:{state:State;revision:number};forms:{id:string;surface:string;reading:string}[];examples:{occurrenceId:string;textId:string;title:string;body:string;start:number;seen:boolean}[]};
export type Example={textId:string;title:string;textState:string;sentenceId:string;occurrenceId:string;body:string;start:number;seen:boolean;coverage:number;counts:Record<State,number>;words:{occurrenceId:string;reading:string;baseId:string;base:string;baseReading:string;wordId:string;surface:string;meaning:string;state:State;start:number;end:number}[]};
export type Settings={theme:'light'|'dark'|'system';fontSize:number;lineHeight:number;readerLayout?:'book';furigana:boolean};
const statusOrder:State[]=['new','learning','familiar','known'];
export function unifyCachedStatuses<T>(path:string,value:T):T{
 // The read cache outlives shell updates. Preserve offline reading of entries
 // saved by the former two-area client without clearing the user's cache.
 type Legacy={states?:Record<string,State>;statusRevisions?:Record<string,number>;statuses?:Record<string,{state:State;revision:number}>};
 if(/^\/texts\/[^/?]+$/.test(path)){
  const text=value as TextItem;
  if(!Array.isArray(text.sentences))return value;
  return {...text,sentences:text.sentences.map(sentence=>({...sentence,tokens:sentence.tokens.map(token=>{
   const old=token as Token&Legacy;
   if(token.state||!old.states)return token;
   const state=statusOrder.find(state=>Object.values(old.states!).includes(state));
   return {...token,state:state??'new',statusRevision:Math.max(0,...Object.values(old.statusRevisions??{}))};
  })}))} as T;
 }
 if(/^\/words\/[^/?]+$/.test(path)){
  const word=value as WordDetail&Legacy;
  if(!word.status&&word.statuses){const values=Object.values(word.statuses);return {...word,status:{state:statusOrder.find(state=>values.some(s=>s.state===state))??'new',revision:Math.max(0,...values.map(s=>s.revision))}} as T}
 }
 return value;
}
export async function api<T>(path:string,body?:unknown,method?:string,options:RequestInit={}):Promise<T>{
 const r=await fetch('/api/v1'+path,{...options,method:method??(body===undefined?'GET':'POST'),headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 if(!r.ok){let j:{message?:string;detail?:unknown}={};try{j=await r.json()}catch{};throw new Error(j.message??(typeof j.detail==='string'?j.detail:`Request failed (${r.status}). Please retry.`));}return unifyCachedStatuses(path,await r.json());
}
function pollDelay(signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  const finish=(error?:unknown)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);document.removeEventListener('visibilitychange',visible);window.removeEventListener('pageshow',resume);error?reject(error):resolve()};
  const abort=()=>finish(signal.reason??new DOMException('Cancelled','AbortError'));
  const resume=()=>finish();const visible=()=>{if(document.visibilityState==='visible')resume()};
  const timer=setTimeout(resume,1000);signal.addEventListener('abort',abort,{once:true});document.addEventListener('visibilitychange',visible);window.addEventListener('pageshow',resume);
  if(signal.aborted)abort();
 });
}
export async function waitJob(id:string,signal?:AbortSignal,timeoutMs=600_000):Promise<Record<string,string>>{
 const controller=new AbortController();const abort=()=>controller.abort(signal?.reason??new DOMException('Cancelled','AbortError'));
 const timeout=new Error('This request is still processing. Please retry.');const expires=Date.now()+timeoutMs;
 const timer=setTimeout(()=>controller.abort(timeout),timeoutMs);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{
  while(true){
   if(Date.now()>=expires)controller.abort(timeout);
   if(controller.signal.aborted)throw controller.signal.reason;
   const j=await api<{state:string;result:Record<string,string>;error:string}>('/jobs/'+id,undefined,undefined,{signal:controller.signal,cache:'no-store'});
   if(j.state==='ready')return j.result;
   if(j.state==='failed')throw new Error(j.error||'This request failed. Please retry.');
   await pollDelay(controller.signal);
  }
 }catch(error){if(controller.signal.aborted)throw controller.signal.reason;throw error}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
}
