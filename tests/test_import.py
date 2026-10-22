import os,copy,json
import pytest
from datetime import datetime,timedelta,timezone
from api.language import tokenize
from api.jobs import view,progress

def test_import_never_invokes_models_and_preserves_dictionary_alternatives(monkeypatch):
 monkeypatch.setenv('KOTOBA_WORKER_TOKEN','test')
 from worker import main
 monkeypatch.setattr(main,'generate',lambda *a,**k:(_ for _ in ()).throw(AssertionError('Model called during import')))
 monkeypatch.setattr(main.CLIENT,'get',lambda *a,**k:(_ for _ in ()).throw(AssertionError('External lookup during import')))
 reports=[];body='猫は食べた。\n猫は食べた。\n未知語XYZ。'
 result=main.annotate({'body':body},lambda *p:reports.append(p))
 assert len(result['sentences'])==3 and reports[-1]==('saving',3,3)
 assert all('meanings' in w and 'choices' not in w for s in result['sentences'] for w in s['tokens'])
 assert len(next(w for w in result['sentences'][0]['tokens'] if w['surface']=='食べた')['meanings'])>1
 for s in result['sentences']:
  for w in s['tokens']:assert s['body'][w['start']:w['end']]==w['surface']
 particle=next(w for w in result['sentences'][0]['tokens'] if w['surface']=='は')
 assert particle['meanings'] and all('prt' in m['partOfSpeech'].split(',') for m in particle['meanings'])

def test_progress_estimate_ready_and_stalled():
 start=(datetime.now(timezone.utc)-timedelta(seconds=10)).isoformat()
 p=progress('dictionary',5,10,start)
 j={'id':'j','kind':'import','payload':'{"title":"sample"}','jobState':'running','result':json.dumps({'_progress':p}),'error':'','attempts':1,'createdAt':start,'updatedAt':p['updatedAt'],'lease':''}
 live=view(j);assert 0<live['progress']['percent']<100 and live['progress']['estimatedRemainingSeconds']>0
 j['jobState']='ready';assert view(j)['progress']['percent']==100 and view(j)['progress']['estimatedRemainingSeconds']==0
 assert view(j)['progress']['completed']==view(j)['progress']['total']==10
 j['jobState']='running';p['updatedAt']=(datetime.now(timezone.utc)-timedelta(seconds=40)).isoformat()
 assert view(j,p)['progress']['stalled'] and view(j,p)['progress']['estimatedRemainingSeconds'] is None


@pytest.mark.parametrize('surface', ['行った', '行う'])
def test_import_attaches_alternative_meanings_only_to_their_canonical_base(surface):
 from api.domain import finalize_import
 from api.schema import SCHEMA,validate_graph
 from cli.migrate import Memory
 m=Memory();m.create('Schema','schema:active',digest=SCHEMA['digest'],version=SCHEMA['version'])
 choices=[{'base':'行う','baseReading':'おこなう','meaning':'to perform','sourceType':'JMdict','sense':'jmdict:1589060:0'},
          {'base':'行く','baseReading':'いく','meaning':'to go','sourceType':'JMdict','sense':'jmdict:1578850:0'}]
 token={'surface':surface,'baseReading':'おこなう','reading':'おこなった','partOfSpeech':'verb','start':0,'end':len(surface),
        'selected':{'base':'行う','baseReading':'おこなう'},'meanings':choices}
 finalize_import(m,{'title':'Alternative meanings','body':surface},
                 {'sentences':[{'body':surface,'start':0,'end':len(surface),'tokens':[token]}]})
 validate_graph(m.snapshot())
 words={n['surface']:n for n in m.nodes.values() if n['type']=='Word'}
 def attached(spelling):
  return {(m.nodes[b]['body'],m.nodes[b]['reading']) for a,r,b in m.edges if a==words[spelling]['id'] and r=='HAS_MEANING'}
 assert attached('行う')=={('to perform','おこなう')}
 if surface!='行う':assert attached(surface)=={('to perform','おこなう'),('to go','いく')}

