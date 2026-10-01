import {Fragment} from 'react';
import {furiganaParts} from './furigana';

export function FuriganaText({text,reading}:{text:string;reading:string}){
 return <>{furiganaParts(text,reading).map((part,index)=>part.reading
  ?<ruby key={index}>{part.text}<rt>{part.reading}</rt></ruby>
  :<Fragment key={index}>{part.text}</Fragment>)}</>;
}
