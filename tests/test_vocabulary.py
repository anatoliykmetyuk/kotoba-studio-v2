import copy
import json
import os

import pytest

from api.domain import create_statuses, finalize_import
from api.graph import digest, packed
from api.schema import SCHEMA, validate_graph
from api.vocabulary import eligible_tokens, latin_spans, latin_word
from api.vocabulary_cleanup import fingerprint, plan
from cli.migrate import Memory


def memory():
    m=Memory();m.create('Schema','schema:active',digest=SCHEMA['digest'],version=SCHEMA['version'])
    return m


def word(m,surface,base=None):
    key='word:'+digest(surface);id=m.new_id(key)
    w=m.create('Word',key,id=id,surface=surface,reading=surface,partOfSpeech='fixture',family=base or id)
    m.link(id,'BASE_FORM',base or id)
    if base is None:create_statuses(m,id,{'reading':'known','listening':'familiar'})
    return w


def old_corpus():
    m=memory()
    root=word(m,'cat');japanese=word(m,'猫',root['id']);dog=word(m,'犬')
    english=word(m,'Let');letters=word(m,'ABX');number=word(m,'48');z=word(m,'Z');unused_number=word(m,'99')
    body='Let 猫 ABX48 Z99。48 犬。'
    text=m.create('Text','text:'+digest(body),title='Mixed fixture',body=body,textState='completed',cursor=len(body),archived=False)
    removed_occurrence=None
    for ordinal,(sentence_body,start,parts) in enumerate([
        ('Let 猫 ABX48 Z99。',0,[english,japanese,letters,number,z,unused_number]),
        ('48 犬。',len('Let 猫 ABX48 Z99。'),[number,dog])]):
        sentence=m.create('Sentence','sentence:'+digest(sentence_body),body=sentence_body)
        placement=m.create('SentenceOccurrence',f'placement:{text["id"]}:{ordinal}',ordinal=ordinal,start=start,end=start+len(sentence_body))
        m.link(text['id'],'PLACEMENT',placement['id']);m.link(placement['id'],'SENTENCE',sentence['id'])
        cursor=0
        for i,w in enumerate(parts):
            offset=sentence_body.index(w['surface'],cursor);cursor=offset+len(w['surface'])
            occurrence=m.create('WordOccurrence',f'occurrence:{placement["id"]}:{i}',ordinal=i,start=offset,end=cursor,reading=w['reading'])
            m.link(placement['id'],'TOKEN',occurrence['id']);m.link(occurrence['id'],'WORD',w['id'])
            if w['id']==english['id']:removed_occurrence=occurrence
    meaning=m.create('Meaning','meaning:shared',body='cat',reading='ねこ',partOfSpeech='noun',sourceType='user',sourceKey='shared')
    m.link(root['id'],'HAS_MEANING',meaning['id'])
    orphan=m.create('Meaning','meaning:orphan',body='let',reading='',partOfSpeech='verb',sourceType='user',sourceKey='orphan')
    m.link(english['id'],'HAS_MEANING',orphan['id'])
    encounter=m.create('Encounter','encounter:latin',area='reading',evidence='fixture');m.link(encounter['id'],'OCCURRED_IN',removed_occurrence['id'])
    speech=m.create('Speech','speech:latin',pronunciation='Let',voice='jf_alpha',speed=.9,engine='fixture',asset='fixture.wav',jobState='ready')
    m.link(removed_occurrence['id'],'PRONUNCIATION',speech['id'])
    m.create('Job','speech-job:latin',kind='speech',payload=packed({'speechId':speech['id']}),result='{}',error='',jobState='ready',lease='',attempts=1)
    for name,members in [('mixed',[english,japanese]),('japanese',[japanese,dog])]:
        phrase=m.create('Phrase','phrase:'+name,surface=name,meaning=name);create_statuses(m,phrase['id'])
        m.link(text['id'],'PHRASE',phrase['id'])
        for i,w in enumerate(members):
            member=m.create('PhraseMember',f'member:{name}:{i}',ordinal=i);m.link(phrase['id'],'PHRASE_MEMBER',member['id']);m.link(member['id'],'MEMBER_WORD',w['id'])
    validate_graph(m.snapshot())
    return m.snapshot()


