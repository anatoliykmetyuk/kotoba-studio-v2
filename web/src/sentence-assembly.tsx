import {useRef,useState} from 'react';
import {DndContext,DragOverlay,KeyboardCode,KeyboardSensor,PointerSensor,closestCenter,useSensor,useSensors,type DragEndEvent} from '@dnd-kit/core';
import {SortableContext,arrayMove,rectSortingStrategy,sortableKeyboardCoordinates,useSortable} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import './sentence-assembly.css';

export type SentenceAssemblyProps={
 pieces:number[];
 blocks:readonly {text:string}[];
 disabled:boolean;
 onReorder:(pieces:number[])=>void;
 onTap:(piece:number)=>void;
};

function SortableWord({piece,text,disabled,onTap}:{piece:number;text:string;disabled:boolean;onTap:(piece:number)=>void}){
 const {attributes,listeners,setNodeRef,transform,transition,isDragging}=useSortable({id:piece,disabled});
 return <button type="button" ref={setNodeRef} {...attributes} {...listeners} className="sentence-assembly-token" data-piece={piece} data-dragging={isDragging||undefined} disabled={disabled} style={{transform:CSS.Translate.toString(transform),transition}} onClick={()=>onTap(piece)}>{text}</button>;
}

/** The parent owns the answer and keys this component by the current challenge. */
export function SentenceAssembly({pieces,blocks,disabled,onReorder,onTap}:SentenceAssemblyProps){
 const [activePiece,setActivePiece]=useState<number|null>(null);
 const suppressTap=useRef(false);
 const sensors=useSensors(
  useSensor(PointerSensor,{activationConstraint:{distance:10}}),
  useSensor(KeyboardSensor,{coordinateGetter:sortableKeyboardCoordinates,keyboardCodes:{start:[KeyboardCode.Space],cancel:[KeyboardCode.Esc],end:[KeyboardCode.Space,KeyboardCode.Tab]}}),
 );
 function finish({active,over}:DragEndEvent){
  setActivePiece(null);
  if(disabled||!over||active.id===over.id)return;
  const from=pieces.indexOf(Number(active.id)),to=pieces.indexOf(Number(over.id));
  if(from>=0&&to>=0)onReorder(arrayMove(pieces,from,to));
 }
 const word=(id:string|number)=>blocks[Number(id)]?.text??'Word';
 return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={({active})=>{suppressTap.current=true;setActivePiece(Number(active.id))}} onDragEnd={finish} onDragCancel={()=>setActivePiece(null)} accessibility={{
  screenReaderInstructions:{draggable:'To reorder a word, press Space, use the arrow keys, then press Space to place it. Press Escape to cancel. Press Enter to hear the word and return it to the choices.'},
  announcements:{
   onDragStart:({active})=>`Picked up ${word(active.id)}.`,
   onDragOver:({active,over})=>over?`Move ${word(active.id)} to position ${pieces.indexOf(Number(over.id))+1} of ${pieces.length}.`:undefined,
   onDragEnd:({active,over})=>`${word(active.id)} ${over?'placed':'returned to its position'}.`,
   onDragCancel:({active})=>`Reordering ${word(active.id)} canceled.`,
  },
 }}>
  <SortableContext items={pieces} strategy={rectSortingStrategy} disabled={disabled}>
   <div className="sentence-answer sentence-assembly" lang="ja" aria-label="Assembled sentence"
    // A completed or canceled drag owns its compatibility click. Only a new
    // pointer gesture or explicit Enter activation restores ordinary tapping.
    onPointerDownCapture={()=>{suppressTap.current=false}}
    onKeyDownCapture={event=>{if(event.code==='Enter'&&activePiece===null)suppressTap.current=false}}
    onClickCapture={event=>{if(suppressTap.current){event.preventDefault();event.stopPropagation()}}}>
    {pieces.map(piece=><SortableWord key={piece} piece={piece} text={blocks[piece].text} disabled={disabled} onTap={onTap}/>)}
   </div>
  </SortableContext>
  {pieces.length>1&&<p className="sentence-assembly-instructions">Drag words to reorder. Tap a word to return it to the choices.</p>}
  <DragOverlay dropAnimation={null}>{activePiece!==null&&!disabled&&<span className="sentence-assembly-overlay" lang="ja" aria-hidden="true">{blocks[activePiece]?.text}</span>}</DragOverlay>
 </DndContext>;
}
