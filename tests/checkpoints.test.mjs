import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root=fileURLToPath(new URL('..',import.meta.url));
await mkdir(path.join(root,'.runtime'),{recursive:true});
const output=await mkdtemp(path.join(root,'.runtime/checkpoint-tests-'));
for(const name of ['checkpoints','checkpoint-store']){
 const source=await readFile(path.join(root,`web/src/${name}.ts`),'utf8');
 await writeFile(path.join(output,`${name}.mjs`),ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
}
const {readingSections,readingProgress,applyCheckpoint}=await import(pathToFileURL(path.join(output,'checkpoints.mjs')));
const {createCheckpointStore,checkpointPrefix,nextCheckpointBatch}=await import(pathToFileURL(path.join(output,'checkpoint-store.mjs')));
after(()=>rm(output,{recursive:true,force:true}));

function sentence(index,count,completed=false){return {id:'sentence-'+index,start:index*100,end:index*100+99,completed,tokens:Array.from({length:count},(_,i)=>({id:`token-${index}-${i}`,baseId:`base-${index}-${i}`,state:'new'}))}}
const change=(start,end,completed=true)=>({textId:'text',start,end,completed});
test('round up through a long sentence, then reset counting; retain short final and tokenless sections',()=>{
 const sentences=[sentence(0,6),sentence(1,7),sentence(2,9),sentence(3,1),sentence(4,25),sentence(5,0)];
 assert.deepEqual(readingSections(sentences,10).map(s=>s.sentences.map(s=>s.id)),[['sentence-0','sentence-1'],['sentence-2','sentence-3'],['sentence-4'],['sentence-5']]);
 assert.deepEqual(readingSections([],10),[]);
});
test('out-of-order completion, shared New families, undo and regrouping preserve granular progress',()=>{
 const sentences=[sentence(0,3),sentence(1,2),sentence(2,1)];
 sentences[0].tokens[0].baseId=sentences[1].tokens[0].baseId='shared';
 sentences[1].tokens[1].state='learning';
 const original={id:'text',sentences,textState:'new',readingProgress:0};
 const checked=applyCheckpoint(original,change(100,199));
 assert.equal(checked.readingProgress,2/6);assert.equal(checked.sentences[0].completed,false);assert.equal(checked.sentences[1].completed,true);
 assert.equal(checked.sentences[0].tokens[0].state,'known');assert.equal(checked.sentences[0].tokens[1].state,'new');
 assert.equal(checked.sentences[1].tokens[1].state,'learning');assert.equal(original.sentences[1].completed,false);
 assert.equal(readingSections(checked.sentences,5)[0].completed,false);
 const undone=applyCheckpoint(checked,change(100,199,false));assert.equal(undone.readingProgress,0);assert.equal(undone.sentences[0].tokens[0].state,'known');
 const all=applyCheckpoint(checked,change(0,299));assert.equal(all.textState,'completed');assert.equal(all.readingProgress,1);
 assert.equal(applyCheckpoint(all,change(0,99,false)).textState,'new');
 assert.equal(applyCheckpoint(original,{...change(0,99),textId:'other'}),original);
});
test('tokenless sentences must be checked before reporting 100 percent',()=>{
 assert.equal(readingProgress([sentence(0,3,true),sentence(1,0)]),.75);
 assert.equal(readingProgress([sentence(0,0,true)]),1);assert.equal(readingProgress([]),0);
});

class BrowserStorage{
 values=new Map();quota=false;
 get length(){return this.values.size}
 key(index){return [...this.values.keys()][index]??null}
 getItem(key){return this.values.get(key)??null}
 setItem(key,value){if(this.quota)throw new DOMException('Quota exceeded','QuotaExceededError');this.values.set(key,String(value))}
 removeItem(key){this.values.delete(key)}
}
test('independent operation keys preserve check then undo, other tabs and reload order',()=>{
 const storage=new BrowserStorage(),first=createCheckpointStore(storage),second=createCheckpointStore(storage);
 const a=first.add(change(0,99)),b=second.add(change(100,199)),c=first.add(change(0,99,false));
 const restored=createCheckpointStore(storage);assert.deepEqual(restored.getSnapshot().map(s=>s.id),[a.id,b.id,c.id]);
 assert.deepEqual(restored.getSnapshot().map(s=>s.completed),[true,true,false]);
 first.acknowledge(a.id);second.sync();assert.deepEqual(second.getSnapshot().map(s=>s.id),[b.id,c.id]);
 second.acknowledge(b.id);first.sync();assert.deepEqual(first.getSnapshot().map(s=>s.id),[c.id]);
 first.acknowledge(c.id);assert.equal(createCheckpointStore(storage).getSnapshot().length,0);
});
test('storage failure reports failure without silently accepting a checkpoint',()=>{
 const storage=new BrowserStorage(),store=createCheckpointStore(storage);storage.quota=true;
 assert.throws(()=>store.add(change(0,99)),/Could not save/);assert.deepEqual(store.getSnapshot(),[]);
 assert.throws(()=>createCheckpointStore(null).add(change(0,99)),/Could not save/);
});
test('malformed entries do not affect unrelated local storage',()=>{
 const storage=new BrowserStorage();storage.setItem('other','keep');storage.setItem(checkpointPrefix+'invalid','{');
 storage.setItem(checkpointPrefix+'bad',JSON.stringify({...change(0,99),id:'different',createdAt:0}));
 assert.deepEqual(createCheckpointStore(storage).getSnapshot(),[]);assert.equal(storage.getItem('other'),'keep');
});


test('queued checkpoint batches preserve order, stop at lesson boundaries, and stay bounded',()=>{
 const actions=[{id:'check',textId:'a',completed:true},{id:'undo',textId:'a',completed:false},{id:'other',textId:'b',completed:true},{id:'later',textId:'a',completed:true}];
 assert.deepEqual(nextCheckpointBatch(actions),actions.slice(0,2));assert.deepEqual(nextCheckpointBatch([]),[]);
 assert.equal(nextCheckpointBatch(Array.from({length:70},(_,i)=>({textId:'a',id:String(i)}))).length,50);
});

test('acknowledging one durable batch publishes once and leaves later actions recoverable',()=>{
 const storage=new BrowserStorage(),store=createCheckpointStore(storage);
 const first=store.add(change(0,99)),second=store.add(change(0,99,false)),later=store.add(change(100,199));
 let updates=0;store.subscribe(()=>updates++);store.acknowledge([first.id,second.id]);
 assert.equal(updates,1);assert.deepEqual(createCheckpointStore(storage).getSnapshot().map(item=>item.id),[later.id]);
});
