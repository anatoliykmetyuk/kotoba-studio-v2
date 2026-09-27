import os,json,copy
import pytest
from fastapi.testclient import TestClient
from api.graph import Graph
from api.app import app
from api.schema import SCHEMA

def meaning_fixture(surface,choices=(),form=None):
 from api import domain
 def create(t):
  token={'surface':surface,'reading':surface,'baseReading':surface,'partOfSpeech':'名詞'}
  base=domain.family(t,token,{'base':surface,'baseReading':surface})
  domain.add_meanings(t,base,choices)
  word=domain.word_form(t,base,token|{'surface':form}) if form else base
  return base,word
 return app.state.graph.write('test.word-meaning-fixture',create)

def generated_meaning(body='somewhat sweet'):
 return {'meanings':[{'meaning':body,'sourceType':'local-model','sense':'local-model:qwen3.5:9b-mlx:fixture'}]}

@pytest.fixture(scope='module')
def client():
 if os.getenv('KOTOBA_TEST_DATABASE')!='disposable':pytest.fail('Enable the owned disposable development database')
 assert os.getenv('NEO4J_URI','bolt://127.0.0.1:17687')=='bolt://127.0.0.1:17687'
 graph=Graph()
 with graph.driver.session() as session:session.run('MATCH (n) DETACH DELETE n').consume()
 graph.close();os.environ['KOTOBA_WORKER_TOKEN']='api-test-worker'
 with TestClient(app) as client:yield client

def test_goal_fields_absent_and_settings_validated(client,monkeypatch):
 from api.graph import Tx
 def forbidden(*_):raise AssertionError("Settings creation and updates must not scan the corpus")
 monkeypatch.setattr(Tx,"snapshot",forbidden)
 default=client.get('/api/v1/settings').json()
 assert not any('target' in k.lower() or 'point' in k.lower() for k in default)
 assert client.patch('/api/v1/settings',json={'wordsTarget':100}).status_code==422
 assert client.patch('/api/v1/settings',json={'lineHeight':7}).status_code==422
 assert client.patch('/api/v1/settings',json={'fontSize':22,'lineHeight':1.95}).status_code==200
 saved=client.get('/api/v1/settings').json();assert saved['fontSize']==22 and saved['lineHeight']==1.95

def test_migration_empty_check_cannot_erase_settings(client):
 snapshot=client.get('/api/v1/graph/export').json();report={'id':'report','identityKey':'legacy:report','revision':0,'createdAt':'now','updatedAt':'now','payload':json.dumps({'sourceSha256':'fixture'})}
 clean={'nodes':[n for n in snapshot['nodes'] if 'Schema' in n['labels']]+[{'labels':['Entity','Migration'],'properties':report}],'edges':[]}
 assert client.post('/api/v1/migration/apply',json=clean).status_code==409
 assert client.get('/api/v1/settings').json()['fontSize']==22

def test_agent_dry_run_rollback_and_query_mode(client):
 before=client.get('/api/v1/graph/export').json()
 r=client.post('/api/v1/graph/transaction',json={'statements':[{'query':'MATCH (s:Settings) SET s.payload=$payload RETURN s.id','params':{'payload':'{}'}}],'dryRun':True})
 assert r.status_code==200
 assert client.get('/api/v1/graph/export').json()==before
 assert client.post('/api/v1/graph/query',json={'query':'MATCH (n) DETACH DELETE n'}).status_code==422
 assert client.post('/api/v1/graph/query',json={'query':'RETURN 42 AS answer'}).json()==[{'answer':42}]
 assert client.get('/api/v1/statistics').status_code==200

