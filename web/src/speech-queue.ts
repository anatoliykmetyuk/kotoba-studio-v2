/** A tap queues immediately; only media completion starts the next item. */
export class PlaybackQueue<T>{
 private items:T[]=[];
 private active=false;
 constructor(private play:(input:T)=>void,private prepare:(input:T)=>void=()=>{},private cancelPreparation:()=>void=()=>{}){}
 enqueue(input:T){this.prepare(input);this.items.push(input);if(!this.active)this.next()}
 ended(){if(!this.active)return;this.active=false;this.next()}
 clear(){this.items=[];this.active=false;this.cancelPreparation()}
 private next(){if(!this.items.length)return;this.active=true;this.play(this.items.shift()!)}
}
