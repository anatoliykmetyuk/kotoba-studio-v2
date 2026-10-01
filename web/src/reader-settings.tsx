import {useEffect,useId,useRef,useState,type PointerEvent} from 'react';
import type {Settings} from './api';
import './settings.css';

const THUMB_SIZE=44;

function RangeSetting({label,value,min,max,step,format,change}:{label:string;value:number;min:number;max:number;step:number;format:(value:number)=>string;change:(value:number)=>void}){
 const id=useId();
 const quantize=(next:number)=>Number(Math.min(max,Math.max(min,min+Math.round((next-min)/step)*step)).toFixed(2));
 const [draft,setDraft]=useState(()=>quantize(value));
 const latest=useRef(draft);
 const drag=useRef<{id:number;x:number;value:number;travel:number}|null>(null);

 // The pointer owns its draft until release. A response to an earlier settings
 // request must never move the thumb beneath a stationary finger.
 useEffect(()=>{if(!drag.current){const next=quantize(value);latest.current=next;setDraft(next)}},[value,min,max,step]);

 function update(next:number){
  const rounded=quantize(next);
  if(rounded===latest.current)return;
  latest.current=rounded;setDraft(rounded);change(rounded);
 }
 function begin(event:PointerEvent<HTMLInputElement>){
  if(!event.isPrimary||event.button!==0)return;
  event.preventDefault();
  const input=event.currentTarget;
  input.focus({preventScroll:true});
  const rect=input.getBoundingClientRect(),travel=Math.max(1,rect.width-THUMB_SIZE);
  const thumb=rect.left+THUMB_SIZE/2+(latest.current-min)/(max-min)*travel;
  // Grabbing anywhere in the thumb's 44px target preserves the grab offset.
  // Tapping the track still chooses a value, once, at pointerdown.
  if(Math.abs(event.clientX-thumb)>THUMB_SIZE/2)update(min+(event.clientX-rect.left-THUMB_SIZE/2)/travel*(max-min));
  drag.current={id:event.pointerId,x:event.clientX,value:latest.current,travel};
  input.setPointerCapture(event.pointerId);
 }
 function move(event:PointerEvent<HTMLInputElement>){
  const active=drag.current;if(!active||active.id!==event.pointerId)return;
  event.preventDefault();
  update(active.value+(event.clientX-active.x)/active.travel*(max-min));
 }
 function end(event:PointerEvent<HTMLInputElement>){
  if(drag.current?.id!==event.pointerId)return;
  // Release coordinates are intentionally ignored: mobile browsers can report
  // a final coordinate different from the last actual drag movement.
  drag.current=null;
  if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
 }
 return <div className="reader-range-setting"><label htmlFor={id}><span>{label}</span><output htmlFor={id}>{format(draft)}</output></label><input id={id} className="reader-range" type="range" min={min} max={max} step={step} value={draft} aria-label={label} aria-valuetext={format(draft)} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={()=>{drag.current=null}} onChange={event=>{if(!drag.current)update(Number(event.target.value))}}/></div>;
}

export function ReaderSettings({settings,change}:{settings:Settings;change:(change:Partial<Settings>)=>void}){
 return <div className="settings-form reader-settings">
  <label>Appearance<select value={settings.theme} onChange={event=>change({theme:event.target.value as Settings['theme']})}><option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
  <RangeSetting label="Reading size" value={settings.fontSize} min={16} max={32} step={1} format={value=>`${value}px`} change={fontSize=>change({fontSize})}/>
  <RangeSetting label="Line spacing" value={settings.lineHeight} min={1.4} max={2.4} step={.05} format={value=>value.toFixed(2)} change={lineHeight=>change({lineHeight})}/>
  <label className="check-label"><input type="checkbox" checked={settings.furigana} onChange={event=>change({furigana:event.target.checked})}/>Furigana for New and Learning words</label>
  <p className="dictionary-attribution">Dictionary: <a href="/licenses/JMdict-documentation.html" target="_blank" rel="noreferrer">JMdict</a> by James William Breen and EDRDG, <a href="/licenses/EDRDG-license.html" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>. Tokenizer: <a href="https://github.com/tshatrov/ichiran" target="_blank" rel="noreferrer">Ichiran</a>.</p>
 </div>;
}
