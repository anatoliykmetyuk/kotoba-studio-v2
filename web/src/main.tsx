import React,{useState,useEffect,useRef,useMemo} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider,useQuery,useQueryClient} from '@tanstack/react-query';
import {BookOpen,Search,Plus,Headphones,ArrowLeft,ArrowUpRight,Check,X,Volume2,Settings2,ChevronRight,MoreHorizontal,RefreshCw,Layers,CheckCheck,Play,Sparkles,Folder,SlidersHorizontal,Download} from 'lucide-react';
import {api,waitJob,type TextItem,type Token,type WordDetail,type Sentence,type Example,type Area,type State,type Settings,type Job} from './api';
import './style.css';
import {useReadingProgress,useProgressSync} from './reading-progress';
import {useSpeech} from './speech';
import {Practice} from './practice';
import {PwaStatus} from './pwa';
import {useSwipeDismiss,useTokenSelection} from './touch';
import {phraseRange,selectionTokens,type PhraseRange} from './selection';
import {ReaderSettings} from './reader-settings';
import {ReadingDetails} from './reading-details';
import {CopyButton} from './copy-button';
import {MissingMeanings} from './missing-meanings';
import {usePopupScrollLock} from './popup-scroll-lock';
const qc=new QueryClient({defaultOptions:{queries:{retry:1,refetchOnWindowFocus:true,staleTime:2000}}});
const sliceText=(s:string,start:number,end?:number)=>Array.from(s).slice(start,end).join('');
const STATES:State[]=['new','learning','familiar','known'];
const defaults:Settings={theme:'system',fontSize:20,lineHeight:1.85,readerLayout:'book',furigana:true,area:'reading'};
function useData<T>(key:unknown[],path:string,enabled=true){return useQuery<T>({queryKey:key,queryFn:({signal})=>api<T>(path,undefined,undefined,{signal}),enabled});}
function IconButton({label,children,onClick,disabled=false}:{label:string;children:React.ReactNode;onClick:()=>void;disabled?:boolean}){return <button className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>}
function Modal({title,children,onClose,wide=false}:{title:string;children:React.ReactNode;onClose:()=>void;wide?:boolean}){
 const ref=useRef<HTMLDialogElement>(null);const backdropPress=useRef(false);const drag=useSwipeDismiss(ref,onClose);usePopupScrollLock(ref);useEffect(()=>{const d=ref.current!;d.showModal();return()=>d.close()},[]);
 function outside(x:number,y:number){const r=ref.current?.getBoundingClientRect();return !!r&&(x<r.left||x>r.right||y<r.top||y>r.bottom)}
 // A mouse drag across child sections can synthesize a click on their common
 // dialog ancestor. Only a press and release outside the box is a backdrop tap.
 return <dialog aria-label={title} ref={ref} style={{transform:drag?`translateY(${drag}px)`:undefined}} className={wide?'wide':''} onCancel={onClose} onPointerDownCapture={e=>{backdropPress.current=e.target===ref.current&&outside(e.clientX,e.clientY)}} onClick={e=>{if(backdropPress.current&&e.target===ref.current&&outside(e.clientX,e.clientY))onClose();backdropPress.current=false}}><div className="popup-drag-area" aria-hidden="true"><div className="sheet-handle"/></div><div className="dialog-head"><h2>{title}</h2><IconButton label="Close" onClick={onClose}><X size={20}/></IconButton></div>{children}</dialog>
}
function App(){
 useProgressSync();
 const client=useQueryClient();const [view,setView]=useState<'library'|'read'|'explore'|'practice'>('library');
 const [textId,setTextId]=useState<string|null>(null);const [selected,setSelected]=useState<Token|null>(null);const [importOpen,setImportOpen]=useState(false);const [editing,setEditing]=useState<TextItem|null>(null);const [settingsOpen,setSettingsOpen]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const [settingsDraft,setSettingsDraft]=useState<Partial<Settings>>({});const settingsDraftRef=useRef<Partial<Settings>>({});const settingsQueue=useRef<Promise<void>>(Promise.resolve());const settingsVersion=useRef(0);const settingsFieldVersions=useRef<Partial<Record<keyof Settings,number>>>({});
 const {data:remoteSettings}=useData<Settings>(['settings'],'/settings');const settings={...defaults,...remoteSettings,fontSize:remoteSettings?.readerLayout==='book'?remoteSettings.fontSize:20,lineHeight:remoteSettings?.lineHeight??1.85,readerLayout:'book' as const,...settingsDraft};
 const {data:library=[],isLoading:libraryLoading,error:libraryError}=useData<TextItem[]>(['library'],'/texts');
 const {data:text,error:textError}=useData<TextItem>(['text',textId],'/texts/'+textId,!!textId);
 const {data:health}=useQuery({queryKey:['health'],queryFn:()=>api<{ready:boolean;workerReady:boolean}>('/health'),refetchInterval:15000});
 const {audioRef,busy,speak,stop:stopSpeech}=useSpeech(setError);const settingsPending=useRef<Partial<Settings>>({});const settingsTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const statusQueues=useRef(new Map<string,Promise<{state:State;revision:number}>>());const statusRevisions=useRef(new Map<string,number>());
 const [destination,setDestination]=useState<{id:string;occurrenceId:string;key:number}|null>(null);
 const [completionText,setCompletionText]=useState<TextItem|null>(null);
 const [range,setRange]=useState<PhraseRange|null>(null);const [phraseReady,setPhraseReady]=useState(false);
 useEffect(()=>{document.documentElement.dataset.theme=settings.theme},[settings.theme]);
 useEffect(()=>{function route(){stopSpeech();setCompletionText(null);const [hash,query]=location.hash.slice(1).split('?');setSelected(null);setRange(null);setPhraseReady(false);if(hash==='explore'){setView('explore');setTextId(null)}else if(hash&&hash!=='practice'){setTextId(hash);setView(new URLSearchParams(query).get('mode')==='practice'?'practice':'read')}else{setView('library');setTextId(null)}}route();addEventListener('hashchange',route);return()=>removeEventListener('hashchange',route)},[]);
 useEffect(()=>{if(!notice)return;const id=setTimeout(()=>setNotice(''),3500);return()=>clearTimeout(id)},[notice]);
 async function perform(fn:()=>Promise<unknown>){setError('');try{await fn()}catch(e){setError((e as Error).message)}}
 function refresh(){client.invalidateQueries({queryKey:['text']});client.invalidateQueries({queryKey:['library']});client.invalidateQueries({queryKey:['word']});client.invalidateQueries({queryKey:['explore']});client.invalidateQueries({queryKey:['practice']});client.invalidateQueries({queryKey:['activity']})}
 function openText(id:string,occurrenceId?:string){setDestination(occurrenceId?{id,occurrenceId,key:Date.now()}:null);stopSpeech();setTextId(id);setView('read');setSelected(null);setRange(null);setPhraseReady(false);location.hash=id+(occurrenceId?'?sentence='+occurrenceId:'');}
 function openPractice(){if(!textId)return;stopSpeech();setSelected(null);setRange(null);setPhraseReady(false);setDestination(null);setView('practice');location.hash=textId+'?mode=practice'}
 function navigate(v:typeof view){stopSpeech();setView(v);setSelected(null);setRange(null);setPhraseReady(false);if(v!=='read'){setTextId(null);location.hash=v==='library'?'':v}}
 function saveSettings(change:Partial<Settings>){
  const update={...change,readerLayout:'book' as const};
  const version=++settingsVersion.current;for(const key of Object.keys(update) as (keyof Settings)[])settingsFieldVersions.current[key]=version;
  settingsDraftRef.current={...settingsDraftRef.current,...update};setSettingsDraft(settingsDraftRef.current);
  settingsPending.current={...settingsPending.current,...update};clearTimeout(settingsTimer.current);
  settingsTimer.current=setTimeout(flushSettings,350);
 }
 function flushSettings(){
   clearTimeout(settingsTimer.current);
   // Read pending edits when the writer becomes free, so an in-flight save
   // cannot build a queue of obsolete slider positions.
   settingsQueue.current=settingsQueue.current.catch(()=>undefined).then(async()=>{
    const pending=settingsPending.current;const versions={...settingsFieldVersions.current};settingsPending.current={};
    if(!Object.keys(pending).length)return;
    try{
     const result=await api<{payload:string}>('/settings',pending,'PATCH');
     await client.cancelQueries({queryKey:['settings'],exact:true});
     client.setQueryData(['settings'],JSON.parse(result.payload));
     const draft={...settingsDraftRef.current};
     for(const key of Object.keys(pending) as (keyof Settings)[])if(settingsFieldVersions.current[key]===versions[key])delete draft[key];
     settingsDraftRef.current=draft;setSettingsDraft(draft);
    }catch(e){
     settingsPending.current={...pending,...settingsPending.current};
     setError((e as Error).message);
    }
   });
 }


 async function status(token:Token,area:Area,state:State,revision?:number,onlyIfNew=false){
  const key=token.baseId+':'+area;const previous=statusQueues.current.get(key);
  const request=(async()=>{
   if(previous)await previous.catch(()=>undefined);
   const expected=revision===undefined?undefined:Math.max(revision,statusRevisions.current.get(key)??0);
   const result=await api<{state:State;revision:number}>('/words/'+token.wordId+'/status',{area,state,revision:expected,onlyIfNew},'PUT');
   statusRevisions.current.set(key,result.revision);return result;
  })();
  statusQueues.current.set(key,request);
  try{
   const result=await request;
   // Discard any detail fetch that started before this acknowledged mutation.
   await client.cancelQueries({queryKey:['word',token.baseId],exact:true});
   setSelected(s=>s?.baseId===token.baseId&&s.statusRevisions[area]<=result.revision?{...s,states:{...s.states,[area]:result.state},statusRevisions:{...s.statusRevisions,[area]:result.revision}}:s);
   client.setQueryData<WordDetail>(['word',token.baseId],old=>old&&old.statuses[area].revision<=result.revision?{...old,statuses:{...old.statuses,[area]:result}}:old);
   refresh();
  }finally{if(statusQueues.current.get(key)===request)statusQueues.current.delete(key)}
 }

 async function learn(token:Token){
  const areas:Area[]=['listening','reading'];
  const previous=areas.map(area=>statusQueues.current.get(token.baseId+':'+area));
  const request=(async()=>{
   await Promise.all(previous.map(p=>p?.catch(()=>undefined)));
   const result=await api<{baseId:string;statuses:WordDetail['statuses']}>('/words/'+token.wordId+'/learn',{});
   for(const area of areas)statusRevisions.current.set(result.baseId+':'+area,result.statuses[area].revision);
   return result;
  })();
  const queued=areas.map(area=>{const projection=request.then(r=>r.statuses[area]);void projection.catch(()=>undefined);statusQueues.current.set(token.baseId+':'+area,projection);return projection});
  try{
   const {statuses}=await request;
   await client.cancelQueries({queryKey:['word',token.baseId],exact:true});
   for(const area of areas){const result=statuses[area];
    setSelected(s=>s?.baseId===token.baseId&&s.statusRevisions[area]<=result.revision?{...s,states:{...s.states,[area]:result.state},statusRevisions:{...s.statusRevisions,[area]:result.revision}}:s);
    client.setQueryData<WordDetail>(['word',token.baseId],old=>old&&old.statuses[area].revision<=result.revision?{...old,statuses:{...old.statuses,[area]:result}}:old);
   }
   refresh();
  }finally{areas.forEach((area,i)=>{const key=token.baseId+':'+area;if(statusQueues.current.get(key)===queued[i])statusQueues.current.delete(key)})}
 }
 function selectTokens(anchor:string,end:string,finished:boolean){
  if(!text)return;
  try{const next=phraseRange(text,anchor,end);if(!next)return;stopSpeech();setError('');setSelected(null);setRange(finished&&next.tokens.length<2?null:next);const ready=finished&&next.tokens.length>1;setPhraseReady(ready);
   // Keep play() in the selection-release/tap gesture, using the already mounted
   // player. A mount effect would lose native media activation on mobile.
   if(ready)void speak({text:next.phrase,transient:true});
  }catch(e){setError((e as Error).message)}
 }
 function pick(token:Token,sentence:Sentence){
  setRange(null);setSelected(token);void speak({text:token.base});
  if(token.states.listening==='new'||token.states.reading==='new')void perform(()=>learn(token));
 }
 const completed=library.filter(t=>!t.archived&&t.textState==='completed').length;
 return <div className={"app-shell "+(view==='read'?'is-reading':'')}>
  <audio ref={audioRef} preload="none" aria-hidden="true"/><aside className="rail"><a className="brand" href="#" onClick={e=>{e.preventDefault();navigate('library')}}><span className="brand-mark">言</span><span>Kotoba<span className="brand-sub">STUDIO</span></span></a><nav aria-label="Main navigation">{([['library',BookOpen,'Library'],['explore',Search,'Explore']] as const).map(([v,Icon,label])=><button key={v} aria-label={label} title={label} className={view===v||(v==='library'&&(view==='read'||view==='practice'))?'nav-active':''} onClick={()=>navigate(v)}><Icon size={19}/><span>{label}</span></button>)}</nav><div className="rail-bottom"><span className={'local-dot '+(!health?.workerReady?'quiet':'')}/><span>{health?.workerReady?'Language tools ready':'Language tools unavailable'}</span><button onClick={()=>setSettingsOpen(true)}><Settings2 size={17}/> Settings</button></div></aside>
  <main className="main"><PwaStatus/><header className="topbar"><span className="breadcrumb">{view==='read'?'Reading':view[0].toUpperCase()+view.slice(1)}</span><div className="top-actions"><IconButton label="Settings" onClick={()=>setSettingsOpen(true)}><Settings2 size={19}/></IconButton><button className="primary compact" onClick={()=>{setEditing(null);setImportOpen(true)}}><Plus size={17}/><span>Import text</span></button></div></header>
  {(error||libraryError||textError)&&<div className="error" role="alert"><span>{error||(libraryError as Error)?.message||(textError as Error)?.message}</span><button onClick={()=>{setError('');flushSettings();refresh()}}>Retry</button><IconButton label="Dismiss error" onClick={()=>setError('')}><X size={16}/></IconButton></div>}
  {notice&&<div className="toast" role="status"><Check size={17}/>{notice}</div>}
  {view==='library'&&<Library texts={library} loading={libraryLoading} completed={completed} open={openText} importText={()=>{setEditing(null);setImportOpen(true)}}/>}
  {view==='read'&&text&&<div className="reading-layout"><Reader destination={destination?.id===text.id?destination:null} text={text} settings={settings} openOptions={()=>setSettingsOpen(true)} selected={selected} range={range} selectTokens={selectTokens} pick={pick} speak={p=>perform(()=>speak(p))} speechBusy={busy} close={()=>navigate('library')} practice={openPractice} complete={()=>{if(text.textState==='completed')void perform(async()=>{await api('/texts/'+text.id+'/status',{state:'new'},'PUT');refresh();setNotice('Text marked as New')});else setCompletionText(text)}} markRemaining={()=>setCompletionText(text)} progress={cursor=>perform(async()=>{await api('/texts/'+text.id+'/progress',{cursor},'PUT');refresh()})} edit={()=>{setEditing(text);setImportOpen(true)}} archive={()=>perform(async()=>{await api('/texts/'+text.id,{archived:!text.archived,revision:text.revision},'PATCH');refresh();navigate('library')})}/>{selected&&<WordPanel token={selected} sentence={text.sentences.find(s=>s.tokens.some(t=>t.id===selected.id))} speakSentence={body=>speak({text:body})} close={()=>setSelected(null)} speak={()=>speak({text:selected.base})} speechBusy={busy} change={(a,s,r)=>perform(()=>status(selected,a,s,r))} open={openText} onCorrect={()=>{refresh();setSelected(null);setNotice('Meaning updated')}} onError={setError}/>}</div>}
  {view==='explore'&&<Explore area={settings.area} open={openText}/>}
  {view==='practice'&&text&&<Practice key={text.id} textId={text.id} title={text.title} onClose={()=>openText(text.id)} area={settings.area} onError={setError} speak={speak}/>}
  </main>
  <nav className="mobile-nav" aria-label="Mobile navigation"><button className={view==='library'||view==='read'||view==='practice'?'active':''} onClick={()=>navigate('library')}><BookOpen size={20}/>Library</button><button className={view==='explore'?'active':''} onClick={()=>navigate('explore')}><Search size={20}/>Explore</button></nav>
  {importOpen&&<ImportDialog previous={editing} onClose={()=>setImportOpen(false)} onImported={id=>{setImportOpen(false);refresh();openText(id)}} folders={[...new Set(library.flatMap(t=>(t.folders??[]).map(f=>f.name)))]}/>}
  {completionText&&<CompletionDialog text={completionText} close={()=>setCompletionText(null)} done={()=>{setCompletionText(null);refresh();setNotice('Lesson completed')}}/>}
  {settingsOpen&&<Modal title="Settings" onClose={()=>setSettingsOpen(false)}><ReaderSettings settings={settings} change={saveSettings}/></Modal>}
  {range&&phraseReady&&range.tokens.length>1&&<PhraseDialog range={range} speechBusy={busy} speechError={error} speak={()=>speak({text:range.phrase,transient:true})} close={()=>{stopSpeech();setError('');setRange(null);setPhraseReady(false)}}/>}
 </div>
}
function Library({texts,loading,completed,open,importText}:{texts:TextItem[];loading:boolean;completed:number;open:(id:string)=>void;importText:()=>void}){
 const [q,setQ]=useState('');const [filter,setFilter]=useState('all');const [folder,setFolder]=useState('');
 const {data:jobs=[]}=useQuery({queryKey:['jobs'],queryFn:()=>api<Job[]>('/jobs'),refetchInterval:1000});
 const {data:statistics}=useData<{meanings:number;sentences:number}>(['statistics'],'/statistics');
 const active=texts.filter(t=>filter==='archived'?t.archived:!t.archived).filter(t=>(filter==='all'||filter==='archived'||t.textState===filter)&&(!folder||t.folders?.some(f=>f.name===folder))&&(t.title+' '+t.body).includes(q));

 return <section className="page library-page"><header className="page-heading"><h1>Library</h1></header><div className="stats-row"><div><span className="stat-number">{texts.filter(t=>!t.archived).length}</span><span>texts in your library</span></div><div><span className="stat-number">{completed}</span><span>completed</span></div><div><span className="stat-number">{statistics?.meanings??0}</span><span>meanings in your corpus</span></div></div>
 <div className="library-tools"><div className="tabs">{[['all','All texts'],['new','New'],['completed','Completed'],['archived','Archived']].map(([id,label])=><button key={id} className={filter===id?'active':''} onClick={()=>setFilter(id)}>{label}</button>)}</div><div className="search-field"><Search size={17}/><input aria-label="Search library" placeholder="Find a text…" value={q} onChange={e=>setQ(e.target.value)}/></div><select aria-label="Filter folder" value={folder} onChange={e=>setFolder(e.target.value)}><option value="">All folders</option>{[...new Set(texts.flatMap(t=>(t.folders??[]).map(f=>f.name)))].map(n=><option key={n}>{n}</option>)}</select></div>
 {jobs.filter(j=>j.kind==='import'&&j.state!=='ready').map(j=><div className="job-card" key={j.id}><RefreshCw size={17} className={j.state==='running'?'spin':''}/><JobProgress job={j}/>{j.state==='failed'&&<button onClick={()=>api('/jobs/'+j.id+'/retry',{})}>Retry</button>}</div>)}
 {loading?<p className="empty">Loading…</p>:active.length===0?<div className="empty"><BookOpen size={34}/><h3>{texts.length?'No matching texts':'No texts'}</h3><button className="primary" onClick={importText}><Plus size={17}/>Add text</button></div>:<div className="text-grid">{active.map((t,i)=><button className="text-card" key={t.id} onClick={()=>open(t.id)}><div className="card-top"><span className="card-index">{String(i+1).padStart(2,'0')}</span><span className={'pill '+t.textState}>{t.textState==='completed'?<Check size={12}/>:<span className="dot"/>}{t.textState==='completed'?'Completed':'New'}</span></div><h3>{t.title}</h3><p lang="ja" className="excerpt">{t.body.slice(0,90)}</p><div className="card-bottom"><span>{t.folders?.[0]?.name??'Unfiled'}</span><ChevronRight size={18}/></div><div className="progress-track"><span style={{width:Math.min(100,100*t.cursor/Math.max(1,t.body.length))+'%'}}/></div></button>)}</div>}
 </section>
}
function JobProgress({job}:{job:Job}){
 const p=job.progress;const labels:Record<string,string>={queued:'Queued',starting:'Starting',dictionary:'Dictionary lookup',saving:'Saving words and sentences',validating:'Validating database',ready:'Completed',failed:'Failed'};
 const duration=(seconds:number)=>seconds<60?Math.ceil(seconds)+'s':Math.ceil(seconds/60)+' min';
 return <div className="import-progress" role="status"><strong>{job.title||'Import'}</strong>{job.state==='failed'?<span>{job.error}</span>:<><span>{labels[p.stage]??p.stage} · {p.percent}%{p.total>0&&['dictionary','saving'].includes(p.stage)?` · ${p.completed}/${p.total} sentences`:''}</span><progress aria-label="Import progress" max={100} value={p.percent}/><small>{duration(p.elapsedSeconds)} elapsed · {p.stalled?`No progress for ${duration(p.secondsSinceProgress)}`:p.estimatedRemainingSeconds!==null?`About ${duration(p.estimatedRemainingSeconds)} remaining`:p.stage==='queued'?'Waiting for worker':'Estimating remaining time…'}</small></>}</div>
}
function ImportDialog({previous,onClose,onImported,folders}:{previous:TextItem|null;onClose:()=>void;onImported:(id:string)=>void;folders:string[]}){
 const [title,setTitle]=useState(previous?.title??'');const [body,setBody]=useState(previous?.body??'');const [folder,setFolder]=useState(previous?.folders?.[0]?.name??'');const [source,setSource]=useState(previous?.sources?.find(s=>/^https?:/.test(s.url))?.url??'');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [jobId,setJobId]=useState('');
 const {data:job}=useQuery({queryKey:['job',jobId],queryFn:()=>api<Job>('/jobs/'+jobId),enabled:!!jobId,refetchInterval:1000});
 async function submit(e:React.FormEvent){e.preventDefault();setError('');setBusy(true);try{if(previous&&body===previous.body){await api('/texts/'+previous.id,{title,revision:previous.revision},'PATCH')}const r=await api<{textId?:string;jobId?:string}>('/imports',{title,body,folder,sourceUrl:source,...(previous?{previousId:previous.id}:{})});if(r.textId)onImported(r.textId);else{setJobId(r.jobId!);const done=await waitJob(r.jobId!);onImported(done.textId)}}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 return <Modal title={previous?'Edit text':'Import text'} onClose={onClose} wide><form onSubmit={submit} className="import-form"><label>Title<input autoFocus required maxLength={200} placeholder="Text title" value={title} onChange={e=>setTitle(e.target.value)} disabled={busy}/></label><label>Japanese text<textarea required lang="ja" placeholder="ここに日本語の文章を貼り付けてください。" value={body} onChange={e=>setBody(e.target.value)} maxLength={50000} disabled={busy}/></label><div className="import-meta"><label className="file-button"><Download size={15}/> Load a text file<input type="file" accept=".txt,.md,text/plain" disabled={busy} onChange={async e=>{const f=e.target.files?.[0];if(f){setBody(await f.text());if(!title)setTitle(f.name.replace(/\.[^.]+$/,''))}}}/></label><span>{body.length.toLocaleString()} / 50,000</span></div><div className="form-columns"><label>Folder<input value={folder} onChange={e=>setFolder(e.target.value)} list="folder-options" placeholder="Optional"/><datalist id="folder-options">{folders.map(f=><option key={f} value={f}/>)}</datalist></label><label>Source link <span className="muted">optional</span><input type="url" value={source} onChange={e=>setSource(e.target.value)} placeholder="https://…"/></label></div>{error&&<p role="alert" className="error">{error}</p>}<div className="dialog-footer"><span className="muted">{busy?'Import continues if you close this window.':''}</span><button className="primary" disabled={busy||!body.trim()||!title.trim()}>{busy?<RefreshCw size={16} className="spin"/>:<ArrowUpRight size={17}/>} {busy?'Importing…':previous?'Save revision':'Import & read'}</button></div>{job&&<JobProgress job={job}/>}</form></Modal>
}
function Reader({destination,text,settings,openOptions,selected,range,selectTokens,pick,speak,speechBusy,close,practice,complete,markRemaining,progress,edit,archive}:{destination:{occurrenceId:string;key:number}|null;text:TextItem;settings:Settings;openOptions:()=>void;selected:Token|null;range:PhraseRange|null;selectTokens:(anchor:string,end:string,finished:boolean)=>void;pick:(t:Token,s:Sentence)=>void;speak:(p:{text:string})=>void;speechBusy:boolean;close:()=>void;practice:()=>void;complete:()=>void;markRemaining:()=>void;progress:(c:number)=>void;edit:()=>void;archive:()=>void}){
 const [menu,setMenu]=useState(false);const root=useRef<HTMLElement>(null);const book=useRef<HTMLDivElement>(null);useTokenSelection(book,text.id,selectTokens);const progressState=useReadingProgress(text.id,text.cursor,root);
 useEffect(()=>{
  const placement=destination?.occurrenceId??new URLSearchParams(location.hash.split('?')[1]).get('sentence');
  if(!placement)return;
  const el=root.current?.querySelector<HTMLElement>(`[data-sentence="${CSS.escape(placement)}"]`);if(!el)return;
  el.scrollIntoView({block:'center'});el.classList.remove('example-highlight');void el.offsetWidth;el.classList.add('example-highlight');
  const timer=setTimeout(()=>el.classList.remove('example-highlight'),2200);return()=>clearTimeout(timer);
 },[text.id,destination?.key]);

 const paragraphs:Sentence[][]=[];
 for(const sentence of text.sentences){const group=paragraphs.at(-1);const previous=group?.at(-1);if(!previous||sliceText(text.body,previous.end,sentence.start).includes('\n'))paragraphs.push([sentence]);else group!.push(sentence)}
 return <article className="reader" ref={root} data-text-id={text.id}><div className="reader-toolbar"><button className="back-button" onClick={close}><ArrowLeft size={17}/>Library</button><span className={'pill '+text.textState}>{text.textState==='completed'?'Completed':'New'}</span><div className="reader-tools"><button className="reader-options" aria-label="Reading options" onClick={openOptions}>Aa</button><div className="menu-wrap"><IconButton label="Text options" onClick={()=>setMenu(v=>!v)}><MoreHorizontal size={20}/></IconButton>{menu&&<div className="dropdown"><button onClick={()=>{edit();setMenu(false)}}>Edit text</button><button onClick={()=>{archive();setMenu(false)}}>{text.archived?'Restore text':'Archive text'}</button></div>}</div></div></div><div className="reader-heading"><h1>{text.title}</h1><div className="reader-meta"><span>{text.sentences.length} sentences</span><span>·</span><span>{text.sentences.reduce((n,s)=>n+s.tokens.length,0)} words</span>{text.sources.filter(s=>/^https?:/.test(s.url)).map(s=><a key={s.url} href={s.url} target="_blank" rel="noreferrer">Original source <ArrowUpRight size={13}/></a>)}</div></div><div className="reading-legend">{STATES.map(s=><span key={s}><i className={'state-dot '+s}/>{s[0].toUpperCase()+s.slice(1)}</span>)}</div>
 <div ref={book} className="japanese-text book-body" lang="ja" style={{fontSize:settings.fontSize,lineHeight:settings.lineHeight}}>{paragraphs.map((paragraph,index)=><p className="book-paragraph" key={index}>{paragraph.map((sentence,i)=>{let cursor=0;const content:React.ReactNode[]=[];const spans=selectionTokens(sentence);spans.forEach((span,tokenIndex)=>{content.push(sliceText(sentence.body,cursor,span.start));const tail=tokenIndex===spans.length-1?sliceText(sentence.body,span.end):'';const t=span.word;const highlighted=range?.tokens.some(r=>r.id===span.id);content.push(<span className={tail?'word-ending':undefined} key={span.id}>{t?<button className={'token '+t.states[settings.area]+(selected?.id===t.id?' is-selected':'')+(highlighted?' range-selected':'')} onClick={()=>pick(t,sentence)} aria-label={t.meaning?t.surface+' · '+t.meaning:t.surface} data-token-id={t.id} data-selection-id={t.id} data-word-end={sentence.start+t.end}><ruby>{t.surface}{settings.furigana&&t.reading&&!['known','familiar'].includes(t.states.reading)&&<rt>{t.reading}</rt>}</ruby></button>:<span className={'reader-literal'+(highlighted?' range-selected':'')} data-selection-id={span.id} data-word-end={sentence.start+span.end}>{span.surface}</span>}{tail}</span>);cursor=tail?Array.from(sentence.body).length:span.end});content.push(sliceText(sentence.body,cursor));return <React.Fragment key={sentence.id}>{i>0?sliceText(text.body,paragraph[i-1].end,sentence.start):null}<span className="sentence-row" data-sentence={sentence.id}><span className="sentence-content">{content}</span></span></React.Fragment>})}</p>)}</div>
 <div className="book-progress" aria-label="Reading progress">{Math.min(100,Math.round(100*text.cursor/Math.max(1,Array.from(text.body).length)))}% · {progressState==='saved'?'Position saved automatically':progressState==='saving'?'Saving position…':'Position saved on this device. Waiting to sync.'}</div>
 {text.phrases.length>0&&<section className="saved-phrases"><h3>Saved phrases</h3>{text.phrases.map(p=><div key={p.phrase.id}><strong lang="ja">{p.phrase.surface}</strong><span>{p.phrase.meaning}</span></div>)}</section>}
 <footer className="reader-finish">{text.textState==='completed'&&text.sentences.some(s=>s.tokens.some(t=>t.states.listening==='new'||t.states.reading==='new'))&&<button className="secondary" onClick={markRemaining}>Mark new words Known</button>}<button className="secondary" onClick={practice}><Layers size={18}/>Practice</button><button className={text.textState==='completed'?'secondary':'primary'} onClick={complete}><CheckCheck size={18}/>{text.textState==='completed'?'Mark as New':'Complete text'}</button></footer></article>
}
function CompletionDialog({text,close,done}:{text:TextItem;close:()=>void;done:()=>void}){
 const {data,error:loadError,refetch,isFetching}=useQuery({queryKey:['completion',text.id],queryFn:()=>api<{wordCount:number;revision:number;fingerprint:string}>('/texts/'+text.id+'/completion'),staleTime:0,refetchOnWindowFocus:false});
 const [busy,setBusy]=useState(false),[error,setError]=useState('');const label=text.textState==='completed'?'Mark words Known':'Complete lesson';
 async function confirm(){if(!data||busy||isFetching)return;setBusy(true);setError('');try{await api('/texts/'+text.id+'/status',{state:'completed',revision:data.revision,completionFingerprint:data.fingerprint},'PUT');done()}catch(e){setError((e as Error).message);void refetch()}finally{setBusy(false)}}
 return <Modal title={label} onClose={close}><div className="completion-details">{!data?<p role="status">Loading word count…</p>:<p>{data.wordCount} {data.wordCount===1?'word':'words'} with New in Listening or Reading will be marked Known in both areas. All forms share these statuses.</p>}{(loadError||error)&&<p role="alert">{error||(loadError as Error).message}</p>}<div className="completion-actions"><button className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={!data||busy||isFetching} onClick={()=>void confirm()}>{busy?'Saving…':label}</button></div></div></Modal>
}
function WordPanel({token,sentence,speakSentence,close,speak,speechBusy,change,open,onCorrect,onError}:{token:Token;sentence?:Sentence;speakSentence:(text:string)=>Promise<void>;close:()=>void;speak:()=>Promise<void>;speechBusy:boolean;change:(a:Area,s:State,r?:number)=>void;open:(id:string,occurrenceId?:string)=>void;onCorrect:()=>void;onError:(e:string)=>void}){
 const {data:word}=useData<WordDetail>(['word',token.baseId],'/words/'+token.baseId);const [translation,setTranslation]=useState('');const [translating,setTranslating]=useState(false);async function translateSentence(){if(!sentence)return;setTranslating(true);try{const r=await api<{translation?:string;jobId?:string}>('/translations',{text:sentence.body});setTranslation(r.translation??(await waitJob(r.jobId!)).translation)}catch(e){onError((e as Error).message)}finally{setTranslating(false)}}const [correcting,setCorrecting]=useState(false);const [meaning,setMeaning]=useState('');const [allMeanings,setAllMeanings]=useState(false);
 useEffect(()=>{setCorrecting(false);setMeaning('');setTranslation('');setAllMeanings(false)},[token.id]);
 async function correct(){try{await api('/occurrences/'+token.id+'/meaning',{meaning,reading:word?.reading??token.reading,baseForm:true});onCorrect()}catch(e){onError((e as Error).message)}}
 return <ReadingDetails label="Word details" closeLabel="Close word details" text={word?.surface??token.base} reading={word?.reading??(token.wordId===token.baseId?token.reading:'')} copyLabel="Copy word" pronounceLabel="Pronounce word" speak={speak} busy={speechBusy} close={close}><div className="word-meanings">{!word?<p>Loading meanings…</p>:word.meanings.length?<ol>{(allMeanings?word.meanings:word.meanings.slice(0,3)).map(m=><li key={m.id}><span>{m.body}</span><small>{[m.reading,m.partOfSpeech,m.sourceType].filter(Boolean).join(' · ')}</small></li>)}</ol>:<MissingMeanings key={word.id} wordId={word.id}/>}{word&&word.meanings.length>3&&<button className="text-button" aria-expanded={allMeanings} onClick={()=>setAllMeanings(v=>!v)}>{allMeanings?'Show fewer meanings':`Show all meanings (${word.meanings.length})`}</button>}</div>{token.surface!==token.base&&<div className="base-note">In this sentence <strong lang="ja">{token.surface}</strong></div>}<div className="status-section"><h3>Learning status</h3><p>Shared with the base form and its other forms.</p>{(['listening','reading'] as Area[]).map(area=><div className="area-control" key={area}><label>{area==='reading'?<BookOpen size={16}/>:<Headphones size={16}/>} {area[0].toUpperCase()+area.slice(1)}</label><div className="status-switch" role="group" aria-label={area+' status'}>{STATES.map(state=><button key={state} aria-pressed={(word?.statuses[area].state??token.states[area])===state} className={(word?.statuses[area].state??token.states[area])===state?'chosen '+state:''} onClick={()=>change(area,state,word?.statuses[area].revision??token.statusRevisions[area])}>{state[0].toUpperCase()+state.slice(1)}</button>)}</div></div>)}</div><section className="word-section sentence-context"><h3>Sentence</h3><div className="sentence-source">{sentence&&<CopyButton text={sentence.body} label="Copy sentence"/>}<p lang="ja">{sentence?.body}</p></div><div className="context-actions"><button className="text-button" disabled={speechBusy} onClick={()=>{if(sentence)void speakSentence(sentence.body)}}><Volume2 size={16}/>Listen</button><button className="text-button" disabled={translating} onClick={translateSentence}>{translating?'Translating…':'Sentence meaning'}</button></div>{translation&&<p className="context-translation">{translation}</p>}</section><section className="word-section"><h3>Word forms</h3><div className="form-chips">{word?.forms.map(f=><span key={f.id} lang="ja">{f.surface}</span>)}</div></section><section className="word-section"><h3>Examples <span>{word?.examples.length??0}</span></h3>{word?.examples.slice(0,12).map((e,i)=><button className="example-link" key={i} onClick={()=>open(e.textId,e.occurrenceId)}><span lang="ja">{e.body}</span><small>{e.title}{e.seen?' · Already read':''}<ChevronRight size={12}/></small></button>)}</section><button className="text-button correct-button" onClick={()=>setCorrecting(v=>!v)}>Add meaning</button>{correcting&&<div className="correction-form"><label>Meaning<input value={meaning} onChange={e=>setMeaning(e.target.value)} placeholder="Enter a meaning"/></label><button className="primary" disabled={!meaning.trim()} onClick={correct}>Save meaning</button></div>}</ReadingDetails>
}
function PhraseDialog({range,close,speak,speechBusy,speechError}:{range:PhraseRange;close:()=>void;speak:()=>Promise<void>;speechBusy:boolean;speechError:string}){
 const [meaning,setMeaning]=useState('');const [translating,setTranslating]=useState(true);const [error,setError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();setMeaning('');setTranslating(true);setError('');
  void (async()=>{
   try{const r=await api<{jobId:string}>('/phrase-tools/translation',{text:range.phrase,context:range.context},undefined,{signal:controller.signal});const result=await waitJob(r.jobId,controller.signal);if(!controller.signal.aborted)setMeaning(result.translation)}
   catch(e){if(!controller.signal.aborted)setError((e as Error).message)}finally{if(!controller.signal.aborted)setTranslating(false)}
  })();
  return()=>controller.abort();
 },[range.phrase,range.context]);
 return <ReadingDetails label="Selected phrase" closeLabel="Close" text={range.phrase} textClass="phrase-japanese" copyLabel="Copy phrase" pronounceLabel="Pronounce phrase" speak={speak} busy={speechBusy} close={close}><p className="phrase-translation" aria-live="polite" aria-busy={translating}>{translating?'Translating…':meaning}</p>{(error||speechError)&&<p role="alert">{error||speechError}</p>}</ReadingDetails>
}
function Explore({area,open}:{area:Area;open:(id:string,occurrenceId?:string)=>void}){
 const [q,setQ]=useState('');const [search,setSearch]=useState('');useEffect(()=>{const timer=setTimeout(()=>setSearch(q),200);return()=>clearTimeout(timer)},[q]);const [minimum,setMinimum]=useState(false);const [seen,setSeen]=useState('all');const [mode,setMode]=useState(area);
 const {data:examples=[],isLoading}=useData<Example[]>(['explore',search,minimum,seen,mode],'/explore?'+new URLSearchParams({q:search,area:mode,minimum:minimum?'0.8':'0',seen}));
 return <section className="page"><header className="page-heading"><h1>Explore</h1></header><div className="explore-search"><Search size={22}/><input autoFocus aria-label="Search corpus" placeholder="A Japanese word, an English meaning, a sentence…" value={q} onChange={e=>setQ(e.target.value)}/></div><div className="explore-filters"><label><input type="checkbox" checked={minimum} onChange={e=>setMinimum(e.target.checked)}/>At least 80% known</label><select aria-label="Learning area" value={mode} onChange={e=>setMode(e.target.value as Area)}><option value="listening">Listening knowledge</option><option value="reading">Reading knowledge</option></select><select aria-label="Reading history" value={seen} onChange={e=>setSeen(e.target.value)}><option value="all">Any reading history</option><option value="seen">Already read</option><option value="unseen">Not read yet</option></select></div><div className="section-heading"><h2>{isLoading?'Searching…':`${examples.length} sentences`}</h2></div><div className="example-grid">{examples.map(e=><button className="explore-card" key={e.occurrenceId} onClick={()=>open(e.textId,e.occurrenceId)}><div className="example-top"><span>{e.title}</span><span>{e.seen?'Already read':'Unread'}</span></div><p lang="ja">{e.body}</p><div className="coverage-bar">{STATES.map(s=><span key={s} className={s} style={{width:100*(e.counts[s]??0)/e.words.length+'%'}}/>)}</div><div className="example-bottom"><span>{Math.round(e.coverage*100)}% known</span><ArrowUpRight size={17}/></div></button>)}</div>{!isLoading&&!examples.length&&<p className="empty">No matching sentences.</p>}</section>
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={qc}><App/></QueryClientProvider>);