def test_latin_runs_and_tokenization_preserve_japanese_and_offsets(monkeypatch):
    from api import language
    body="😀Sam’s mug! ABX48 ＡＢＸ４８ café café Tシャツ 3Dプリンター 猫 １２３"
    assert [body[a:b] for a,b in latin_spans(body)]==['Sam’s','mug','ABX48','ＡＢＸ４８','café','café','T','3D']
    assert latin_word('ACME・Corp') and not latin_word('クッキー・cookie')
    assert latin_word('ＡＢＸ４８') and latin_word('café') and not latin_word('Tシャツ')
    assert not latin_word('クッキー-cookie') and not latin_word('１２３')
    language.ichiran.analyze.cache_clear()
    old=language.ichiran._request
    def request(path,text):
        assert not list(latin_spans(text)), 'Latin runs must be excluded before dictionary analysis'
        return old(path,text)
    monkeypatch.setattr(language.ichiran,'_request',request)
    tokens=language.tokenize(body)
    assert {'シャツ','プリンター','猫'} <= {t['surface'] for t in tokens}
    # Standalone digits are upstream Ichiran nonword text, retained in the body.
    assert '１２３' not in {t['surface'] for t in tokens}
    assert not {'Let','s','go','ABX','48','ＡＫＢ','４８','café','3','D'} & {t['surface'] for t in tokens}
    assert all(body[t['start']:t['end']]==t['surface'] for t in tokens)
    assert eligible_tokens('Tシャツ',[{'surface':'Tシャツ','start':0,'end':4}])


def test_finalize_defends_worker_bypass_and_latin_base_without_changing_body():
    m=memory();body='Sam’s mug! 猫 ABX48 48'
    tokens=[]
    for surface in ['Sam','s','mug','猫','ABX','48','48']:
        start=body.index(surface,tokens[-1]['end'] if tokens else 0)
        tokens.append({'surface':surface,'start':start,'end':start+len(surface),'reading':'ねこ','baseReading':'ねこ','partOfSpeech':'noun','selected':{'base':'cat'}})
    result=finalize_import(m,{'body':body,'title':'Body fixture'},{'sentences':[{'body':body,'start':0,'end':len(body),'tokens':tokens}]})
    snapshot=m.snapshot();validate_graph(snapshot)
    assert m.get(result['textId'])['body']==body
    assert sorted(n['properties']['surface'] for n in snapshot['nodes'] if 'Word' in n['labels'])==['48','猫']
    occurrences=[n['properties'] for n in snapshot['nodes'] if 'WordOccurrence' in n['labels']]
    assert [o['ordinal'] for o in occurrences]==[0,1]
    assert [body[o['start']:o['end']] for o in occurrences]==['猫','48']


def test_cleanup_preserves_source_family_status_meaning_and_numeric_usage():
    before=old_corpus();original=copy.deepcopy(before);after,report=plan(before)
    assert before==original and validate_graph(after)['valid']
    assert report['removed']=={'Encounter':1,'Job':1,'LearningStatus':10,'Meaning':1,'Phrase':1,'PhraseMember':2,'Speech':1,'Word':5,'WordOccurrence':5}
    assert report['remainingLatinWords']==0 and len(report['preservedFamilies'])==1
    props={n['properties']['id']:n['properties'] for n in after['nodes']}
    surviving={n['properties']['surface']:n['properties'] for n in after['nodes'] if 'Word' in n['labels']}
    assert set(surviving)=={'猫','犬','48'} and surviving['猫']['family']==surviving['猫']['id']
    statuses=[props[e['to']] for e in after['edges'] if e['type']=='STATUS' and e['from']==surviving['猫']['id']]
    assert {s['area']:s['state'] for s in statuses}=={'reading':'known','listening':'familiar'}
    assert any(e['type']=='HAS_MEANING' and e['from']==surviving['猫']['id'] for e in after['edges'])
    for n in original['nodes']:
        if set(n['labels']) & {'Text','Sentence'}:assert props[n['properties']['id']]==n['properties']
    assert plan(after)[1]['removed']=={} and plan(after)[0]==after
    operational=copy.deepcopy(before)
    next(n for n in operational['nodes'] if 'Schema' in n['labels'])['properties']['revision']+=2
    assert fingerprint(before)==fingerprint(operational)


@pytest.fixture(scope='module')
def cleanup_client():
    from fastapi.testclient import TestClient
    from api.app import app
    from api.graph import Graph
    if os.getenv('KOTOBA_TEST_DATABASE')!='disposable':pytest.fail('Enable the owned disposable development database')
    assert os.getenv('NEO4J_URI','bolt://127.0.0.1:17687')=='bolt://127.0.0.1:17687'
    graph=Graph()
    with graph.driver.session() as session:session.run('MATCH (n) DETACH DELETE n').consume()
    graph.close();os.environ['KOTOBA_WORKER_TOKEN']='vocabulary-test-worker'
    with TestClient(app) as client:yield client