def test_durable_job_authentication_failure_retry_and_stale_completion(client):
 job=client.post('/api/v1/imports',json={'title':'job fixture','body':'猫。'}).json()['jobId']
 assert client.post('/api/v1/worker/claim').status_code==401
 headers={'Authorization':'Bearer api-test-worker'}
 first=client.post('/api/v1/worker/claim',headers=headers).json()['job'];assert first['id']==job
 assert client.post('/api/v1/worker/'+job+'/complete',headers=headers,json={'attempt':first['attempts'],'error':'fixture transient error'}).status_code==200
 assert client.get('/api/v1/jobs/'+job).json()['state']=='failed'
 assert client.post('/api/v1/jobs/'+job+'/retry').status_code==200
 second=client.post('/api/v1/worker/claim',headers=headers).json()['job'];assert second['attempts']==first['attempts']+1
 assert client.post('/api/v1/worker/'+job+'/complete',headers=headers,json={'attempt':first['attempts'],'error':'stale'}).status_code==409
 assert client.get('/api/v1/jobs/'+job).json()['state']=='running'
 update={'attempt':second['attempts'],'stage':'dictionary','completed':1,'total':3}
 assert client.post('/api/v1/worker/'+job+'/progress',json=update).status_code==401
 assert client.post('/api/v1/worker/'+job+'/progress',headers=headers,json=update|{'attempt':first['attempts']}).status_code==409
 assert client.post('/api/v1/worker/'+job+'/progress',headers=headers,json=update|{'completed':4}).status_code==422
 assert client.post('/api/v1/worker/'+job+'/progress',headers=headers,json=update).status_code==200
 info=client.get('/api/v1/jobs/'+job).json()
 assert info['title']=='job fixture' and info['progress']['completed']==1 and 0<info['progress']['percent']<100
 assert info['progress']['estimatedRemainingSeconds'] is not None
 assert next(j for j in client.get('/api/v1/jobs').json() if j['id']==job)['progress']['completed']==1

 assert client.post('/api/v1/worker/'+job+'/complete',headers=headers,json={'attempt':second['attempts'],'error':'fixture complete'}).status_code==200

def test_native_media_waits_for_synthesis_then_supports_replay_and_ranges(client):
 import base64,io,math,struct,wave
 from concurrent.futures import ThreadPoolExecutor
 headers={'Authorization':'Bearer api-test-worker'}
 payload={'text':'音声試験'}
 job=client.post('/api/v1/speech',json=payload).json()['jobId']
 with ThreadPoolExecutor(max_workers=1) as pool:
  pending=pool.submit(client.get,'/api/v1/speech/play',params=payload,follow_redirects=False)
  claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job'];assert claimed['id']==job
  buffer=io.BytesIO()
  with wave.open(buffer,'wb') as wav:
   wav.setparams((1,2,24000,0,'NONE','not compressed'))
   wav.writeframes(b''.join(struct.pack('<h',int(10000*math.sin(i*.05))) for i in range(7200)))
  assert client.post('/api/v1/worker/'+job+'/complete',headers=headers,json={'attempt':claimed['attempts'],'result':{'audio':base64.b64encode(buffer.getvalue()).decode()}}).status_code==200
  result=pending.result(timeout=10)
 assert result.status_code==307
 media=client.get(result.headers['location']);assert media.content==buffer.getvalue()
 replay=client.get('/api/v1/speech/play',params=payload,follow_redirects=False)
 assert replay.headers['location']==result.headers['location']
 before=client.post('/api/v1/graph/query',json={'query':'MATCH (a:Audit) RETURN count(a) AS count'}).json()
 for _ in range(3):assert client.post('/api/v1/speech',json=payload).json()['cached'] is True
 after=client.post('/api/v1/graph/query',json={'query':'MATCH (a:Audit) RETURN count(a) AS count'}).json()
 assert before==after, 'Cached pronunciation must not write or audit the corpus'

 assert client.post('/api/v1/worker/claim',headers=headers).json()['job'] is None
 partial=client.get(replay.headers['location'],headers={'Range':'bytes=0-43'})
 assert partial.status_code==206 and partial.content==buffer.getvalue()[:44]
 assert client.get('/api/v1/speech/play').status_code==422
 assert client.get('/api/v1/speech/play',params={'text':'test','speed':9}).status_code==422

