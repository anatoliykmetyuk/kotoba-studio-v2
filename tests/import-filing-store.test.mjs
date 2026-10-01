import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root=fileURLToPath(new URL('..',import.meta.url));
await mkdir(path.join(root,'.runtime'),{recursive:true});
const output=await mkdtemp(path.join(root,'.runtime/filing-tests-'));
const source=await readFile(path.join(root,'web/src/import-filing-store.ts'),'utf8');
await writeFile(path.join(output,'store.mjs'),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
const {createFilingStore,legacyFilingKey,filingEntryPrefix,filingTerminalPrefix}=await import(pathToFileURL(path.join(output,'store.mjs')));
after(()=>rm(output,{recursive:true,force:true}));

class BrowserStorage{
 values=new Map();quota=false;
 get length(){return this.values.size}
 key(index){return [...this.values.keys()][index]??null}
 getItem(key){return this.values.get(key)??null}
 setItem(key,value){if(this.quota)throw new DOMException('Quota exceeded','QuotaExceededError');this.values.set(key,String(value))}
 removeItem(key){this.values.delete(key)}
}
const filing=id=>({id,folder:{id:'folder-'+id,name:id},jobId:'job-'+id});
const ids=store=>store.getSnapshot().map(item=>item.id).sort();
const event=(storage,id)=>({key:filingEntryPrefix+id,newValue:storage.getItem(filingEntryPrefix+id),storageArea:storage});

test('two tabs accepting before storage events retain both requests after reload',()=>{
 const storage=new BrowserStorage(),first=createFilingStore(storage),second=createFilingStore(storage);
 first.update(current=>[...current,filing('first')]);second.update(current=>[...current,filing('second')]);
 assert.deepEqual(ids(first),['first']);assert.deepEqual(ids(second),['second']);
 assert.deepEqual(ids(createFilingStore(storage)),['first','second']);
 first.sync(event(storage,'second'));second.sync(event(storage,'first'));
 assert.deepEqual(ids(first),['first','second']);assert.deepEqual(ids(second),['first','second']);
});

test('completing one stale tab request does not overwrite another tab request or its retry state',()=>{
 const storage=new BrowserStorage(),first=createFilingStore(storage),second=createFilingStore(storage);
 first.update(current=>[...current,filing('first')]);second.update(current=>[...current,{...filing('second'),textId:'saved-second',error:'Folder missing'}]);
 first.update(current=>current.filter(item=>item.id!=='first'));
 const restored=createFilingStore(storage);assert.deepEqual(ids(restored),['second']);assert.equal(restored.getSnapshot()[0].error,'Folder missing');
 second.update(current=>current.map(item=>({...item,error:undefined})));
 assert.equal(createFilingStore(storage).getSnapshot()[0].error,undefined);
});

test('readable storage with quota failures preserves accepted entries, errors and retry in memory',()=>{
 const storage=new BrowserStorage();storage.setItem(legacyFilingKey,'[]');storage.quota=true;const store=createFilingStore(storage);
 store.update(current=>[...current,filing('first')]);
 store.update(current=>current.map(item=>({...item,textId:'saved-first',error:'Folder missing'})));
 store.update(current=>[...current,filing('second')]);assert.deepEqual(ids(store),['first','second']);assert.equal(store.getSnapshot()[0].error,'Folder missing');
 store.update(current=>current.map(item=>item.id==='first'?{...item,error:undefined}:item));assert.equal(store.getSnapshot()[0].error,undefined);
 store.update(current=>current.filter(item=>item.id!=='first'));assert.deepEqual(ids(store),['second']);assert.equal(storage.getItem(legacyFilingKey),'[]');
});

test('remote storage events and clearing persisted storage retain unsaved local entries',()=>{
 const storage=new BrowserStorage(),store=createFilingStore(storage);storage.quota=true;
 store.update(current=>[...current,filing('local')]);storage.quota=false;storage.setItem(filingEntryPrefix+'remote',JSON.stringify(filing('remote')));
 store.sync(event(storage,'remote'));assert.deepEqual(ids(store),['local','remote']);
 storage.values.clear();store.sync({key:null,newValue:null,storageArea:storage});assert.deepEqual(ids(store),['local']);
});

test('legacy whole-queue data migrates to independent entries and preserves newer entry state',()=>{
 const storage=new BrowserStorage();storage.setItem(legacyFilingKey,JSON.stringify([filing('first'),{...filing('second'),error:'Old observation failure'}]));
 storage.setItem(filingEntryPrefix+'first',JSON.stringify({...filing('first'),textId:'saved-first',error:'Retry filing'}));
 const store=createFilingStore(storage);assert.deepEqual(ids(store),['first','second']);assert.equal(storage.getItem(legacyFilingKey),null);
 assert.equal(store.getSnapshot().find(item=>item.id==='first').textId,'saved-first');assert.equal(store.getSnapshot().find(item=>item.id==='second').error,undefined);
 assert.deepEqual(ids(createFilingStore(storage)),['first','second']);
});

test('failed legacy migration retains its original persisted queue and live retry state',()=>{
 const storage=new BrowserStorage();storage.setItem(legacyFilingKey,JSON.stringify([filing('first')]));storage.quota=true;
 const store=createFilingStore(storage);store.update(current=>current.map(item=>({...item,textId:'saved-first',error:'Folder missing'})));
 assert.equal(store.getSnapshot()[0].error,'Folder missing');assert.notEqual(storage.getItem(legacyFilingKey),null);
 assert.deepEqual(ids(createFilingStore(storage)),['first']);
});

test('delayed storage events cannot restore obsolete state or a completed entry',()=>{
 const storage=new BrowserStorage(),store=createFilingStore(storage),old=filing('first');
 storage.setItem(filingEntryPrefix+old.id,JSON.stringify({...old,textId:'saved-first'}));
 const delayed={key:filingEntryPrefix+old.id,newValue:JSON.stringify(old),storageArea:storage};store.sync(delayed);
 assert.equal(store.getSnapshot()[0].textId,'saved-first');storage.removeItem(delayed.key);store.sync(delayed);assert.deepEqual(ids(store),[]);
});

test('malformed and mismatched entries are ignored without changing unrelated storage',()=>{
 const storage=new BrowserStorage();storage.setItem('other-feature','retained');storage.setItem(filingEntryPrefix+'invalid','{');
 storage.setItem(filingEntryPrefix+'wrong-id',JSON.stringify(filing('different-id')));storage.setItem(filingEntryPrefix+'bad',JSON.stringify({id:'bad',folder:{id:'folder',name:'folder'},jobId:42}));
 assert.deepEqual(ids(createFilingStore(storage)),[]);assert.equal(storage.getItem('other-feature'),'retained');
});

test('a stale tab cannot resurrect an entry completed or dismissed before its removal event',()=>{
 const storage=new BrowserStorage(),saved={...filing('first'),textId:'saved-first'};
 storage.setItem(filingEntryPrefix+saved.id,JSON.stringify(saved));
 const first=createFilingStore(storage),stale=createFilingStore(storage);
 first.update(current=>current.filter(item=>item.id!==saved.id));
 stale.update(current=>current.map(item=>({...item,error:'Offline'})));
 assert.deepEqual(ids(stale),[]);assert.deepEqual(ids(createFilingStore(storage)),[]);
 assert.equal(storage.getItem(filingTerminalPrefix+saved.id),'1');assert.equal(storage.getItem(filingEntryPrefix+saved.id),null);
});

test('terminal state dominates a stale entry write interleaved with its completion',()=>{
 const storage=new BrowserStorage(),saved={...filing('first'),textId:'saved-first'};
 storage.setItem(filingEntryPrefix+saved.id,JSON.stringify(saved));
 const first=createFilingStore(storage),stale=createFilingStore(storage),write=storage.setItem.bind(storage);
 let completing=false;
 storage.setItem=(key,value)=>{
  if(key===filingEntryPrefix+saved.id&&!completing){completing=true;first.update(current=>current.filter(item=>item.id!==saved.id))}
  write(key,value);
 };
 stale.update(current=>current.map(item=>({...item,error:'Offline'})));
 assert.deepEqual(ids(stale),[]);assert.deepEqual(ids(createFilingStore(storage)),[]);
});

test('recovered quota cannot resurrect a completed request from a partially migrated legacy queue',()=>{
 const storage=new BrowserStorage(),saved={...filing('first'),textId:'saved-first'};
 storage.setItem(legacyFilingKey,JSON.stringify([saved,filing('second')]));storage.quota=true;
 const store=createFilingStore(storage);assert.notEqual(storage.getItem(legacyFilingKey),null);
 storage.quota=false;store.update(current=>current.filter(item=>item.id!==saved.id));
 const restored=createFilingStore(storage);assert.deepEqual(ids(restored),['second']);assert.equal(storage.getItem(legacyFilingKey),null);
 assert.equal(storage.getItem(filingTerminalPrefix+saved.id),'1');
});

test('unsaved terminal records survive quota failures and storage events and persist after recovery',()=>{
 const storage=new BrowserStorage(),saved={...filing('first'),textId:'saved-first'};
 storage.setItem(legacyFilingKey,JSON.stringify([saved]));storage.quota=true;
 const store=createFilingStore(storage);store.update(current=>current.filter(item=>item.id!==saved.id));
 storage.values.set(filingEntryPrefix+saved.id,JSON.stringify({...saved,error:'Stale tab error'}));
 store.sync(event(storage,saved.id));assert.deepEqual(ids(store),[]);assert.equal(storage.getItem(filingTerminalPrefix+saved.id),null);
 store.sync({key:legacyFilingKey,newValue:storage.getItem(legacyFilingKey),storageArea:storage});assert.deepEqual(ids(store),[]);
 storage.quota=false;store.sync(event(storage,saved.id));
 assert.equal(storage.getItem(filingTerminalPrefix+saved.id),'1');assert.deepEqual(ids(createFilingStore(storage)),[]);
});