def test_cleanup_api_dry_run_stale_plan_atomic_apply_and_repeat(cleanup_client):
    client=cleanup_client
    assert client.post('/api/v1/graph/restore',json=old_corpus()).status_code==200
    before=client.get('/api/v1/graph/export').json()
    response=client.post('/api/v1/maintenance/exclude-latin-vocabulary',json={})
    assert response.status_code==200,response.text
    report=response.json()
    assert client.get('/api/v1/graph/export').json()==before
    assert client.post('/api/v1/maintenance/exclude-latin-vocabulary',json={'dryRun':False}).status_code==422
    assert client.post('/api/v1/maintenance/exclude-latin-vocabulary',json={'dryRun':False,'expectedFingerprint':'0'*64}).status_code==409
    assert client.get('/api/v1/graph/export').json()==before
    response=client.post('/api/v1/maintenance/exclude-latin-vocabulary',json={'dryRun':False,'expectedFingerprint':report['fingerprint']})
    assert response.status_code==200,response.text
    assert response.json()['removed']==report['removed']
    assert client.get('/api/v1/graph/audit').json()['valid']
    assert client.post('/api/v1/maintenance/exclude-latin-vocabulary',json={}).json()['removed']=={}


def test_import_api_ignores_latin_worker_result(cleanup_client):
    client=cleanup_client;body='Sam’s mug! カタカナ ABX48'
    job=client.post('/api/v1/imports',json={'body':body,'title':'Worker boundary'}).json()['jobId']
    headers={'Authorization':'Bearer vocabulary-test-worker'}
    claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job'];assert claimed['id']==job
    tokens=[]
    for surface in ['Sam','s','mug','カタカナ','ABX','48']:
        start=body.index(surface,tokens[-1]['end'] if tokens else 0)
        tokens.append({'surface':surface,'start':start,'end':start+len(surface),'reading':'かたかな','baseReading':'かたかな','partOfSpeech':'noun','selected':{'base':surface}})
    response=client.post('/api/v1/worker/'+job+'/complete',headers=headers,json={'attempt':claimed['attempts'],'result':{'sentences':[{'body':body,'start':0,'end':len(body),'tokens':tokens}]}})
    assert response.status_code==200,response.text
    result=client.get('/api/v1/jobs/'+job).json();assert result['state']=='ready'
    detail=client.get('/api/v1/texts/'+result['result']['textId']).json()
    assert detail['body']==body and detail['sentences'][0]['body']==body
    assert [t['surface'] for t in detail['sentences'][0]['tokens']]==['カタカナ']


def test_meaning_correction_can_target_base_and_preserves_default_occurrence_owner(cleanup_client):
    client=cleanup_client;body='学び'
    job=client.post('/api/v1/imports',json={'body':body,'title':'Base meaning fixture'}).json()['jobId']
    headers={'Authorization':'Bearer vocabulary-test-worker'}
    claimed=client.post('/api/v1/worker/claim',headers=headers).json()['job'];assert claimed['id']==job
    token={'surface':body,'start':0,'end':len(body),'reading':'まなび','baseReading':'まなぶ','partOfSpeech':'verb','selected':{'base':'学ぶ'}}
    response=client.post('/api/v1/worker/'+job+'/complete',headers=headers,json={'attempt':claimed['attempts'],'result':{'sentences':[{'body':body,'start':0,'end':len(body),'tokens':[token]}]}})
    assert response.status_code==200,response.text
    text_id=client.get('/api/v1/jobs/'+job).json()['result']['textId']
    token=client.get('/api/v1/texts/'+text_id).json()['sentences'][0]['tokens'][0]
    assert token['baseId']!=token['wordId']
    result=client.post('/api/v1/occurrences/'+token['id']+'/meaning',json={'meaning':'to study the base','baseForm':True}).json()
    assert result=={'wordId':token['baseId'],'baseId':token['baseId']}
    base=client.get('/api/v1/words/'+token['baseId']).json()
    assert any(m['body']=='to study the base' and m['reading']=='まなぶ' for m in base['meanings'])
    result=client.post('/api/v1/occurrences/'+token['id']+'/meaning',json={'meaning':'surface-specific note'}).json()
    assert result=={'wordId':token['wordId'],'baseId':token['baseId']}
    base=client.get('/api/v1/words/'+token['baseId']).json()
    assert not any(m['body']=='surface-specific note' for m in base['meanings'])
