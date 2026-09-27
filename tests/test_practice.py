"""Lesson practice exercises the real API and owned disposable graph, without resets."""
import json
import os
from tempfile import TemporaryDirectory
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from api.app import app


@pytest.fixture(scope='module')
def client():
    if os.getenv('KOTOBA_TEST_DATABASE')!='disposable':pytest.fail('Enable the owned disposable development database')
    assert os.getenv('NEO4J_URI','bolt://127.0.0.1:17687')=='bolt://127.0.0.1:17687'
    previous={key:os.environ.get(key) for key in ('KOTOBA_WORKER_TOKEN','KOTOBA_MEDIA_DIR')}
    with TemporaryDirectory(prefix='kotoba-practice-') as media:
        os.environ.update(KOTOBA_WORKER_TOKEN='practice-test-worker',KOTOBA_MEDIA_DIR=media)
        try:
            with TestClient(app) as result:yield result
        finally:
            for key,value in previous.items():
                if value is None:os.environ.pop(key,None)
                else:os.environ[key]=value


def import_lesson(client,title,lines,*,meanings=None):
    """Submit deterministic tokenizer fixtures through the actual worker boundary."""
    sentences=[];start=0
    for words in lines:
        body=''.join(w[0] for w in words)+'。';tokens=[];position=0
        for surface,reading,meaning,*base in words:
            canonical=base[0] if base else surface
            tokens.append({'surface':surface,'reading':reading,'baseReading':reading,'partOfSpeech':'名詞',
                           'start':position,'end':position+len(surface),
                           'selected':{'base':canonical,'baseReading':reading,'meaning':meaning}})
            if meanings is not None:tokens[-1]['meanings']=meanings.get(surface,[])
            position+=len(surface)
        sentences.append({'body':body,'start':start,'end':start+len(body),'tokens':tokens});start+=len(body)
    submitted=client.post('/api/v1/imports',json={'title':title,'body':''.join(s['body'] for s in sentences)})
    assert submitted.status_code==202,submitted.text
    response=submitted.json()
    if response.get('textId'):id=response['textId']
    else:
        headers={'Authorization':'Bearer practice-test-worker'}
        job=client.post('/api/v1/worker/claim',headers=headers).json()['job']
        assert job and job['id']==response['jobId'],'Another worker job needs its owner before this additive test can run'
        completed=client.post('/api/v1/worker/'+job['id']+'/complete',headers=headers,
                              json={'attempt':job['attempts'],'result':{'sentences':sentences}})
        assert completed.status_code==200,completed.text
        id=completed.json()['textId']
    return client.get('/api/v1/texts/'+id).json()


@pytest.fixture(scope='module')
def lessons(client):
    a=import_lesson(client,'Lesson practice A',[
        [('猫','ねこ','cat'),('魚','さかな','fish')],
        [('鳥','とり','bird'),('亀','かめ','turtle')],
        [('見た','みた','to see','見る'),('猫','ねこ','cat')]])
    b=import_lesson(client,'Lesson practice B',[
        [('犬','いぬ','dog'),('馬','うま','horse')],
        [('牛','うし','cow'),('犬','いぬ','dog')]])
    for text in (a,b):
        for id in {w['baseId'] for s in text['sentences'] for w in s['tokens']}:
            for area in ('reading','listening'):
                assert client.put('/api/v1/words/'+id+'/status',json={'area':area,'state':'new'}).status_code==200
    return a,b


def practice(client,text,**params):
    response=client.get('/api/v1/practice',params={'textId':text['id'],'states':'new,learning,familiar,known',**params})
    assert response.status_code==200,response.text
    return response.json()


def test_requires_valid_lesson_and_filters(client,lessons):
    a,_=lessons
    assert client.get('/api/v1/practice').status_code==422
    assert client.get('/api/v1/practice',params={'textId':''}).status_code==422
    assert client.get('/api/v1/practice',params={'textId':'missing'}).status_code==404
    assert client.get('/api/v1/practice',params={'textId':a['sentences'][0]['sentenceId']}).status_code==404
    assert client.get('/api/v1/practice',params={'textId':a['id'],'area':'unknown'}).status_code==422
    for states in ('','learning,invalid'):
        assert client.get('/api/v1/practice',params={'textId':a['id'],'states':states}).status_code==422
    assert client.post('/api/v1/practice/answer',json={'kind':'sentence','targetId':a['sentences'][0]['sentenceId'],
                                                     'answer':a['sentences'][0]['body'],'eventId':str(uuid4())}).status_code==422


