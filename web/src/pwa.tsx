import {useEffect,useState} from 'react';
export function PwaStatus(){
 const [offline,setOffline]=useState(!navigator.onLine);const [update,setUpdate]=useState<ServiceWorker|null>(null);const [updating,setUpdating]=useState(false);
 function installUpdate(){
  const worker=update;if(!worker||updating)return;setUpdating(true);
  // controllerchange may fire while activation is still waiting for claim().
  // Finish activation before navigating, including on WebKit.
  const changed=()=>{
   if(worker.state==='activated'){worker.removeEventListener('statechange',changed);location.reload()}
   else if(worker.state==='redundant'){worker.removeEventListener('statechange',changed);setUpdating(false);setUpdate(null)}
  };
  worker.addEventListener('statechange',changed);worker.postMessage('activate-update');changed();
 }
 useEffect(()=>{
  const online=()=>setOffline(!navigator.onLine);addEventListener('online',online);addEventListener('offline',online);
  let disposed=false;
  if('serviceWorker' in navigator&&window.isSecureContext&&import.meta.env.PROD){
   void navigator.serviceWorker.register('/sw.js').then(registration=>{
    if(disposed)return;if(registration.waiting)setUpdate(registration.waiting);
    registration.addEventListener('updatefound',()=>{const worker=registration.installing;worker?.addEventListener('statechange',()=>{if(!disposed&&worker.state==='installed'&&navigator.serviceWorker.controller)setUpdate(worker)})});
   }).catch(()=>undefined);
  }
  return()=>{disposed=true;removeEventListener('online',online);removeEventListener('offline',online)};
 },[]);
 return <>{offline&&<div className="connection-banner" role="status">Offline. Reading progress is saved on this device and will sync when connected.</div>}{update&&<div className="connection-banner" role="status">Update available <button disabled={updating} onClick={installUpdate}>{updating?'Updating…':'Reload'}</button></div>}</>;
}
