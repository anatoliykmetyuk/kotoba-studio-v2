"""Explicit checkpoint behavior across the actual API and disposable Neo4j."""
from uuid import uuid4

from api.app import app
from test_practice import client,import_lesson


def put(client,text,first,last,completed=True,key=None):
    return client.put('/api/v1/texts/'+text['id']+'/checkpoint',json={
        'start':text['sentences'][first]['start'],'end':text['sentences'][last]['end'],
        'completed':completed},headers={'Idempotency-Key':key} if key else {})


def fixture(client):
    text=import_lesson(client,'Independent reading sections',[
        [('区間甲','くかんこう','first'),('区間乙','くかんおつ','second')],
        [('区間丙','くかんへい','third')],
        [('区間丁','くかんてい','fourth')]])
    client.put('/api/v1/texts/'+text['id']+'/status',json={'state':'new'})
    for sentence in text['sentences']:
        for word in sentence['tokens']:
            assert client.put('/api/v1/words/'+word['baseId']+'/status',json={'state':'new'}).status_code==200
    return client.get('/api/v1/texts/'+text['id']).json()


def test_out_of_order_sections_only_promote_their_own_new_families(client):
    text=fixture(client)
    # A later section contributes its size, not the furthest source position.
    result=put(client,text,2,2)
    assert result.status_code==200,result.text
    result=result.json()
    assert result['readingProgress']==.25 and result['markedKnown']==1
    assert [s['completed'] for s in result['sentences']]==[False,False,True]
    assert [w['state'] for s in result['sentences'] for w in s['tokens']]==['new','new','new','known']
    library=next(t for t in client.get('/api/v1/texts').json() if t['id']==text['id'])
    assert library['readingProgress']==.25 and library['textState']=='new'
    assert put(client,text,0,0).json()['readingProgress']==.75
    complete=put(client,text,1,1).json()
    assert complete['readingProgress']==1 and complete['textState']=='completed'
    reopened=put(client,text,0,0,False).json()
    assert reopened['readingProgress']==.5 and reopened['textState']=='new'
    assert all(w['state']=='known' for s in reopened['sentences'] for w in s['tokens'])
    seen=client.get('/api/v1/explore',params={'q':text['title'],'seen':'seen'}).json()
    assert {s['occurrenceId'] for s in seen}=={text['sentences'][i]['id'] for i in (1,2)}


def test_checkpoint_preserves_non_new_statuses_and_is_idempotent_after_undo(client):
    text=fixture(client)
    words=text['sentences'][0]['tokens']
    for word,state in zip(words,('learning','familiar')):
        assert client.put('/api/v1/words/'+word['baseId']+'/status',json={'state':state}).status_code==200
    key=str(uuid4())
    response=put(client,text,0,0,key=key)
    assert response.status_code==200 and response.json()['markedKnown']==0
    assert [w['state'] for w in response.json()['sentences'][0]['tokens']]==['learning','familiar']
    assert put(client,text,0,0,False).status_code==200
    # A retry of the acknowledged check must not replay it after a later undo.
    assert put(client,text,0,0,key=key).status_code==200
    after=client.get('/api/v1/texts/'+text['id']).json()
    assert not after['sentences'][0]['completed'] and after['readingProgress']==0
    # All encounters survive undo, and repeating a fresh check does not duplicate them.
    graph=app.state.graph
    def encounters():return graph.read(lambda t:t.run('MATCH (:Text {id:$id})-[:PLACEMENT]->()-[:TOKEN]->(o)<-[:OCCURRED_IN]-(e:Encounter) RETURN e.id AS id',id=text['id']))
    before=encounters();assert len(before)==2
    assert put(client,text,0,0).status_code==200
    assert {row['id'] for row in encounters()}=={row['id'] for row in before}


def test_invalid_checkpoint_boundaries_are_atomic_and_cursor_does_not_credit_progress(client):
    text=fixture(client);endpoint='/api/v1/texts/'+text['id']+'/checkpoint'
    for start,end in ((1,text['sentences'][0]['end']),(0,1),(4,4),(0,len(text['body'])+1)):
        response=client.put(endpoint,json={'start':start,'end':end,'completed':True})
        assert response.status_code==422,response.text
    after=client.get('/api/v1/texts/'+text['id']).json()
    assert after['readingProgress']==0 and not any(s['completed'] for s in after['sentences'])
    app.state.graph.write('test.old-cursor',lambda t:t.update(text['id'],cursor=len(text['body'])))
    assert client.get('/api/v1/texts/'+text['id']).json()['readingProgress']==0
    assert client.put('/api/v1/texts/'+text['id']+'/progress',json={'cursor':len(text['body'])}).status_code==404
    assert client.put('/api/v1/texts/missing/checkpoint',json={'start':0,'end':1,'completed':True}).status_code==404
    # Required OML shape applies to agent writes as well as reader writes.
    response=client.post('/api/v1/graph/transaction',json={'statements':[{
        'query':'MATCH (p:SentenceOccurrence {id:$id}) REMOVE p.completed','params':{'id':text['sentences'][0]['id']}}]})
    assert response.status_code==422,response.text
    assert client.get('/api/v1/graph/audit').json()['valid']


def test_tokenless_final_sentence_requires_its_checkpoint(client):
    text=import_lesson(client,'Tokenless checkpoint tail',[[('区間終','くかんしゅう','last')],[]])
    client.put('/api/v1/texts/'+text['id']+'/status',json={'state':'new'})
    partial=put(client,text,0,0).json()
    assert partial['readingProgress']==.5 and partial['textState']=='new'
    complete=put(client,text,1,1).json()
    assert complete['readingProgress']==1 and complete['textState']=='completed'


def test_checkpoint_setting_is_shared_and_bounded(client):
    old=client.get('/api/v1/settings').json()
    try:
        assert client.patch('/api/v1/settings',json={'checkpointWords':120}).status_code==200
        assert client.get('/api/v1/settings').json()['checkpointWords']==120
        for value in (0,9,501,12.5):
            assert client.patch('/api/v1/settings',json={'checkpointWords':value}).status_code==422
    finally:
        assert client.put('/api/v1/settings',json=old).status_code==200