def test_candidates_distractors_and_statuses_stay_in_lesson(client,lessons,monkeypatch):
    from api import domain
    from api.graph import Tx
    a,b=lessons
    def forbidden(*_,**__):raise AssertionError('Practice must query its lesson, never materialize the corpus')
    monkeypatch.setattr(domain,'explore',forbidden);monkeypatch.setattr(Tx,'snapshot',forbidden)
    pool=practice(client,a);other=practice(client,b)
    assert {w['baseId'] for w in pool['words']}=={w['baseId'] for s in a['sentences'] for w in s['tokens']}
    assert {w['baseId'] for w in pool['words']}.isdisjoint(w['baseId'] for w in other['words'])
    assert {s['textId'] for s in pool['sentences']}=={a['id']}
    assert {s['occurrenceId'] for s in pool['sentences']}=={s['id'] for s in a['sentences']}
    assert client.get('/api/v1/practice',params={'textId':a['id']}).json()==pool
    cat=a['sentences'][0]['tokens'][0];fish=a['sentences'][0]['tokens'][1]
    for token,area,state in ((cat,'reading','learning'),(fish,'listening','familiar')):
        assert client.put('/api/v1/words/'+token['baseId']+'/status',json={'area':area,'state':state}).status_code==200
    reading=practice(client,a,states='learning,familiar');listening=practice(client,a,area='listening',states='learning,familiar')
    assert {w['baseId'] for w in reading['words']}=={cat['baseId']}
    assert {s['occurrenceId'] for s in reading['sentences']}=={a['sentences'][0]['id'],a['sentences'][2]['id']}
    assert {w['baseId'] for w in listening['words']}=={fish['baseId']}
    assert {s['occurrenceId'] for s in listening['sentences']}=={a['sentences'][0]['id']}
    assert len(listening['sentences'][0]['words'])==2,'Reconstruction keeps all tokens in an eligible sentence'


def test_both_answers_reject_foreign_targets_and_record_lesson(client,lessons):
    a,b=lessons;local=practice(client,a);foreign=practice(client,b)
    for kind,target,answer in [('matching',foreign['words'][0]['baseId'],foreign['words'][0]['meaning']),
                               ('sentence',b['sentences'][0]['sentenceId'],b['sentences'][0]['body'])]:
        rejected=client.post('/api/v1/practice/answer',json={'textId':a['id'],'kind':kind,'targetId':target,'answer':answer,'eventId':str(uuid4())})
        assert rejected.status_code==404,rejected.text
    for kind,target,answer in [('matching',local['words'][0]['baseId'],local['words'][0]['meaning']),
                               ('sentence',a['sentences'][0]['sentenceId'],a['sentences'][0]['body'])]:
        payload={'textId':a['id'],'kind':kind,'targetId':target,'answer':'wrong','eventId':str(uuid4())}
        assert client.post('/api/v1/practice/answer',json=payload).json()=={'correct':False}
        payload['answer']=answer
        for _ in range(2):assert client.post('/api/v1/practice/answer',json=payload).json()=={'correct':True}
        recorded=client.post('/api/v1/graph/query',json={'query':'MATCH (a:Activity {identityKey:$key}) RETURN a.details AS details,a.amount AS amount',
                                                      'params':{'key':'practice:'+a['id']+':'+payload['eventId']}}).json()
        assert len(recorded)==1 and recorded[0]['amount']==1
        assert json.loads(recorded[0]['details'])=={'textId':a['id'],'targetId':target}


def test_small_lesson_never_borrows_candidates(client,lessons):
    text=import_lesson(client,'Single-word practice',[ [('桜','さくら','cherry blossom')] ])
    pool=practice(client,text)
    assert len(pool['words'])==1 and pool['words'][0]['base']=='桜'
    assert len(pool['sentences'])==1 and pool['sentences'][0]['textId']==text['id']
    no_words=import_lesson(client,'No-word practice',[[]])
    assert practice(client,no_words)=={'words':[],'sentences':[]}


def test_lesson_beyond_global_limit_keeps_all_placements(client,lessons):
    text=import_lesson(client,'Long lesson practice',[[('森','もり','forest')]]*501)
    pool=practice(client,text)
    assert len(pool['sentences'])==501
    assert {s['textId'] for s in pool['sentences']}=={text['id']}
    # Creating a newer, long lesson must not hide older lessons from practice.
    old=practice(client,lessons[0])
    assert len(old['sentences'])==len(lessons[0]['sentences'])


