"""Snapshot, reconcile and import the legacy corpus without opening the source for writing."""
import argparse,hashlib,json,sqlite3,subprocess,sys,uuid
from collections import Counter,defaultdict
from pathlib import Path
import httpx
from api.graph import digest,packed,uid,now
from api.schema import SCHEMA,validate_graph
from api.language import meanings,sentences,kanji
from api.domain import finalize_import,create_statuses,family,word_form
from api.vocabulary import eligible_tokens,latin_word

PLAN_VERSION=4

class Memory:
 def new_id(self,key):return str(uuid.uuid5(uuid.NAMESPACE_URL,'https://kotoba.local/migration/'+key))
 def __init__(self):self.nodes={};self.keys={};self.edges=set()
 def find(self,key):return self.nodes.get(self.keys.get(key,''))
 def get(self,id):return self.nodes[id]
 def meaning_sources(self,id):
  return [{'sourceType':self.nodes[b]['sourceType'],'sourceKey':self.nodes[b]['sourceKey']} for a,r,b in self.edges if a==id and r=='HAS_MEANING']
 def create(self,concept,key,**props):
  if key in self.keys:return self.find(key)
  p={'id':props.pop('id',self.new_id(key)),'identityKey':key,'revision':0,'createdAt':now(),'updatedAt':now(),**props,'type':concept}
  self.nodes[p['id']]=p;self.keys[key]=p['id'];return p
 def link(self,a,rel,b):self.edges.add((a,rel,b))
 def update(self,id,**props):self.nodes[id].update(props);return self.nodes[id]
 def snapshot(self):return {'nodes':[{'labels':['Entity',p['type']],'properties':{k:v for k,v in p.items() if k!='type'}} for p in self.nodes.values()],'edges':[{'from':a,'type':r,'to':b,'properties':{}} for a,r,b in sorted(self.edges)]}

def states(spelling,state):
 return {'listening':state,'reading':state if state in ('known','familiar') or not kanji(spelling) else 'new'}
