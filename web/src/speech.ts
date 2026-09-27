import {useEffect,useRef,useState} from 'react';
import {api,waitJob} from './api';

export type Pronunciation={text?:string;occurrenceId?:string;transient?:boolean};
const key=(input:Pronunciation)=>input.occurrenceId?'occurrence:'+input.occurrenceId:'text:'+input.text;
const cached=new Map<string,string>();
const pending=new Map<string,Promise<string>>();

/** Explicit preparation for a requested practice challenge, never for imports. */
export function prepareSpeech(input:Pronunciation):Promise<string>{
 const id=key(input);if(cached.has(id))return Promise.resolve(cached.get(id)!);
 if(pending.has(id))return pending.get(id)!;
 const task=(async()=>{
  const result=await api<{url?:string;jobId?:string}>('/speech',input);
  const url=result.url??(await waitJob(result.jobId!)).url;
  const response=await fetch(url);if(!response.ok)throw new Error('Pronunciation could not load.');
  const blob=await response.blob();const local=URL.createObjectURL(blob);
  cached.set(id,local);
  // Bound the in-memory media cache. The immutable server files remain cached
  // by the browser and the database after this page cache releases them.
  if(cached.size>160){const oldest=cached.keys().next().value!;const old=cached.get(oldest)!;cached.delete(oldest);URL.revokeObjectURL(old)}
  return local;
 })().finally(()=>pending.delete(id));pending.set(id,task);return task;
}

/** Native media playback stays on the media channel on iOS, including silent mode. */
export function useSpeech(onError:(message:string)=>void){
 const audioRef=useRef<HTMLAudioElement>(null);const sequence=useRef(0);const [busy,setBusy]=useState(false);
 function stop(){sequence.current++;audioRef.current?.pause();setBusy(false)}
 async function speak(input:Pronunciation){
  const audio=audioRef.current;if(!audio)return;
  const attempt=++sequence.current;onError('');setBusy(true);audio.pause();
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
   if(!input.transient&&!cached.has(key(input)))void prepareSpeech(input).catch(()=>undefined);
  }catch(e){if(sequence.current===attempt&&(e as Error).name!=='AbortError')onError('Pronunciation could not play. Tap the sound button to retry.')}
  finally{if(sequence.current===attempt)setBusy(false)}
 }
 useEffect(()=>{
  function hide(){if(document.visibilityState==='hidden'){sequence.current++;audioRef.current?.pause();setBusy(false)}}
  document.addEventListener('visibilitychange',hide);const audio=audioRef.current;
  return()=>{sequence.current++;audio?.pause();document.removeEventListener('visibilitychange',hide)};
 },[]);
 return {audioRef,busy,speak,stop};
}
