export type ExistingFolder={id:string;name:string};
export type Filing={id:string;folder:ExistingFolder;jobId?:string;textId?:string;error?:string};
export const legacyFilingKey='kotoba:import-filing';
export const filingEntryPrefix=legacyFilingKey+':';

function entry(value:unknown):Filing|null{
 if(!value||typeof value!=='object')return null;
 const f=value as Filing;
 if(typeof f.id!=='string'||!f.id||typeof f.folder?.id!=='string'||typeof f.folder?.name!=='string'||(!f.jobId&&!f.textId)||(f.jobId!==undefined&&typeof f.jobId!=='string')||(f.textId!==undefined&&typeof f.textId!=='string')||(f.error!==undefined&&typeof f.error!=='string'))return null;
 // Older clients persisted job-observation failures as filing failures.
 return f.textId?f:{...f,error:undefined};
}
function parse(raw:string|null):unknown{try{return JSON.parse(raw??'null')}catch{return null}}

/** Each accepted request owns a storage key, so tabs never rewrite each other's queue. */
export function createFilingStore(storage:Storage|null){
 const listeners=new Set<()=>void>();const dirty=new Set<string>();
 function load():Filing[]{
  const found=new Map<string,Filing>();
  if(!storage)return [];
  try{
   const legacy=parse(storage.getItem(legacyFilingKey));const old=Array.isArray(legacy)?legacy.map(entry).filter((item):item is Filing=>!!item):[];
   for(const item of old)found.set(item.id,item);
   for(let i=0;i<storage.length;i++){
    const key=storage.key(i);if(!key?.startsWith(filingEntryPrefix))continue;
    const item=entry(parse(storage.getItem(key)));if(item&&key===filingEntryPrefix+item.id)found.set(item.id,item);
   }
   if(old.length){
    let migrated=true;
    for(const item of old)try{storage.setItem(filingEntryPrefix+item.id,JSON.stringify(found.get(item.id)))}catch{migrated=false;dirty.add(item.id)}
    // Retain the legacy queue if any entry could not be saved independently.
    if(migrated)try{storage.removeItem(legacyFilingKey)}catch{}
   }
  }catch{/* Blocked browser storage still permits an in-memory queue. */}
  return [...found.values()];
 }
 let queue=load();
 const publish=()=>{for(const listener of listeners)listener()};
 const update=(change:(current:Filing[])=>Filing[])=>{
  const previous=new Map(queue.map(item=>[item.id,item]));
  queue=change(queue);const current=new Map(queue.map(item=>[item.id,item]));
  for(const [id,item] of current){
   if(item===previous.get(id))continue;
   try{if(!storage)throw new Error('Storage unavailable');storage.setItem(filingEntryPrefix+id,JSON.stringify(item));dirty.delete(id)}catch{dirty.add(id)}
  }
  for(const id of previous.keys())if(!current.has(id)){
   try{if(!storage)throw new Error('Storage unavailable');storage.removeItem(filingEntryPrefix+id);dirty.delete(id)}catch{dirty.add(id)}
  }
  publish();
 };
 const sync=(event:Pick<StorageEvent,'key'|'newValue'|'storageArea'>)=>{
  if(event.storageArea&&event.storageArea!==storage)return;
  if(event.key===legacyFilingKey||event.key===null){
   const stored=load().filter(item=>!dirty.has(item.id));
   queue=[...stored,...queue.filter(item=>dirty.has(item.id))];publish();return;
  }
  if(!event.key.startsWith(filingEntryPrefix))return;
  const id=event.key.slice(filingEntryPrefix.length);if(dirty.has(id))return;
  // Storage events can arrive after a newer write or removal. Read the current
  // entry when possible rather than restoring an obsolete event payload.
  let raw=event.newValue;try{if(storage)raw=storage.getItem(event.key)}catch{}
  const item=entry(parse(raw));queue=queue.filter(item=>item.id!==id);
  if(item?.id===id)queue.push(item);publish();
 };
 return {getSnapshot:()=>queue,update,sync,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}};
}
