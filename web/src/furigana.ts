export type FuriganaPart={text:string;reading?:string};
// Compatibility ideographs remain kanji, with their exact source glyph intact.
const kanji=/[\p{Unified_Ideograph}\uF900-\uFAFF\u{2F800}-\u{2FA1F}々〇]/u;

function kana(text:string):string{
 return text.normalize('NFKC').replace(/[ァ-ヶ]/g,char=>String.fromCharCode(char.charCodeAt(0)-0x60)).replace(/\s/gu,'');
}

/** Presentation only: preserve the source and use its kana as reading anchors.
 * Ambiguous/mismatched readings stay plain rather than assigning guessed ruby.
 * This does not split dictionary tokens or alter their source offsets.
 */
export function furiganaParts(text:string,reading:string):FuriganaPart[]{
 const plain=[{text}];
 if(!kanji.test(text)||!reading)return plain;
 const normalized=kana(reading);
 if(!/^[\p{Script=Hiragana}ー]+$/u.test(normalized))return plain;
 const runs=text.match(/(?:[\p{Unified_Ideograph}\uF900-\uFAFF\u{2F800}-\u{2FA1F}々〇]\p{Variation_Selector}*)+|[^\p{Unified_Ideograph}\uF900-\uFAFF\u{2F800}-\u{2FA1F}々〇]+/gu)??[];
 const memo=new Map<string,FuriganaPart[][]>();
 function align(index:number,offset:number):FuriganaPart[][]{
  if(index===runs.length)return offset===normalized.length?[[]]:[];
  const key=index+':'+offset,cached=memo.get(key);if(cached)return cached;
  const run=runs[index],results:FuriganaPart[][]=[];
  if(!kanji.test(run)){
   const anchor=kana(run);
   if(normalized.startsWith(anchor,offset))for(const rest of align(index+1,offset+anchor.length))results.push([{text:run},...rest]);
  }else{
   for(let end=offset+1;end<=normalized.length&&results.length<2;end++){
    for(const rest of align(index+1,end)){
     results.push([{text:run,reading:normalized.slice(offset,end)},...rest]);
     if(results.length===2)break;
    }
   }
  }
  memo.set(key,results);return results;
 }
 const matches=align(0,0);
 return matches.length===1?matches[0]:plain;
}
