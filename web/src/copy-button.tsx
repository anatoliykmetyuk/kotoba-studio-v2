import {useEffect,useRef,useState} from 'react';
import {Check,Copy} from 'lucide-react';

export function CopyButton({text,label}:{text:string;label:string}){
 const [copied,setCopied]=useState(false),[error,setError]=useState('');
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 async function copy(){
  setError('');
  try{
   await navigator.clipboard.writeText(text);setCopied(true);clearTimeout(timer.current);
   timer.current=setTimeout(()=>setCopied(false),1500);
  }catch{setError('Could not access the clipboard.')}
 }
 return <span className="copy-control"><button className="icon-button" aria-label={label} title={copied?'Copied':label} onClick={()=>void copy()}>{copied?<Check size={19}/>:<Copy size={19}/>}</button>{error&&<span role="alert" className="copy-error">{error}</span>}</span>;
}
