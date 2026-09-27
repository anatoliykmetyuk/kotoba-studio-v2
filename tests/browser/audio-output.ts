import type {Page} from '@playwright/test';

// Exercise real media loading/playback without sending test sound to speakers.
// Reapply after the application's playback handler sets muted=false.
export async function muteTestOutput(page:Page){
 await page.addInitScript(()=>{
  const mute=(event:Event)=>{if(event.target instanceof HTMLMediaElement&&!event.target.muted)event.target.muted=true};
  document.addEventListener('volumechange',mute,true);document.addEventListener('play',mute,true);
  new MutationObserver(()=>document.querySelectorAll('audio').forEach(audio=>{if(!audio.muted)audio.muted=true})).observe(document,{childList:true,subtree:true});
 });
}