def test_matching_uses_primary_dictionary_sense_and_retains_alternatives(client,monkeypatch):
    from api import domain
    from api.graph import Tx
    senses=[(2,'no sooner than; once; right after (often having negative consequences)'),
            (3,"one's final moments"),(1,'last; final; latest'),(0,'end; conclusion')]
    choices=[{'meaning':body,'sourceType':'JMdict','sense':f'jmdict:1293810:{ordinal}'} for ordinal,body in senses]
    text=import_lesson(client,'Practice dictionary sense order',[
        [('最後','さいご',''),('籠','かご','basket'),('接吻','せっぷん','kiss'),('譲り合う','ゆずりあう','give-and-take')]],
        meanings={'最後':choices})
    base=text['sentences'][0]['tokens'][0]['baseId']
    stored=client.get('/api/v1/words/'+base).json()['meanings']
    assert [m['body'] for m in stored]==[body for _,body in sorted(senses)]
    before=[(m['id'],m['sourceKey'],m['body'],m['revision']) for m in stored]
    def forbidden(*_,**__):raise AssertionError('Practice ordering must use stored lesson meanings without writes or dictionary calls')
    with monkeypatch.context() as patch:
        patch.setattr(app.state.graph,'write',forbidden)
        patch.setattr(domain,'word_detail',forbidden)
        patch.setattr(Tx,'snapshot',forbidden)
        patch.setattr(domain,'analyze',forbidden)
        pool=practice(client,text)
    target=next(word for word in pool['words'] if word['baseId']==base)
    assert target['meaning']=='end; conclusion'
    assert pool['sentences'][0]['words'][0]['meaning']==target['meaning']
    assert len(pool['words'])==4 and len(pool['sentences'][0]['words'])==4
    assert pool['sentences'][0]['coverage']==0
    for answer in ('end; conclusion','last; final; latest'):
        result=client.post('/api/v1/practice/answer',json={'textId':text['id'],'kind':'matching',
                           'targetId':base,'answer':answer,'eventId':str(uuid4())})
        assert result.json()=={'correct':True}
    assert [(m['id'],m['sourceKey'],m['body'],m['revision']) for m in client.get('/api/v1/words/'+base).json()['meanings']]==before


def test_practice_orders_numeric_entries_and_senses_without_losing_empty_tokens(client):
    choices=[{'meaning':body,'sourceType':'JMdict','sense':key} for key,body in [
        ('jmdict:10:0','tenth entry'),('jmdict:2:10','tenth sense'),
        ('jmdict:2:2','second sense'),('jmdict:2:1','first sense')]]
    text=import_lesson(client,'Practice numeric dictionary order',[
        [('多義語順序','たぎごじゅんじょ',''),('未定義見出し','みていぎみだし','')]],meanings={'多義語順序':choices})
    pool=practice(client,text)
    assert len(pool['words'])==1 and pool['words'][0]['meaning']=='first sense'
    assert [word['meaning'] for word in pool['sentences'][0]['words']]==['first sense','']
    detail=client.get('/api/v1/words/'+pool['words'][0]['baseId']).json()
    assert [meaning['body'] for meaning in detail['meanings']]==['first sense','second sense','tenth sense','tenth entry']


def test_practice_prefers_canonical_meaning_over_an_inflected_forms_alternative(client):
    choices=[{'meaning':'form-specific alternative','base':'順位試験した','sourceType':'JMdict','sense':'jmdict:1:0'},
             {'meaning':'canonical meaning','base':'順位試験する','sourceType':'JMdict','sense':'jmdict:9:0'}]
    text=import_lesson(client,'Practice canonical meaning owner',[[('順位試験した','じゅんいしけんした','','順位試験する')]],
                       meanings={'順位試験した':choices})
    pool=practice(client,text)
    assert pool['words'][0]['base']=='順位試験する'
    assert pool['words'][0]['meaning']=='canonical meaning'
    token=text['sentences'][0]['tokens'][0]
    assert len(client.get('/api/v1/words/'+token['wordId']).json()['meanings'])==2
    assert client.get('/api/v1/words/'+token['baseId']).json()['meanings'][0]['body']=='canonical meaning'
