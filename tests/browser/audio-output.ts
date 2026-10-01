import type {BrowserContext,Page} from '@playwright/test';

// Exercise real media loading/playback without sending test sound to speakers.
// Reapply after the application's playback handler sets muted=false.
function silenceMedia(){
 const prototype=HTMLMediaElement.prototype;
 if(!(prototype as HTMLMediaElement&{testMuted?:boolean}).testMuted){
  const play=prototype.play;
  Object.defineProperty(prototype,'play',{configurable:true,writable:true,value:function(this:HTMLMediaElement){
   // Apply silence synchronously before native playback can reach speakers,
   // including when the app deliberately unmutes a requested pronunciation.
   this.volume=0;this.muted=true;return play.call(this);
  }});
  Object.defineProperty(prototype,'testMuted',{value:true});
 }
  const mute=(event:Event)=>{if(event.target instanceof HTMLMediaElement&&!event.target.muted)event.target.muted=true};
  document.addEventListener('volumechange',mute,true);document.addEventListener('play',mute,true);
  new MutationObserver(()=>document.querySelectorAll('audio').forEach(audio=>{if(!audio.muted)audio.muted=true})).observe(document,{childList:true,subtree:true});
}
export async function muteTestOutput(page:Page){
 await page.addInitScript(silenceMedia);
}
export async function muteBrowserContext(context:BrowserContext){
 await context.addInitScript(silenceMedia);
}
