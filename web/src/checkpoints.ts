import type {Sentence,TextItem} from './api';

export type Checkpoint={start:number;end:number;completed:boolean;sentences:Sentence[]};
export type CheckpointChange={textId:string;start:number;end:number;completed:boolean};

/** Count occurrences afresh after each sentence-aligned boundary. */
export function readingSections(sentences:Sentence[],wordLimit:number):Checkpoint[]{
 const result:Checkpoint[]=[];let current:Sentence[]=[],count=0;
 function finish(){if(!current.length)return;result.push({start:current[0].start,end:current.at(-1)!.end,completed:current.every(s=>s.completed),sentences:current});current=[];count=0}
 for(const sentence of sentences){current.push(sentence);count+=sentence.tokens.length;if(count>=wordLimit)finish()}
 finish();return result;
}

export function readingProgress(sentences:Sentence[]):number{
 const weight=(s:Sentence)=>Math.max(1,s.tokens.length);
 const total=sentences.reduce((n,s)=>n+weight(s),0);
 return total?sentences.reduce((n,s)=>n+(s.completed?weight(s):0),0)/total:0;
}

/** Pending actions use the same sentence and shared-family rules as the API. */
export function applyCheckpoint(text:TextItem,change:CheckpointChange):TextItem{
 if(change.textId!==text.id)return text;
 const included=(s:Sentence)=>s.start>=change.start&&s.end<=change.end;
 const known=new Set(change.completed?text.sentences.filter(included).flatMap(s=>s.tokens.filter(t=>t.state==='new').map(t=>t.baseId)):[]);
 const sentences=text.sentences.map(s=>({...s,completed:included(s)?change.completed:s.completed,tokens:s.tokens.map(t=>known.has(t.baseId)?{...t,state:'known' as const}:t)}));
 return {...text,sentences,readingProgress:readingProgress(sentences),textState:sentences.length&&sentences.every(s=>s.completed)?'completed':'new'};
}
