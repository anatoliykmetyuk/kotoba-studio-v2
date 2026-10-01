import {useEffect,useRef,useSyncExternalStore} from 'react';
import {useQuery,useQueries,useQueryClient} from '@tanstack/react-query';
import {api,type Job} from './api';

export type ExistingFolder={id:string;name:string};
type Filing={id:string;folder:ExistingFolder;jobId?:string;textId?:string;error?:string};
const storageKey='kotoba:import-filing';
const listeners=new Set<()=>void>();
function readQueue():Filing[]|null{
 try{
  const value:unknown=JSON.parse(localStorage.getItem(storageKey)??'[]');
  return Array.isArray(value)?value.filter((f):f is Filing=>!!f&&typeof f.id==='string'&&typeof f.folder?.id==='string'&&typeof f.folder?.name==='string'&&(typeof f.jobId==='string'||typeof f.textId==='string')&&(f.error===undefined||typeof f.error==='string')).map(f=>f.textId?f:{...f,error:undefined}):[];
 }catch{return null}
}
let queue=readQueue()??[];
function update(change:(current:Filing[])=>Filing[]){
 // Browser storage can remain readable while writes fail (for example quota).
 // The current tab's queue must retain its newer in-memory state in that case.
 queue=change(queue);
 try{localStorage.setItem(storageKey,JSON.stringify(queue))}catch{/* Keep the current session retryable when browser storage is unavailable. */}
 for(const listener of listeners)listener();
}
function subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}}
const snapshot=()=>queue;

/** Accepted imports are durable before this independent organization action. */
export function scheduleImportFiling(result:{textId?:string;jobId?:string},folder:ExistingFolder|null){
 if(!folder||(!result.textId&&!result.jobId))return;
 update(current=>[...current.filter(item=>!(item.folder.id===folder.id&&(result.textId?item.textId===result.textId:item.jobId===result.jobId))),{id:crypto.randomUUID(),folder,...result}]);
}

export function FolderSelector({value,onChange,disabled=false,previous=[]}:{value:string;onChange:(folder:ExistingFolder|null)=>void;disabled?:boolean;previous?:ExistingFolder[]}){
 const {data:folders=[],isLoading,error,refetch}=useQuery({queryKey:['folders'],queryFn:({signal})=>api<ExistingFolder[]>('/graph/query',{query:'MATCH (f:Folder) RETURN f.id AS id, f.name AS name ORDER BY f.name'},undefined,{signal})});
 // Keep an existing selection legible while the independent folder query loads.
 const options=[...folders,...previous.filter(f=>!folders.some(option=>option.id===f.id))];
 return <div><label>Folder<select value={value} disabled={disabled||isLoading||!!error} onChange={e=>onChange(options.find(f=>f.id===e.target.value)??null)}><option value="">No folder selected</option>{options.map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>{error&&<p role="alert" className="error">Folders could not be loaded. <button type="button" disabled={disabled} onClick={()=>void refetch()}>Retry</button></p>}</div>;
}

/** Mounted with the app, so closing an import dialog does not cancel filing. */
export function ImportFiling(){
 const requests=useSyncExternalStore(subscribe,snapshot);const client=useQueryClient();
 const running=useRef(new Map<string,AbortController>());
 const jobs=useQueries({queries:requests.map(request=>({queryKey:['job',request.jobId],queryFn:({signal}:{signal:AbortSignal})=>api<Job>('/jobs/'+request.jobId,undefined,undefined,{signal}),enabled:!!request.jobId&&!request.textId,refetchInterval:(query:{state:{data?:Job}})=>query.state.data?.state==='ready'?false:1000}))});
 useEffect(()=>{
  const sync=(event:StorageEvent)=>{if(event.key!==storageKey&&event.key!==null)return;queue=readQueue()??queue;for(const listener of listeners)listener()};
  window.addEventListener('storage',sync);
  return()=>{window.removeEventListener('storage',sync);for(const controller of running.current.values())controller.abort();running.current.clear()};
 },[]);
 useEffect(()=>{
  for(const [index,request] of requests.entries()){
   if(request.error||running.current.has(request.id))continue;
   const job=jobs[index];let textId=request.textId;
   if(!textId){
    // Observation failures are temporary query state, not a failed filing write.
    // Keep watching so Library Retry or a restored connection can finish filing.
    if(job.data?.state!=='ready')continue;
    textId=job.data.result.textId;
    if(!textId)continue;
    update(current=>current.map(item=>item.id===request.id?{...item,textId}:item));
   }
   const controller=new AbortController();running.current.set(request.id,controller);
   void (async()=>{
    try{
     const results=await api<{folderId:string;textId:string}[][]>('/graph/transaction',{statements:[{query:'MATCH (f:Folder {id:$folderId}), (t:Text {id:$textId}) MERGE (f)-[:CONTAINS]->(t) RETURN f.id AS folderId, t.id AS textId',params:{folderId:request.folder.id,textId}}]},undefined,{signal:controller.signal});
     if(results[0]?.length!==1||results[0][0].folderId!==request.folder.id||results[0][0].textId!==textId)throw new Error('The selected folder or saved text is no longer available.');
     update(current=>current.filter(item=>item.id!==request.id));
     for(const key of ['library','text','folders'])void client.invalidateQueries({queryKey:[key]});
    }catch(error){if(!controller.signal.aborted)update(current=>current.map(item=>item.id===request.id?{...item,error:(error as Error).message}:item))}
    finally{if(running.current.get(request.id)===controller)running.current.delete(request.id)}
   })();
  }
 },[requests,jobs,client]);
 return <>{requests.map((request,index)=>{
  const job=jobs[index];const observationError=!request.textId&&(job.data?.state==='failed'?(job.data.error||'The import failed. Retry it from the Library.'):job.error?.message||(job.data?.state==='ready'&&!job.data.result.textId?'The import did not return a saved text.':''));
  const error=request.error||observationError;if(!error)return null;
  return <div className="error" role="alert" key={request.id}><span>{request.textId?'Text saved. Folder assignment failed.':'Folder assignment is waiting for the import.'} {request.folder.name}: {error}</span><button onClick={()=>{if(request.textId)update(current=>current.map(item=>item.id===request.id?{...item,error:undefined}:item));else void client.resetQueries({queryKey:['job',request.jobId],exact:true})}}>{request.textId?'Retry folder assignment':'Check import again'}</button><button onClick={()=>update(current=>current.filter(item=>item.id!==request.id))}>Dismiss</button></div>;
 })}</>;
}