def test_phrase_tools_are_fresh_private_worker_jobs_without_graph_or_media_writes(client):
 headers={'Authorization':'Bearer api-test-worker'}
 before=client.get('/api/v1/graph/export').json()
 files=set(app.state.media.iterdir())
 requested=[]
 for _ in range(2):
  response=client.post('/api/v1/phrase-tools/translation',json={'text':'この猫','context':'この猫は可愛い。'})
  assert response.status_code==202 and response.headers['cache-control']=='no-store'
  id=response.json()['jobId'];requested.append(id)
  assert client.get('/api/v1/jobs/'+id).json()['state']=='pending'
  claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job']
  assert claimed['id']==id and claimed['payload']=={'text':'この猫','context':'この猫は可愛い。'}
  assert claimed['kind']=='translation'
  assert client.post('/api/v1/worker/'+id+'/heartbeat',json={'attempt':1}).status_code==401
  assert client.post('/api/v1/worker/'+id+'/complete',json={'attempt':1,'result':{'translation':'this cat'}}).status_code==401
  assert client.post('/api/v1/worker/'+id+'/heartbeat',headers=headers,json={'attempt':2}).status_code==409
  assert client.post('/api/v1/worker/'+id+'/heartbeat',headers=headers,json={'attempt':1}).status_code==200
  result=client.post('/api/v1/worker/'+id+'/complete',headers=headers,json={'attempt':1,'result':{'translation':'this cat'}})
  assert result.json()=={'translation':'this cat'}
  ready=client.get('/api/v1/jobs/'+id)
  assert ready.headers['cache-control']=='no-store'
  assert ready.json()['state']=='ready' and ready.json()['result']=={'translation':'this cat'}
  assert client.post('/api/v1/jobs/'+id+'/retry').status_code==409
 assert requested[0]!=requested[1]
 assert client.get('/api/v1/graph/export').json()==before
 assert set(app.state.media.iterdir())==files
 assert client.post('/api/v1/phrase-tools/translation',json={'text':'  '}).status_code==422
 assert client.post('/api/v1/phrase-tools/speech',json={'text':''}).status_code==422
 assert client.post('/api/v1/phrase-tools/speech',json={'text':'猫','voice':'external'}).status_code==422


def phrase_wav():
 import io,wave
 buffer=io.BytesIO()
 with wave.open(buffer,'wb') as wav:
  wav.setparams((1,2,24000,0,'NONE','not compressed'));wav.writeframes(b'\0\0'*2400)
 return buffer.getvalue()


def test_phrase_speech_no_store_ranges_head_and_expiration(client,monkeypatch):
 import base64
 from api.ephemeral import PhraseJobs
 current=[0.0];queue=PhraseJobs(clock=lambda:current[0]);monkeypatch.setattr(app.state,'phrase_jobs',queue)
 headers={'Authorization':'Bearer api-test-worker'}
 before=client.get('/api/v1/graph/export').json();files=set(app.state.media.iterdir())
 id=client.post('/api/v1/phrase-tools/speech',json={'text':'この猫'}).json()['jobId']
 claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job']
 assert claimed['id']==id and claimed['payload']=={'text':'この猫','voice':'jf_alpha','speed':0.9}
 audio=phrase_wav()
 complete=client.post('/api/v1/worker/'+id+'/complete',headers=headers,json={'attempt':1,'result':{'audio':base64.b64encode(audio).decode()}})
 url=complete.json()['url']
 ready=client.get('/api/v1/jobs/'+id).json();assert ready['state']=='ready' and ready['result']['url']==url
 full=client.get(url);assert full.content==audio and full.headers['cache-control']=='no-store'
 assert full.headers['accept-ranges']=='bytes'
 for range_,start,end in [('bytes=0-43',0,43),('bytes=44-',44,len(audio)-1),('bytes=-20',len(audio)-20,len(audio)-1),('bytes=44-999999',44,len(audio)-1)]:
  response=client.get(url,headers={'Range':range_})
  assert response.status_code==206 and response.content==audio[start:end+1]
  assert response.headers['content-range']==f'bytes {start}-{end}/{len(audio)}'
 for range_ in ['bytes=999999-','bytes=44-20','bytes=-0','bytes=not-a-range']:
  response=client.get(url,headers={'Range':range_})
  assert response.status_code==416 and response.headers['content-range']==f'bytes */{len(audio)}'
 assert client.get(url,headers={'Range':'bytes=0-10,20-30'}).content==audio
 assert client.get(url,headers={'Range':'bytes=0-10','If-Range':'"old"'}).content==audio
 head=client.head(url);assert head.status_code==200 and not head.content and head.headers['content-length']==str(len(audio))
 assert client.get('/api/v1/graph/export').json()==before and set(app.state.media.iterdir())==files
 current[0]+=queue.RESULT_SECONDS
 assert client.get(url).status_code==404 and client.get('/api/v1/jobs/'+id).status_code==404
 assert queue.audio_bytes==0