def cleaned(row):return {k:v for k,v in row.items() if not k.startswith(('writing_','copilot_'))}
def migrate(source:Path,output:Path,legacy_python:Path):
 output.mkdir(parents=True,exist_ok=True);snapshot=output/'source.sqlite3'
 if not snapshot.exists():
  with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as src,sqlite3.connect(snapshot) as dest:src.backup(dest)
 if (output/'graph.json').exists() and (output/'report.json').exists():
  previous=json.loads((output/'graph.json').read_text());report=json.loads((output/'report.json').read_text())
  if report.get('planVersion')==PLAN_VERSION and report.get('graph',{}).get('schema')==SCHEMA['digest'] and report['sourceSha256']==hashlib.sha256(snapshot.read_bytes()).hexdigest():
   validate_graph(previous);print('Reusing validated migration plan.');return previous,report
 c=sqlite3.connect(snapshot.as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 tables={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
 def rows(name):return [dict(r) for r in c.execute('SELECT * FROM "'+name+'"')] if name in tables else []
 texts=rows('texts');vocab={r['base']:r for r in rows('vocabulary')};folders={r['id']:r for r in rows('folders')}
 proc=subprocess.run([str(legacy_python),str(Path(__file__).resolve().parents[1]/'scripts/legacy_tokens.py')],input=packed([r['body'] for r in texts]),text=True,capture_output=True,check=True)
 token_lists=json.loads(proc.stdout);m=Memory();m.create('Schema','schema:active',digest=SCHEMA['digest'],version=SCHEMA['version'])
 report={'planVersion':PLAN_VERSION,'sourceSha256':hashlib.sha256(snapshot.read_bytes()).hexdigest(),'counts':{n:len(rows(n)) for n in sorted(tables) if n!='sqlite_sequence'},'texts':[],'vocabulary':[],'phrases':[],'excluded':{'attempts':len(rows('attempts')),'writing_activity_credits':len(rows('writing_activity_credits')),'writingJournals':'Not read or imported','audio_cache':{'count':len(rows('audio_cache')),'reason':'No model/dictionary fingerprint in legacy cache; pronunciation is regenerated lazily.'}},'unresolved':[]}
 bases={};text_map={};token_map={}
 def ensure_base(token):
  lemma=token['base']
  if lemma in bases:return bases[lemma]
  old=vocab.get(lemma);choices=meanings(lemma,token['baseReading'])
  meaning=(old['gloss'] if old else '') or (choices[0]['meaning'] if choices else lemma)
  choice={'base':lemma,'baseReading':old['reading'] if old and old['reading'] else token['baseReading'],'meaning':meaning,'sense':'legacy:'+digest(lemma),'sourceType':'legacy'}
  base=family(m,token,choice);bases[lemma]=base
  if old:
   for area,state in states(lemma,old['state']).items():m.update(m.find(f'status:{base["id"]}:{area}')['id'],state=max((state,m.find(f'status:{base["id"]}:{area}')['state']),key=['new','learning','familiar','known'].index),updatedAt=old['updated_at'])
  return base
 for old,tokens in zip(texts,token_lists):
  parsed=sentences(old['body'])
  vocabulary_tokens=eligible_tokens(old['body'],tokens)
  for s in parsed:
   s['tokens']=[]
   for token in vocabulary_tokens:
    if token['start']>=s['start'] and token['end']<=s['end']:
     base=ensure_base(token);s['tokens'].append(token|{'start':token['start']-s['start'],'end':token['end']-s['start'],'selected':{'baseId':base['id']}})
  # Exact v1 token segmentation and saved selectable-token position are preserved.
  payload={'title':old['title'],'body':old['body'],'folder':folders.get(old['folder_id'],{}).get('name','')}
  result=finalize_import(m,payload,{'sentences':parsed});id=result['textId'];text_map[old['id']]=id;token_map[old['id']]=tokens
  count=len(tokens);position=min(max(0,old['reading_position']),count);cursor=tokens[position-1]['end'] if position else 0
  complete=count>0 and old['reading_position']>=count
  m.update(id,cursor=len(old['body']) if complete else cursor,textState='completed' if complete else 'new',createdAt=old['created_at'],updatedAt=old['updated_at'])
  detail={'legacyId':old['id'],'textId':id,'originalPosition':old['reading_position'],'selectableTokens':count,'statusInferred':'completed' if complete else 'new','completedAt':None}
  report['texts'].append(detail)
  p=m.create('Provenance',f'legacy:text:{old["id"]}',details=packed(detail));src=m.create('Source','source:legacy-sqlite',url='urn:kotoba:v1:sqlite:'+report['sourceSha256'],sourceType='legacy-sqlite');m.link(p['id'],'SOURCE',src['id']);m.link(id,'PROVENANCE',p['id'])
  translations=json.loads(old.get('sentence_translations','[]'))
  for i,tr in enumerate(translations):
   # Preserve authored payload even if its old alignment cannot be established.
   if isinstance(tr,dict):body=tr.get('source') or tr.get('text') or tr.get('sentence') or '';meaning=tr.get('translation') or tr.get('meaning') or ''
   else:body='';meaning=str(tr)
   item=m.create('Translation','legacy:translation:'+digest(packed(tr)),body=body,meaning=meaning);m.link(id,'TRANSLATION',item['id'])
 for lemma,old in vocab.items():
  if latin_word(lemma):continue
  base=ensure_base({'base':lemma,'surface':lemma,'reading':old['reading'],'baseReading':old['reading'],'partOfSpeech':'legacy'})
  report['vocabulary'].append({'legacyBase':lemma,'baseId':base['id'],'states':states(lemma,old['state']),'evidence':'one legacy corpus meaning for this lemma'})
 for old in rows('phrase_vocabulary'):
  if any(member['kind']=='word' and latin_word(member['surface']) for member in json.loads(old['members_json'])):
   report['excluded'].setdefault('latinPhrases',[]).append(old['id']);continue
  member_ids=[]
  for member in json.loads(old['members_json']):
   if member['kind']!='word':continue
   token={'base':member['base'],'baseReading':member['reading'],'reading':member['reading'],'surface':member['surface'],'partOfSpeech':'legacy'}
   base=ensure_base(token);member_ids.append(word_form(m,base,token)['id'])
  p=m.create('Phrase','phrase:'+digest(packed(member_ids)+old['gloss']),surface=old['surface'],meaning=old['gloss'],createdAt=old['created_at'],updatedAt=old['updated_at']);create_statuses(m,p['id'],states(old['surface'],old['state']))
  for ordinal,word in enumerate(member_ids):
   member=m.create('PhraseMember',f'phrase-member:{p["id"]}:{ordinal}',ordinal=ordinal);m.link(p['id'],'PHRASE_MEMBER',member['id']);m.link(member['id'],'MEMBER_WORD',word)
  if old['lesson_id'] in text_map:m.link(text_map[old['lesson_id']],'PHRASE',p['id'])
  report['phrases'].append({'legacyId':old['id'],'phraseId':p['id'],'portable':old['lesson_id'] is None})
 for old in rows('folders'):m.create('Folder','folder:'+old['name'].casefold(),name=old['name'],createdAt=old['created_at'],updatedAt=old['updated_at'])
 daily={r['id']:cleaned(r) for r in rows('daily_activity')}
 for old in rows('activity_events'):
  context=json.loads(old['context_json']);day=daily[old['daily_activity_id']]['day'];kind={'matching_pair':'matching','sentence_rebuild':'sentence'}.get(old['activity'],old['activity'])
  amount=max(0,context.get('toPosition',0)-context.get('fromPosition',0)) if kind=='reading' else 1
  m.create('Activity','legacy:event:'+old['event_id'],day=day,kind=kind,amount=amount,details=packed({'legacyEventId':old['event_id'],'context':context}),createdAt=old['created_at'],updatedAt=old['created_at'])
 settings=cleaned(rows('reader_settings')[0]) if rows('reader_settings') else {}
 settings={'theme':'system','fontSize':20,'lineHeight':1.85,'readerLayout':'book','furigana':bool(settings.get('furigana_learning',1)),'area':'reading','legacy':{'reader':settings,'app':rows('app_state')}}
 m.create('Settings','settings:user',payload=packed(settings))
 report['excluded']['dailyGoalSystem']={'tables':['activity_settings','daily_activity','activity_metadata','vocabulary_activity_credits','practice_activity_credits'],'reason':'No goals, daily targets, points, streaks, or goal-completion history are migrated.'}
 report['excluded']['latinVocabulary']=[lemma for lemma in vocab if latin_word(lemma)]
 m.create('Migration','legacy:report',payload=packed(report))
 snap=m.snapshot();report['graph']=validate_graph(snap)
 (output/'graph.json').write_text(packed(snap));(output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print(json.dumps({'snapshot':str(snapshot),'graph':report['graph'],'texts':len(texts),'vocabulary':len(vocab),'phrases':len(report['phrases']),'unresolved':report['unresolved']},ensure_ascii=False))
 return snap,report

def main():
 p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--legacy-python',type=Path,required=True);p.add_argument('--apply-url');a=p.parse_args()
 snap,report=migrate(a.source.resolve(),a.output.resolve(),a.legacy_python)
 if a.apply_url:
  with httpx.Client(timeout=300) as c:
   url=a.apply_url.rstrip('/')+'/api/v1';existing=c.post(url+'/graph/query',json={'query':'MATCH (m:Migration {identityKey:"legacy:report"}) RETURN m.payload AS payload'});existing.raise_for_status()
   if existing.json():
    old=json.loads(existing.json()[0]['payload'])
    if old['sourceSha256']!=report['sourceSha256']:raise SystemExit('Another legacy snapshot is already migrated. Reconcile it before applying a new snapshot.')
    print('Already migrated. Later changes preserved.');return
   r=c.post(url+'/migration/apply',json=snap);r.raise_for_status();print(r.text)
if __name__=='__main__':main()