def test_spelling_migration_unions_families_preserves_meanings_and_statuses():
 from cli.migrate import Memory
 from cli.spelling_identity import migrate
 from api.domain import create_statuses
 from api.schema import SCHEMA,validate_graph
 m=Memory();m.create('Schema','schema:active',digest=SCHEMA['digest'],version=SCHEMA['version'])
 for id,surface,base,gloss in [('a','行く','a','go'),('b','逝く','b','die'),('c','いった','a','went'),('d','いった','b','passed away')]:
  m.create('Word','old:'+id,id=id,surface=surface,reading='いく',meaning=gloss,partOfSpeech='動詞',family=base);m.link(id,'BASE_FORM',base)
 for owner,states in [('a',{'reading':'known','listening':'new'}),('b',{'reading':'new','listening':'familiar'})]:
  for area,state in states.items():
   status=m.create('LearningStatus',f'status:{owner}:{area}',area=area,state=state);m.link(owner,'STATUS',status['id'])
 before=m.snapshot();after,report=migrate(before)
 from cli.learning_status import migrate as unify
 after,_=unify(after)
 assert report['mergedWords']==1 and validate_graph(after)['valid']
 assert len([n for n in after['nodes'] if 'Word' in n['labels']])==3
 assert {n['properties']['body'] for n in after['nodes'] if 'Meaning' in n['labels']}=={'go','die','went','passed away'}
 statuses=[n['properties'] for n in after['nodes'] if 'LearningStatus' in n['labels']]
 assert len(statuses)==1 and statuses[0]['state']=='familiar'
 assert migrate(after)[0]==after
 assert before==m.snapshot()

@pytest.mark.parametrize('title', ['', '  \t', None])
def test_import_contract_allows_missing_title(title):
 from api.app import Import
 payload={'body':'猫が眠る。'}
 if title is not None:payload['title']=title
 assert Import(**payload).title==(title or '')

@pytest.mark.parametrize('supplied', ['', ' \t', 'Provided title'])
def test_worker_generates_only_missing_title(monkeypatch,supplied):
 monkeypatch.setenv('KOTOBA_WORKER_TOKEN','test')
 from worker import main
 calls=[];stages=[]
 def generate(system,payload,schema):
  calls.append(payload)
  assert schema['properties']['title']['maxLength']==30
  return {'title':'  猫の日常  '}
 class Response:
  def raise_for_status(self):pass
 monkeypatch.setattr(main,'generate',generate)
 monkeypatch.setattr(main.CLIENT,'post',lambda url,**kw:(stages.append(kw['json']['stage']) or Response()))
 monkeypatch.setattr(main,'annotate',lambda p,report:{'sentences':[]})
 result=main.perform({'id':'j','kind':'import','attempts':1,'payload':{'body':'猫'*7000,'title':supplied}})
 assert result['title']==(supplied if supplied.strip() else '猫の日常')
 assert calls==([] if supplied.strip() else [{'text':'猫'*6000}])
 assert stages==([] if supplied.strip() else ['title'])

@pytest.mark.parametrize('value',[None,42,'','   ','長'*31,'猫\n犬'])
def test_generated_title_rejected_before_saving(value):
 from api.domain import finalize_import
 from cli.migrate import Memory
 m=Memory();before=m.snapshot()
 with pytest.raises(ValueError,match='generated lesson title'):
  finalize_import(m,{'title':'','body':'猫'},{'title':value,'sentences':[]})
 assert m.snapshot()==before

def test_generated_title_saved_and_duplicate_keeps_original(monkeypatch):
 from api.domain import finalize_import,prepare_import
 from cli.migrate import Memory
 from api.schema import SCHEMA,validate_graph
 monkeypatch.setattr('api.domain.folders',lambda t:[])
 m=Memory();m.create('Schema','schema:active',digest=SCHEMA['digest'],version=SCHEMA['version'])
 payload={'body':'猫','sourceUrl':'https://example.com/title-fixture'}
 accepted=prepare_import(m,payload)
 assert json.loads(m.get(accepted['jobId'])['payload'])['title']==''
 first=finalize_import(m,payload,{'title':'猫の日常','sentences':[]})
 assert m.get(first['textId'])['title']=='猫の日常'
 second=prepare_import(m,payload|{'title':'Another title'})
 assert second=={'textId':first['textId'],'duplicate':True}
 assert m.get(first['textId'])['title']=='猫の日常'
 validate_graph(m.snapshot())