def test_phrase_native_playback_waits_then_redirects_without_caching(client,monkeypatch):
 import base64,time
 from concurrent.futures import ThreadPoolExecutor
 from api.ephemeral import PhraseJobs
 queue=PhraseJobs();monkeypatch.setattr(app.state,'phrase_jobs',queue)
 headers={'Authorization':'Bearer api-test-worker'};audio=phrase_wav();ids=[]
 for nonce in ['first-request','second-request']:
  with ThreadPoolExecutor(max_workers=1) as pool:
   playback=pool.submit(client.get,'/api/v1/phrase-tools/speech/play',params={'text':'この猫','request':nonce},follow_redirects=False)
   deadline=time.monotonic()+5
   while not queue.entries and time.monotonic()<deadline:time.sleep(.01)
   claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job']
   # The second iteration may arrive just after the first poll.
   while claimed is None and time.monotonic()<deadline:
    time.sleep(.01);claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job']
   assert claimed and claimed['kind']=='speech';ids.append(claimed['id'])
   client.post('/api/v1/worker/'+claimed['id']+'/complete',headers=headers,json={'attempt':1,'result':{'audio':base64.b64encode(audio).decode()}})
   response=playback.result(timeout=5)
  assert response.status_code==307 and response.headers['cache-control']=='no-store'
  assert client.get(response.headers['location']).content==audio
 assert ids[0]!=ids[1]
 assert client.get('/api/v1/phrase-tools/speech/play',params={'text':'猫'}).status_code==422


def test_learn_promotes_both_areas_atomically_and_preserves_advanced_states(client,monkeypatch):
 from api import domain
 from api.graph import Tx
 from concurrent.futures import ThreadPoolExecutor
 headers={'Authorization':'Bearer api-test-worker'}
 imported=client.post('/api/v1/imports',json={'title':'Learning fixture','body':'猫を見る。'}).json()
 claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job'];assert claimed['id']==imported['jobId']
 # This is the actual local dictionary importer, with no inference call.
 from worker.main import annotate
 result=client.post('/api/v1/worker/'+claimed['id']+'/complete',headers=headers,json={'attempt':claimed['attempts'],'result':annotate({'body':'猫を見る。'})}).json()
 text=client.get('/api/v1/texts/'+result['textId']).json();token=text['sentences'][0]['tokens'][0];id=token['wordId']
 original_snapshot=Tx.snapshot
 def no_snapshot(*_):raise AssertionError('Learning must not scan or audit the whole graph')
 monkeypatch.setattr(Tx,'snapshot',no_snapshot)
 with ThreadPoolExecutor(max_workers=4) as pool:
  responses=list(pool.map(lambda _:client.post('/api/v1/words/'+id+'/learn'),range(4)))
 assert all(r.status_code==200 for r in responses)
 assert all(r.json()==responses[0].json() for r in responses)
 assert responses[0].json()=={'baseId':token['baseId'],'statuses':{'listening':{'state':'learning','revision':1},'reading':{'state':'learning','revision':1}}}
 for area,state in [('listening','known'),('reading','familiar')]:
  assert client.put('/api/v1/words/'+id+'/status',json={'area':area,'state':state}).status_code==200
 promoted=client.post('/api/v1/words/'+id+'/learn').json()
 assert promoted['statuses']=={'listening':{'state':'known','revision':2},'reading':{'state':'familiar','revision':2}}
 for area in ['listening','reading']:client.put('/api/v1/words/'+id+'/status',json={'area':area,'state':'new'})
 update=Tx.update
 def fail_second(t,node_id,**props):
  node=t.get(node_id)
  if node['type']=='LearningStatus' and node['area']=='reading':raise ValueError('Forced second-area failure')
  return update(t,node_id,**props)
 monkeypatch.setattr(Tx,'update',fail_second)
 assert client.post('/api/v1/words/'+id+'/learn').status_code==422
 statuses=client.get('/api/v1/words/'+id).json()['statuses']
 assert statuses['listening']['state']==statuses['reading']['state']=='new'
 assert statuses['listening']['revision']==statuses['reading']['revision']==3
 monkeypatch.setattr(Tx,'update',update);monkeypatch.setattr(Tx,'snapshot',original_snapshot)


