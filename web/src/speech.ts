import {useEffect,useRef,useState} from 'react';
import {api,waitJob} from './api';
import {PlaybackQueue} from './speech-queue';

export type Pronunciation={text?:string;occurrenceId?:string;transient?:boolean};
const key=(input:Pronunciation)=>input.occurrenceId?'occurrence:'+input.occurrenceId:'text:'+input.text;
const cached=new Map<string,string>();
type Preparation={promise:Promise<string>;controller:AbortController;consumers:number};
const pending=new Map<string,Preparation>();

function consume(entry:Preparation,signal?:AbortSignal):Promise<string>{
 entry.consumers++;
 return new Promise((resolve,reject)=>{
  let finished=false;
  const finish=(result?:string,error?:unknown)=>{
   if(finished)return;finished=true;signal?.removeEventListener('abort',abort);entry.consumers--;
   if(!entry.consumers)entry.controller.abort();
   error?reject(error):resolve(result!);
  };
  const abort=()=>finish(undefined,signal?.reason??new DOMException('Cancelled','AbortError'));
  signal?.addEventListener('abort',abort,{once:true});
  entry.promise.then(result=>finish(result),error=>finish(undefined,error));
  if(signal?.aborted)abort();
 });
}

/** Prepare only explicitly requested pronunciation, never imports or unopened challenges. */
export function prepareSpeech(input:Pronunciation,signal?:AbortSignal):Promise<string>{
 if(signal?.aborted)return Promise.reject(signal.reason??new DOMException('Cancelled','AbortError'));
 const id=key(input);if(cached.has(id))return Promise.resolve(cached.get(id)!);
 const existing=pending.get(id);if(existing&&!existing.controller.signal.aborted)return consume(existing,signal);
 const controller=new AbortController();const timeout=new Error('Pronunciation preparation timed out. Please retry.');
 const timer=setTimeout(()=>controller.abort(timeout),120_000);
 const task=(async()=>{
  const result=await api<{url?:string;jobId?:string}>('/speech',input,undefined,{signal:controller.signal});
  const url=result.url??(await waitJob(result.jobId!,controller.signal,120_000)).url;
  if(!url)throw new Error('Pronunciation is unavailable. Please retry.');
  const response=await fetch(url,{signal:controller.signal});if(!response.ok)throw new Error('Pronunciation could not load.');
  const blob=await response.blob();if(controller.signal.aborted)throw controller.signal.reason;
  if(!blob.size)throw new Error('Pronunciation is empty. Please retry.');const local=URL.createObjectURL(blob);
  cached.set(id,local);
  // Bound the in-memory media cache. The immutable server files remain cached
  // by the browser and the database after this page cache releases them.
  if(cached.size>160){const oldest=cached.keys().next().value!;const old=cached.get(oldest)!;cached.delete(oldest);URL.revokeObjectURL(old)}
  return local;
 })().catch(error=>{if(controller.signal.aborted)throw controller.signal.reason;throw error}).finally(()=>{clearTimeout(timer);if(pending.get(id)?.promise===task)pending.delete(id)});
 const entry={promise:task,controller,consumers:0};pending.set(id,entry);return consume(entry,signal);
}

/** Native media playback stays on the media channel on iOS, including silent mode. */
export function useSpeech(onError:(message:string)=>void){
 const audioRef=useRef<HTMLAudioElement>(null);const sequence=useRef(0);const [busy,setBusy]=useState(false);
 const playing=useRef(false);const playRef=useRef<(input:Pronunciation)=>Promise<void>>(null);const errorRef=useRef(onError);errorRef.current=onError;
 const preparations=useRef(new Map<string,AbortController>());const prepareRef=useRef<(input:Pronunciation)=>void>(null);
 const queue=useRef(new PlaybackQueue<Pronunciation>(input=>{void playRef.current?.(input)},input=>prepareRef.current?.(input),()=>{for(const controller of preparations.current.values())controller.abort();preparations.current.clear()}));
 function prepare(input:Pronunciation){
  const id=key(input);if(input.transient||cached.has(id)||preparations.current.has(id))return;
  const controller=new AbortController();preparations.current.set(id,controller);
  // Each clicked token starts generation now, even while an earlier one plays.
  // Native playback reports failures; this independent consumer fills the cache.
  void prepareSpeech(input,controller.signal).catch(()=>undefined).finally(()=>{if(preparations.current.get(id)===controller)preparations.current.delete(id)});
 }
 prepareRef.current=prepare;
 function stop(){queue.current.clear();playing.current=false;sequence.current++;audioRef.current?.pause();setBusy(false)}
 function speak(input:Pronunciation){queue.current.clear();return play(input)}
 function enqueue(input:Pronunciation){queue.current.enqueue(input)}
 async function play(input:Pronunciation){
  const audio=audioRef.current;if(!audio)return;
  const attempt=++sequence.current;playing.current=true;onError('');setBusy(true);audio.pause();
  const session=(navigator as Navigator & {audioSession?:{type:string}}).audioSession;
  if(session){try{session.type='playback'}catch{}}
  const params=new URLSearchParams();
  if(input.occurrenceId)params.set('occurrenceId',input.occurrenceId);else if(input.text)params.set('text',input.text);
  audio.muted=false;audio.volume=1;
  if(input.transient)params.set('request',crypto.randomUUID());
  const url=input.transient?'/api/v1/phrase-tools/speech/play?'+params:cached.get(key(input))??'/api/v1/speech/play?'+params;
  if(audio.getAttribute('src')!==url)audio.src=url;else audio.currentTime=0;
  try{
   // Start in the tap event; never await generation/fetch before play().
   await audio.play();
   if(sequence.current===attempt)prepare(input);
  }catch(e){if(sequence.current===attempt){queue.current.clear();playing.current=false;if((e as Error).name!=='AbortError')onError('Pronunciation could not play. Tap the sound button to retry.')}}
  finally{if(sequence.current===attempt)setBusy(false)}
 }
 playRef.current=play;
 useEffect(()=>{
  function hide(){if(document.visibilityState==='hidden')stop()}
  function ended(){playing.current=false;queue.current.ended()}
  function failed(){if(!playing.current)return;queue.current.clear();playing.current=false;sequence.current++;setBusy(false);errorRef.current('Pronunciation could not play. Tap the sound button to retry.')}
  document.addEventListener('visibilitychange',hide);const audio=audioRef.current;
  audio?.addEventListener('ended',ended);audio?.addEventListener('error',failed);
  return()=>{queue.current.clear();playing.current=false;sequence.current++;audio?.pause();document.removeEventListener('visibilitychange',hide);audio?.removeEventListener('ended',ended);audio?.removeEventListener('error',failed)};
 },[]);
 return {audioRef,busy,speak,enqueue,stop};
}
