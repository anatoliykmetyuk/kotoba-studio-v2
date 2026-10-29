import {useEffect,useSyncExternalStore} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api,type TextItem} from './api';
import {reconcileTextStatuses} from './word-status';
import {applyCheckpoint,type CheckpointChange} from './checkpoints';
import {createCheckpointStore} from './checkpoint-store';

function storage(){try{return localStorage}catch{return null}}
const store=createCheckpointStore(storage());
const changed='kotoba:checkpoint-changed';

async function persistCheckpoint(text:TextItem){
 const worker=navigator.serviceWorker?.controller;if(!worker||!('caches' in window))return;
 // Both checkpoint receipts and word receipts use the worker's same write
 // queue. Acknowledge durability before removing the recoverable operation.
 await new Promise<void>((resolve,reject)=>{
  const channel=new MessageChannel();
  const finish=(error?:Error)=>{clearTimeout(timer);channel.port1.close();error?reject(error):resolve()};
  const timer=setTimeout(()=>finish(new Error('Reload the app to finish syncing reading progress.')),8000);
  channel.port1.onmessage=event=>finish(event.data?.ok?undefined:new Error('Could not save reading progress on this device.'));
  worker.postMessage({type:'checkpoint-cache',text:reconcileTextStatuses(text)},[channel.port2]);
 });
}

export function useCheckpointQueue(){return useSyncExternalStore(store.subscribe,store.getSnapshot)}
export function queuedText(text:TextItem,queue:ReturnType<typeof useCheckpointQueue>):TextItem{
 return queue.reduce((current,item)=>applyCheckpoint(current,item),text);
}
export function queueCheckpoint(change:CheckpointChange){store.add(change);dispatchEvent(new Event(changed))}

/** One acknowledged, idempotent writer, including lessons closed while offline. */
export function useCheckpointSync(){
 const client=useQueryClient();
 useEffect(()=>{
  let sending=false,disposed=false;
  async function send(){
   store.sync();
   while(!disposed&&navigator.onLine){
    store.sync();const item=store.getSnapshot()[0];if(!item)break;
    try{
     let result=await api<TextItem>('/texts/'+item.textId+'/checkpoint',{start:item.start,end:item.end,completed:item.completed},'PUT',{headers:{'Idempotency-Key':item.id},signal:AbortSignal.timeout(12_000)});
     // An idempotent retry can return an older receipt after another device
     // edited this lesson. Prefer the current view whenever it is reachable.
     try{const current=await api<TextItem>('/texts/'+item.textId,undefined,undefined,{cache:'no-store',signal:AbortSignal.timeout(12_000)});if(current.revision>=result.revision)result=current}catch{}
     const cached=client.getQueryData<TextItem>(['text',item.textId]);if(cached&&cached.revision>result.revision)result=cached;
     // The lesson may be closed: invalidating its inactive query cannot update
     // the service-worker cache. Persist before removing the durable operation.
     await persistCheckpoint(result);
     await client.cancelQueries({queryKey:['text',item.textId],exact:true});
     client.setQueryData(['text',item.textId],result);
     client.setQueryData<TextItem[]>(['library'],old=>old?.map(text=>text.id===item.textId?{...text,readingProgress:result.readingProgress,textState:result.textState}:text));
     store.acknowledge(item.id);
     void client.invalidateQueries({queryKey:['word-examples'],refetchType:'none'});
     for(const key of ['text','library','word','explore','practice','activity'])void client.invalidateQueries({queryKey:[key]});
    }catch{break}
   }
  }
  async function flush(){
   if(sending||disposed||!navigator.onLine)return;sending=true;
   try{
    if(navigator.locks)await navigator.locks.request('kotoba-checkpoints',{ifAvailable:true},async lock=>{if(lock)await send()});
    else await send();
   }finally{sending=false}
  }
  const resume=()=>{store.sync();void flush()};
  const visible=()=>{if(document.visibilityState==='visible')resume()};
  resume();addEventListener(changed,resume);addEventListener('online',resume);addEventListener('storage',resume);document.addEventListener('visibilitychange',visible);
  const timer=setInterval(resume,5000);
  return()=>{disposed=true;clearInterval(timer);removeEventListener(changed,resume);removeEventListener('online',resume);removeEventListener('storage',resume);document.removeEventListener('visibilitychange',visible)};
 },[client]);
}