def test_word_meanings_preserve_numeric_dictionary_sense_order(client):
 from api import domain
 word=app.state.graph.read(lambda t:t.run('MATCH (w:Word) WHERE w.family=w.id RETURN properties(w) AS word LIMIT 1'))[0]['word']
 choices=[{'meaning':f'Fixture sense {sense}','sourceType':'JMdict','sense':f'jmdict:999999999:{sense}'} for sense in [10,2,1]]
 app.state.graph.write('test.dictionary-order',lambda t:domain.add_meanings(t,word,choices))
 meanings=client.get('/api/v1/words/'+word['id']).json()['meanings']
 assert [m['sourceKey'] for m in meanings if m['sourceKey'].startswith('jmdict:999999999:')]==['jmdict:999999999:1','jmdict:999999999:2','jmdict:999999999:10']


def test_word_meaning_graph_cache_never_writes_or_queues(client,monkeypatch):
 from api.graph import Tx
 base,form=meaning_fixture('保存済み意味',[{'meaning':'stored meaning','sourceType':'user','sense':'user:stored'}],form='保存済み意味の')
 def forbidden(*_,**__):raise AssertionError('Stored meanings must remain read-only indexed lookups')
 monkeypatch.setattr(app.state.graph,'write',forbidden)
 monkeypatch.setattr(Tx,'snapshot',forbidden)
 for id in [base['id'],form['id']]:
  response=client.post('/api/v1/words/'+id+'/meanings')
  assert response.status_code==200
  assert response.json()['state']=='ready' and response.json()['cached'] is True
  assert [m['body'] for m in response.json()['meanings']]==['stored meaning']
  assert 'jobId' not in response.json()
 assert client.post('/api/v1/words/missing/meanings').status_code==404
 assert client.post('/api/v1/words/'+app.state.graph.read(lambda t:t.find('schema:active'))['id']+'/meanings').status_code==404


def test_word_meaning_concurrency_persistence_and_cached_reads(client,monkeypatch):
 from concurrent.futures import ThreadPoolExecutor
 from api.graph import Tx
 from api import domain
 base,form=meaning_fixture('甘め',form='甘めな')
 headers={'Authorization':'Bearer api-test-worker'}
 with ThreadPoolExecutor(max_workers=6) as pool:
  responses=list(pool.map(lambda id:client.post('/api/v1/words/'+id+'/meanings'),[base['id'],form['id']]*3))
 assert all(r.status_code==202 and r.json()['state']=='pending' for r in responses)
 ids={r.json()['jobId'] for r in responses};assert len(ids)==1
 job_id=ids.pop()
 assert app.state.graph.read(lambda t:t.run('MATCH (j:Job {identityKey:$key}) RETURN count(j) AS count',key='word-meaning:'+base['id']))==[{'count':1}]
 claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job']
 assert claimed['id']==job_id and claimed['kind']=='word-meaning'
 assert claimed['payload']=={'wordId':base['id'],'text':'甘め','reading':'甘め','partOfSpeech':'名詞'}
 result=client.post('/api/v1/worker/'+job_id+'/complete',headers=headers,json={'attempt':claimed['attempts'],'result':generated_meaning()})
 assert result.status_code==200 and result.json()['state']=='ready'
 assert client.get('/api/v1/jobs/'+job_id).json()['state']=='ready'
 meaning=result.json()['meanings'][0]
 assert meaning['sourceType']=='local-model' and 'qwen3.5:9b-mlx' in meaning['sourceKey']
 assert client.get('/api/v1/graph/audit').status_code==200
 fresh=Graph()
 try:assert fresh.read(lambda t:domain.word_meanings(t,base['id']))==result.json()['meanings']
 finally:fresh.close()
 before=client.get('/api/v1/graph/export').json()
 def forbidden(*_,**__):raise AssertionError('Cached meaning must not scan or write the corpus')
 monkeypatch.setattr(app.state.graph,'write',forbidden);monkeypatch.setattr(Tx,'snapshot',forbidden)
 for _ in range(3):
  assert client.post('/api/v1/words/'+base['id']+'/meanings').json()['meanings']==[meaning]
  assert client.get('/api/v1/words/'+base['id']).json()['meanings']==[meaning]
 monkeypatch.undo()
 assert client.get('/api/v1/graph/export').json()==before


