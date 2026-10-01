export type ExistingFolder={id:string;name:string};
export type Filing={id:string;folder:ExistingFolder;jobId?:string;textId?:string;error?:string};
export const legacyFilingKey='kotoba:import-filing';
export const filingEntryPrefix=legacyFilingKey+':';
export const filingTerminalPrefix='kotoba:import-filing-completed:';

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
 const terminal=new Set<string>(),dirtyTerminal=new Set<string>();
 const completed=(id:string)=>{
  if(terminal.has(id))return true;
  try{if(storage?.getItem(filingTerminalPrefix+id)==='1'){terminal.add(id);return true}}catch{}
  return false;
 };
 function flushTerminals(){
  for(const id of dirtyTerminal){
   // Completing or dismissing a request is irreversible for its UUID. The
   // terminal key dominates stale tab writes and any retained legacy array.
   let saved=false;
   try{if(storage){storage.setItem(filingTerminalPrefix+id,'1');saved=true}}catch{}
   try{storage?.removeItem(filingEntryPrefix+id)}catch{}
   // Removing the larger pending entry may free enough storage for the marker.
   if(!saved)try{if(storage){storage.setItem(filingTerminalPrefix+id,'1');saved=true}}catch{}
   if(saved)dirtyTerminal.delete(id);
  }
 }
 function load():Filing[]{
  const found=new Map<string,Filing>();
  if(!storage)return [];
  try{
   const legacy=parse(storage.getItem(legacyFilingKey));const old=Array.isArray(legacy)?legacy.map(entry).filter((item):item is Filing=>!!item):[];
   for(const item of old)found.set(item.id,item);
   const keys=Array.from({length:storage.length},(_,i)=>storage.key(i));
   for(const key of keys){
    if(key?.startsWith(filingTerminalPrefix)){if(storage.getItem(key)==='1')terminal.add(key.slice(filingTerminalPrefix.length));continue}
    if(!key?.startsWith(filingEntryPrefix))continue;
    const item=entry(parse(storage.getItem(key)));if(item&&key===filingEntryPrefix+item.id)found.set(item.id,item);
   }
   for(const id of found.keys())if(completed(id))found.delete(id);
   if(old.length){
    let migrated=true;
    for(const item of old){
     if(completed(item.id))continue;
     try{storage.setItem(filingEntryPrefix+item.id,JSON.stringify(found.get(item.id)))}catch{migrated=false;dirty.add(item.id)}
    }
    // Retain the legacy queue if any entry could not be saved independently.
    if(migrated)try{storage.removeItem(legacyFilingKey)}catch{}
   }
  }catch{/* Blocked browser storage still permits an in-memory queue. */}
  return [...found.values()].filter(item=>!completed(item.id));
 }
 let queue=load();
 const publish=()=>{for(const listener of listeners)listener()};
 const update=(change:(current:Filing[])=>Filing[])=>{
  flushTerminals();
  const previous=new Map(queue.map(item=>[item.id,item]));
  queue=change(queue).filter(item=>!completed(item.id));const current=new Map(queue.map(item=>[item.id,item]));
  for(const id of previous.keys())if(!current.has(id)){terminal.add(id);dirtyTerminal.add(id);dirty.delete(id)}
  flushTerminals();
  for(const [id,item] of current){
   if(item===previous.get(id))continue;
   if(completed(id))continue;
   try{if(!storage)throw new Error('Storage unavailable');storage.setItem(filingEntryPrefix+id,JSON.stringify(item));dirty.delete(id)}catch{dirty.add(id)}
   // Another tab can complete between the check and write. Its independent
   // terminal record remains authoritative even if this write arrived later.
   if(completed(id)){dirty.delete(id);try{storage?.removeItem(filingEntryPrefix+id)}catch{}}
  }
  queue=queue.filter(item=>!completed(item.id));
  publish();
 };
 const sync=(event:Pick<StorageEvent,'key'|'newValue'|'storageArea'>)=>{
  if(event.storageArea&&event.storageArea!==storage)return;
  flushTerminals();
  if(event.key?.startsWith(filingTerminalPrefix)){
   const id=event.key.slice(filingTerminalPrefix.length);
   if(event.newValue==='1'||completed(id)){terminal.add(id);dirty.delete(id);queue=queue.filter(item=>item.id!==id);publish()}
   return;
  }
  if(event.key===legacyFilingKey||event.key===null){
   const stored=load().filter(item=>!dirty.has(item.id));
   queue=[...stored,...queue.filter(item=>dirty.has(item.id)&&!completed(item.id))];publish();return;
  }
  if(!event.key.startsWith(filingEntryPrefix))return;
  const id=event.key.slice(filingEntryPrefix.length);
  if(completed(id)){dirty.delete(id);queue=queue.filter(item=>item.id!==id);publish();return}
  if(dirty.has(id))return;
  // Storage events can arrive after a newer write or removal. Read the current
  // entry when possible rather than restoring an obsolete event payload.
  let raw=event.newValue;try{if(storage)raw=storage.getItem(event.key)}catch{}
  const item=entry(parse(raw));queue=queue.filter(item=>item.id!==id);
  if(item?.id===id)queue.push(item);publish();
 };
 return {getSnapshot:()=>queue,update,sync,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}};
}
