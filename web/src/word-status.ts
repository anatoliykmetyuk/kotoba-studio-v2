import type {State,TextItem,WordDetail} from './api';

export type LearningState={state:State;revision:number};
export type DisplayStatus=LearningState&{pending:boolean};
type Change={state:State;write:(revision:number)=>Promise<LearningState>;resolve:(value:LearningState)=>void;reject:(error:unknown)=>void};
type Family={confirmed:LearningState;changes:Change[]};

/** Server receipts and pending intentions are separate: a failed early save
 * must never erase a newer click, or persist an unacknowledged state offline. */
export class WordStatuses{
 private families=new Map<string,Family>();
 private listeners=new Set<()=>void>();
 private snapshot:ReadonlyMap<string,DisplayStatus>=new Map();
 private confirmedSnapshot:ReadonlyMap<string,DisplayStatus>=new Map();
 constructor(private confirmed:(baseId:string,status:LearningState)=>void=()=>{}){}
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}};
 getSnapshot=()=>this.snapshot;
 getConfirmedSnapshot=()=>this.confirmedSnapshot;
 private publish(){
  this.confirmedSnapshot=new Map([...this.families].map(([id,family])=>[id,{...family.confirmed,pending:false}]));
  this.snapshot=new Map([...this.families].map(([id,family])=>[id,{...family.confirmed,state:family.changes.at(-1)?.state??family.confirmed.state,pending:family.changes.length>0}]));
  for(const listener of this.listeners)listener();
 }
 /** A read started before a save may finish afterward. Preserve newer receipts,
  * but accept newer revisions from another device without extending cache life. */
 reconcile(baseId:string,status:LearningState):LearningState{
  const family=this.families.get(baseId);if(!family)return status;
  if(status.revision>family.confirmed.revision){family.confirmed=status;this.publish()}
  return family.confirmed;
 }
 change(baseId:string,state:State,initial:LearningState,write:Change['write']):Promise<LearningState>{
  let family=this.families.get(baseId);
  if(!family){family={confirmed:initial,changes:[]};this.families.set(baseId,family)}
  else if(initial.revision>family.confirmed.revision)family.confirmed=initial;
  const current=family;
  const result=new Promise<LearningState>((resolve,reject)=>{current.changes.push({state,write,resolve,reject})});
  this.publish();if(current.changes.length===1)void this.drain(baseId,current);
  return result;
 }
 private async drain(baseId:string,family:Family){
  while(family.changes.length){
   const change=family.changes[0];
   try{
    const result=await change.write(family.confirmed.revision);
    if(result.revision>=family.confirmed.revision)family.confirmed=result;
    family.changes.shift();this.publish();this.confirmed(baseId,family.confirmed);change.resolve(result);
   }catch(error){family.changes.shift();this.publish();change.reject(error)}
  }
 }
}

export function patchTextStatus(text:TextItem,baseId:string,status:LearningState):TextItem{
 let changed=false;
 const sentences=text.sentences.map(sentence=>{
  let affected=false;
  const tokens=sentence.tokens.map(token=>{
   if(token.baseId!==baseId||token.statusRevision>status.revision||token.state===status.state&&token.statusRevision===status.revision)return token;
   affected=true;return {...token,state:status.state,statusRevision:status.revision};
  });
  if(!affected)return sentence;changed=true;return {...sentence,tokens};
 });
 return changed?{...text,sentences}:text;
}
export function patchWordStatus(word:WordDetail,baseId:string,status:LearningState):WordDetail{
 return word.base.id===baseId&&word.status.revision<=status.revision?{...word,status}:word;
}
export function displayTextStatuses(text:TextItem,statuses:ReadonlyMap<string,DisplayStatus>,pendingOnly=false):TextItem{
 let changed=false;
 const sentences=text.sentences.map(sentence=>{
  let affected=false;
  const tokens=sentence.tokens.map(token=>{
   const status=statuses.get(token.baseId);
   if(!status||pendingOnly&&!status.pending||token.statusRevision>status.revision||token.state===status.state&&token.statusRevision===status.revision)return token;
   affected=true;return {...token,state:status.state,statusRevision:status.revision};
  });
  if(!affected)return sentence;changed=true;return {...sentence,tokens};
 });
 return changed?{...text,sentences}:text;
}

export function reconcileTextStatuses(text:TextItem):TextItem{
 const receipts=new Map<string,DisplayStatus>();
 for(const sentence of text.sentences)for(const token of sentence.tokens){
  if(!wordStatuses.getSnapshot().has(token.baseId)||receipts.has(token.baseId))continue;
  receipts.set(token.baseId,{...wordStatuses.reconcile(token.baseId,{state:token.state,revision:token.statusRevision}),pending:false});
 }
 return displayTextStatuses(text,receipts);
}

export const wordStatuses=new WordStatuses((baseId,status)=>{dispatchEvent(new CustomEvent('kotoba:word-status-saved',{detail:{baseId,status}}))});