def test_word_meaning_failed_jobs_retry_explicitly_and_reject_stale_or_empty_results(client):
 base,_=meaning_fixture('再試行語')
 headers={'Authorization':'Bearer api-test-worker'}
 route='/api/v1/words/'+base['id']+'/meanings'
 job_id=client.post(route).json()['jobId']
 first=client.post('/api/v1/worker/claim',headers=headers).json()['job']
 assert first['id']==job_id
 assert client.post('/api/v1/worker/'+job_id+'/complete',headers=headers,json={'attempt':first['attempts'],'error':'dictionary temporarily unavailable'}).status_code==200
 before=client.get('/api/v1/graph/export').json()
 for _ in range(2):
  result=client.post(route).json()
  assert result['jobId']==job_id and result['state']=='failed' and result['error']=='dictionary temporarily unavailable'
 assert client.get('/api/v1/graph/export').json()==before
 assert client.post('/api/v1/jobs/'+job_id+'/retry').status_code==200
 second=client.post('/api/v1/worker/claim',headers=headers).json()['job']
 assert second['id']==job_id and second['attempts']==first['attempts']+1
 endpoint='/api/v1/worker/'+job_id+'/complete'
 assert client.post(endpoint,headers=headers,json={'attempt':first['attempts'],'result':generated_meaning()}).status_code==409
 assert client.post(endpoint,headers=headers,json={'attempt':second['attempts'],'result':generated_meaning(' ')}).status_code==422
 assert client.get('/api/v1/words/'+base['id']).json()['meanings']==[]
 result=client.post(endpoint,headers=headers,json={'attempt':second['attempts'],'result':{'meanings':[{'meaning':'dictionary meaning','sourceType':'JMdict','sense':'jmdict:123:0'}]}})
 assert result.status_code==200 and result.json()['meanings'][0]['sourceType']=='JMdict'


def test_word_meaning_preserves_meaning_added_while_job_runs(client):
 from api import domain
 base,_=meaning_fixture('並行編集語')
 headers={'Authorization':'Bearer api-test-worker'}
 job_id=client.post('/api/v1/words/'+base['id']+'/meanings').json()['jobId']
 claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job']
 assert claimed['id']==job_id
 app.state.graph.write('test.user-meaning',lambda t:domain.add_meanings(t,base,[{'meaning':'user correction','sourceType':'user','sense':'user:concurrent'}]))
 result=client.post('/api/v1/worker/'+job_id+'/complete',headers=headers,json={'attempt':claimed['attempts'],'result':generated_meaning()})
 assert result.status_code==200 and [m['body'] for m in result.json()['meanings']]==['user correction']
 assert client.get('/api/v1/words/'+base['id']).json()['meanings']==result.json()['meanings']


def test_direct_dictionary_lookup_keeps_retained_family_and_persists_analyzed_lemma(client):
 from api import domain
 base,_=meaning_fixture('涼しめ')
 choice={'base':'涼しい','baseReading':'すずしい','meaning':'cool; refreshing','sourceType':'JMdict','sense':'jmdict:retained:0'}
 # Import propagation still excludes another lemma's gloss from canonical roots.
 app.state.graph.write('test.import-lemma-filter',lambda t:domain.add_meanings(t,base,[choice]))
 assert client.get('/api/v1/words/'+base['id']).json()['meanings']==[]
 before=app.state.graph.read(lambda t:domain.status_nodes(t,base['id']))
 headers={'Authorization':'Bearer api-test-worker'}
 route='/api/v1/words/'+base['id']+'/meanings'
 job_id=client.post(route).json()['jobId']
 job=client.post('/api/v1/worker/claim',headers=headers).json()['job'];assert job['id']==job_id
 result=client.post('/api/v1/worker/'+job_id+'/complete',headers=headers,json={'attempt':job['attempts'],'result':{'meanings':[choice]}})
 assert result.status_code==200 and result.json()['meanings'][0]['body']==choice['meaning']
 assert client.post(route).json()['cached'] is True
 assert app.state.graph.read(lambda t:t.get(base['id']))['family']==base['id']
 assert app.state.graph.read(lambda t:domain.status_nodes(t,base['id']))==before
