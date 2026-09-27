import type {TextItem,Token,Sentence} from './api';
export type SelectionToken={id:string;start:number;end:number;surface:string;word?:Token};
export type PhraseRange={tokens:SelectionToken[];sentence:Sentence|null;phrase:string;context:string;anchor:string};

/** Latin text participates in selection without creating vocabulary entities. */
export function selectionTokens(sentence:Sentence):SelectionToken[]{
 const latin:{start:number;end:number;surface:string}[]=[];
 const pattern=/[\p{Script=Latin}\p{M}\p{N}]+(?:['’ʼ\-‐‑][\p{Script=Latin}\p{M}\p{N}]+)*/gu;
 for(const match of sentence.body.matchAll(pattern)){
  if(!/\p{Script=Latin}/u.test(match[0]))continue;
  const start=Array.from(sentence.body.slice(0,match.index)).length;
  latin.push({start,end:start+Array.from(match[0]).length,surface:match[0]});
 }
 const words=sentence.tokens.filter(word=>!latin.some(run=>word.start>=run.start&&word.end<=run.end));
 return [...words.map(word=>({id:word.id,start:word.start,end:word.end,surface:word.surface,word})),
  ...latin.filter(run=>!words.some(word=>word.start<run.end&&word.end>run.start)).map(run=>({...run,id:`literal:${sentence.id}:${run.start}`}))].sort((a,b)=>a.start-b.start);
}
export function phraseRange(text:TextItem,anchor:string,end:string):PhraseRange|null{
 const all=text.sentences.flatMap(sentence=>selectionTokens(sentence).map(token=>({token,sentence})));
 const a=all.findIndex(t=>t.token.id===anchor),b=all.findIndex(t=>t.token.id===end);if(a<0||b<0)return null;
 const entries=all.slice(Math.min(a,b),Math.max(a,b)+1),first=entries[0],last=entries.at(-1)!;
 const body=Array.from(text.body),phrase=body.slice(first.sentence.start+first.token.start,last.sentence.start+last.token.end).join('');
 if(Array.from(phrase).length>1500)throw new Error('Select up to 1,500 characters.');
 return {anchor,tokens:entries.map(e=>e.token),sentence:first.sentence.id===last.sentence.id?first.sentence:null,phrase,context:body.slice(first.sentence.start,last.sentence.end).slice(0,5000).join('')};
}
