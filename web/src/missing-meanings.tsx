import {useEffect,useRef,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api,waitJob,type WordDetail} from './api';

/** A missing meaning is requested once on demand, then saved by the API. */
export function MissingMeanings({wordId}:{wordId:string}){
 const client=useQueryClient();const [attempt,setAttempt]=useState(0),[error,setError]=useState('');
 const failedJob=useRef<string|undefined>(undefined);
 useEffect(()=>{
  const controller=new AbortController();setError('');
  void (async()=>{
   try{
    if(failedJob.current){
     const job=await api<{state:string}>('/jobs/'+failedJob.current,undefined,undefined,{signal:controller.signal});
     if(job.state==='failed')await api('/jobs/'+failedJob.current+'/retry',{},undefined,{signal:controller.signal});
    }
    failedJob.current=undefined;
    const result=await api<{state:string;jobId?:string;error?:string}>('/words/'+wordId+'/meanings',{},undefined,{signal:controller.signal});
    if(result.jobId){
     failedJob.current=result.jobId;
     if(result.state==='failed')throw new Error(result.error||'Meaning lookup failed.');
     await waitJob(result.jobId,controller.signal);failedJob.current=undefined;
    }
    const word=await api<WordDetail>('/words/'+wordId,undefined,undefined,{signal:controller.signal});
    if(!word.meanings.length)throw new Error('No meaning was returned.');
    if(!controller.signal.aborted)client.setQueryData(['word',wordId],word);
   }catch(e){if(!controller.signal.aborted)setError((e as Error).message)}
  })();
  return()=>controller.abort();
 },[wordId,attempt,client]);
 return error?<div role="alert"><p>{error}</p><button className="text-button" onClick={()=>setAttempt(n=>n+1)}>Retry meaning lookup</button></div>:<p role="status">Loading meanings…</p>;
}
