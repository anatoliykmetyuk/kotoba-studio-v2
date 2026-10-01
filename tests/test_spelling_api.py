"""Real API/Neo4j boundaries for importing and repairing spelling families."""
import json
import os

import pytest
from fastapi.testclient import TestClient

from api import domain, language
from api.app import app
from api.graph import Graph, digest


@pytest.fixture(scope='module')
def client():
    if os.getenv('KOTOBA_TEST_DATABASE')!='disposable':pytest.fail('Enable the owned disposable development database')
    assert os.getenv('NEO4J_URI','bolt://127.0.0.1:17687')=='bolt://127.0.0.1:17687'
    graph=Graph()
    with graph.driver.session() as session:session.run('MATCH (n) DETACH DELETE n').consume()
    graph.close();os.environ['KOTOBA_WORKER_TOKEN']='spelling-test-worker'
    with TestClient(app) as client:yield client


def annotated(body):
    sentences=language.analyze(body)
    for sentence in sentences:
        for token in sentence['tokens']:
            token['meanings']=token.pop('choices')
            token['selected']={'base':token['base'],'baseReading':token['baseReading']}
    return sentences


def complete_job(client,job_id,result):
    headers={'Authorization':'Bearer spelling-test-worker'}
    claim=client.post('/api/v1/worker/claim',headers=headers).json()['job']
    assert claim['id']==job_id
    done=client.post('/api/v1/worker/'+job_id+'/complete',headers=headers,
                     json={'attempt':claim['attempts'],'result':result})
    assert done.status_code==200,done.text
    return done.json()


def test_live_import_keeps_homophones_in_separate_spelling_families(client):
    body='速く走る。早く起きる。'
    job=client.post('/api/v1/imports',json={'title':'Separate spelling fixture','body':body}).json()['jobId']
    result=complete_job(client,job,{'sentences':annotated(body)})
    detail=client.get('/api/v1/texts/'+result['textId']).json()
    tokens={t['surface']:t for p in detail['sentences'] for t in p['tokens']}
    assert tokens['速く']['base']=='速い' and tokens['早く']['base']=='早い'
    assert tokens['速く']['baseId']!=tokens['早く']['baseId']
    for surface,base in [('速く','速い'),('早く','早い')]:
        card=client.get('/api/v1/words/'+tokens[surface]['baseId']).json()
        assert card['base']['surface']==base
    assert client.get('/api/v1/graph/audit').json()['valid']


def test_reviewed_retokenization_repairs_saved_family_atomically(client):
    # Represent a prior imported corpus whose exact spelling was linked to the
    # wrong canonical root. The analysis itself still comes from live Ichiran.
    body='速く泳いだ。'
    legacy=annotated(body)
    speed=next(t for s in legacy for t in s['tokens'] if t['surface']=='速く')
    speed['selected']={'base':'早い','baseReading':'はやい'}
    created=app.state.graph.write('test.legacy-spelling',lambda t:domain.finalize_import(t,
        {'title':'Legacy spelling fixture','body':body},{'sentences':legacy}))
    # The previous test has a correct 速く already. Force the historical wrong
    # family in-place through the same validated transaction used by agents.
    detail=client.get('/api/v1/texts/'+created['textId']).json()
    token=next(t for s in detail['sentences'] for t in s['tokens'] if t['surface']=='速く')
    early=app.state.graph.read(lambda t:t.find('word:'+digest('早い')))
    transaction={'statements':[{'query':'''MATCH (w:Word {id:$word})-[old:BASE_FORM]->(),(b:Word {id:$base})
        DELETE old SET w.family=b.id MERGE (w)-[:BASE_FORM]->(b)''','params':{'word':token['wordId'],'base':early['id']}}]}
    assert client.post('/api/v1/graph/transaction',json=transaction).status_code==200
    before=client.get('/api/v1/texts/'+created['textId']).json()
    submitted=client.post('/api/v1/maintenance/retokenize/plan',json={'familyRepairs':['速く']})
    assert submitted.status_code==202
    job_id=submitted.json()['jobId']
    payload=app.state.graph.read(lambda t:json.loads(t.get(job_id)['payload']))
    analyzed=[]
    for sentence in payload['sentences']:
        tokens=annotated(sentence['body'])[0]['tokens']
        analyzed.append(sentence|{'tokens':tokens})
    plan=complete_job(client,job_id,{'sentences':analyzed})['plan']
    assert plan['repairedFamilies'][0]['surface']=='速く'
    request={'jobId':job_id,'expectedFingerprint':plan['fingerprint']}
    assert client.post('/api/v1/maintenance/retokenize/apply',json=request|{'expectedFingerprint':'0'*64}).status_code==409
    assert client.get('/api/v1/texts/'+created['textId']).json()==before
    applied=client.post('/api/v1/maintenance/retokenize/apply',json=request)
    assert applied.status_code==200,applied.text
    after=client.get('/api/v1/texts/'+created['textId']).json()
    token_after=next(t for s in after['sentences'] for t in s['tokens'] if t['surface']=='速く')
    assert token_after['wordId']==token['wordId'] and token_after['base']=='速い'
    assert {key:after[key] for key in ('id','body','cursor','textState')}=={key:before[key] for key in ('id','body','cursor','textState')}
    assert client.post('/api/v1/maintenance/retokenize/apply',json=request).status_code==409
    assert client.get('/api/v1/graph/audit').json()['valid']
