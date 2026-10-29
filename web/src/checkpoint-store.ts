import type {CheckpointChange} from './checkpoints';

export type QueuedCheckpoint=CheckpointChange&{id:string;createdAt:number};
export const checkpointPrefix='kotoba:checkpoint:';

function parse(raw:string|null):QueuedCheckpoint|null{
 try{
  const item=JSON.parse(raw??'null') as QueuedCheckpoint|null;
  return item&&typeof item.id==='string'&&typeof item.textId==='string'&&Number.isInteger(item.start)&&item.start>=0&&Number.isInteger(item.end)&&item.end>item.start&&typeof item.completed==='boolean'&&Number.isFinite(item.createdAt)?item:null;
 }catch{return null}
}

/** Immutable operations have independent keys; tabs never overwrite a queue. */
export function createCheckpointStore(storage:Storage|null){
 const listeners=new Set<()=>void>();let queue:QueuedCheckpoint[]=[];
 function sync(){
  if(!storage)return;
  const loaded:QueuedCheckpoint[]=[];
  try{for(let i=0;i<storage.length;i++){
   const key=storage.key(i);if(!key?.startsWith(checkpointPrefix))continue;
   const item=parse(storage.getItem(key));if(item&&key===checkpointPrefix+item.id)loaded.push(item);
  }}catch{return}
  loaded.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  if(JSON.stringify(loaded)===JSON.stringify(queue))return;
  queue=loaded;for(const listener of listeners)listener();
 }
 sync();
 return {
  getSnapshot:()=>queue,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
  sync,
  add(change:CheckpointChange){
   sync();const item={...change,id:crypto.randomUUID(),createdAt:Math.max(Date.now(),(queue.at(-1)?.createdAt??0)+1)};
   try{if(!storage)throw new Error();storage.setItem(checkpointPrefix+item.id,JSON.stringify(item))}
   catch{throw new Error('Could not save the checkpoint on this device. Check available browser storage and retry.')}
   sync();return item;
  },
  acknowledge(ids:string|string[]){for(const id of typeof ids==='string'?[ids]:ids)storage?.removeItem(checkpointPrefix+id);sync()},
 };
}


/** Coalesce only contiguous actions for one lesson. Their order, including undo,
 * remains unchanged, and operation IDs survive retries with a different batch. */
export function nextCheckpointBatch<T extends {textId:string}>(queue:readonly T[],limit=50):T[]{
 const result:T[]=[];
 for(const item of queue){if(result.length>=limit||result.length&&item.textId!==result[0].textId)break;result.push(item)}
 return result;
}
