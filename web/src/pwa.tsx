import {useCallback,useEffect,useRef,useState} from 'react';

function bounded<T>(promise:Promise<T>,milliseconds=20_000):Promise<T>{
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Update timed out')),milliseconds);
  promise.then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)});
 });
}
function installed(worker:ServiceWorker):Promise<void>{
 return new Promise((resolve,reject)=>{
  const finish=(error?:Error)=>{clearTimeout(timer);worker.removeEventListener('statechange',changed);error?reject(error):resolve()};
  const changed=()=>{if(['installed','activating','activated'].includes(worker.state))finish();else if(worker.state==='redundant')finish(new Error('Update installation failed'))};
  const timer=setTimeout(()=>finish(new Error('Update timed out')),20_000);
  worker.addEventListener('statechange',changed);changed();
 });
}

/** One update lifecycle shared by the banner and Settings. */
export function usePwaUpdates(){
 const supported='serviceWorker' in navigator&&window.isSecureContext&&import.meta.env.PROD;
 const [offline,setOffline]=useState(!navigator.onLine);
 const [update,setUpdate]=useState<ServiceWorker|null>(null);
 const [checking,setChecking]=useState(false);const [checked,setChecked]=useState(false);
 const [updating,setUpdating]=useState(false);const [error,setError]=useState('');
 const registration=useRef<Promise<ServiceWorkerRegistration>|null>(null);
 const pending=useRef<ServiceWorker|null>(null);const busy=useRef(false);const reloading=useRef(false);
 const mounted=useRef(false);const cleanups=useRef(new Set<()=>void>());
 const getRegistration=useCallback(()=>{
  if(!registration.current){
   registration.current=navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).then(reg=>{
    if(!mounted.current)return reg;
    const watch=(worker:ServiceWorker|null)=>{
     if(!worker)return;
     const replacesActive=!!reg.active&&reg.active!==worker;
     const changed=()=>{
      if(worker.state==='installed'&&replacesActive){pending.current=worker;setUpdate(worker)}
      if(worker.state==='redundant'||worker.state==='activated'){
       worker.removeEventListener('statechange',changed);cleanups.current.delete(cleanup);
       // Another tab can activate this worker while this document still runs
       // the previous bundle. Keep its explicit reload action until navigation.
       if(worker.state==='redundant'&&pending.current===worker){pending.current=null;setUpdate(null)}
      }
     };
     const cleanup=()=>worker.removeEventListener('statechange',changed);
     worker.addEventListener('statechange',changed);cleanups.current.add(cleanup);changed();
    };
    const found=()=>watch(reg.installing);
    reg.addEventListener('updatefound',found);cleanups.current.add(()=>reg.removeEventListener('updatefound',found));
    watch(reg.waiting);watch(reg.installing);return reg;
   }).catch(error=>{registration.current=null;throw error});
  }
  return registration.current;
 },[]);
 useEffect(()=>{
  mounted.current=true;
  const online=()=>setOffline(!navigator.onLine);addEventListener('online',online);addEventListener('offline',online);
  if(supported)void getRegistration().catch(()=>undefined);
  return()=>{mounted.current=false;removeEventListener('online',online);removeEventListener('offline',online);for(const cleanup of cleanups.current)cleanup();cleanups.current.clear();registration.current=null};
 },[getRegistration,supported]);
 async function check(){
  if(!supported||busy.current||reloading.current)return;
  busy.current=true;setChecking(true);setChecked(false);setError('');
  try{
   if(!navigator.onLine)throw new Error('Offline');
   const reg=await bounded(getRegistration());
   await bounded(reg.update());
   if(reg.installing)await installed(reg.installing);
   if(mounted.current){
    const waiting=reg.waiting;
    const ready=(waiting&&reg.active&&reg.active!==waiting?waiting:null)??(pending.current?.state!=='redundant'?pending.current:null);
    pending.current=ready;setUpdate(ready);setChecked(true);
   }
  }catch{if(mounted.current)setError(navigator.onLine?'Could not check for updates. Check your connection and try again.':'Offline. Connect to check for updates.')}
  finally{busy.current=false;if(mounted.current)setChecking(false)}
 }
 function installUpdate(){
  const worker=pending.current;if(!worker||reloading.current)return;
  reloading.current=true;setUpdating(true);setError('');
  const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('statechange',changed);cleanups.current.delete(cleanup)};
  const failed=()=>{cleanup();reloading.current=false;if(mounted.current){setUpdating(false);setError('Could not apply the update. Check for updates and try again.')}};
  // Wait for activation, including claim(), before navigating in WebKit.
  const changed=()=>{if(worker.state==='activated'){cleanup();location.reload()}else if(worker.state==='redundant')failed()};
  const timer=setTimeout(failed,20_000);cleanups.current.add(cleanup);
  worker.addEventListener('statechange',changed);worker.postMessage('activate-update');changed();
 }
 return {supported,offline,available:!!update,checking,checked,updating,error,check,installUpdate};
}

type Updates=ReturnType<typeof usePwaUpdates>;
export function PwaStatus({updates}:{updates:Updates}){
 return <>{updates.offline&&<div className="connection-banner" role="status">Offline. Reading progress is saved on this device and will sync when connected.</div>}{updates.available&&<div className="connection-banner" role="status">Update available <button disabled={updates.updating} onClick={updates.installUpdate}>{updates.updating?'Reloading…':'Reload to update'}</button></div>}</>;
}
export function AppUpdates({updates}:{updates:Updates}){
 const status=updates.updating?'Reloading…':updates.checking?'Checking…':updates.available?'Update available':updates.checked?'Up to date':!updates.supported?'Update checks are available in the HTTPS app.':'';
 return <section className="app-updates" aria-label="App updates"><h3>App updates</h3>
  <div className="app-update-actions"><button className="secondary" disabled={!updates.supported||updates.checking||updates.updating} onClick={()=>void updates.check()}>{updates.checking?'Checking…':'Check for updates'}</button>
  {updates.available&&<button className="primary" disabled={updates.updating} onClick={updates.installUpdate}>{updates.updating?'Reloading…':'Reload to update'}</button>}</div>
  <p role="status" aria-live="polite">{updates.error||status}</p>
 </section>;
}
