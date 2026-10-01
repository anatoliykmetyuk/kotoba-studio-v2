"""Completion counts, confirmation races, and migration progress use real Neo4j."""
from test_practice import client,import_lesson
from api.app import app
from api.graph import packed
from api.retokenize import apply,plan
from api.vocabulary_cleanup import fingerprint


def statuses(client,id,listening,reading):
    state=min((listening,reading),key=('new','learning','familiar','known').index)
    response=client.put('/api/v1/words/'+id+'/status',json={'state':state})
    assert response.status_code==200,response.text


def test_completion_counts_unique_families_and_promotes_new_status(client):
    text=import_lesson(client,'Completion fixture',[[('食べた','たべた','eat','食べる'),('猫','ねこ','cat')],[('食べる','たべる','eat'),('犬','いぬ','dog')]])
    client.put('/api/v1/texts/'+text['id']+'/status',json={'state':'new'})
    words={w['base']:w['baseId'] for s in text['sentences'] for w in s['tokens']}
    statuses(client,words['食べる'],'new','new');statuses(client,words['猫'],'learning','new');statuses(client,words['犬'],'learning','familiar')
    preview=client.get('/api/v1/texts/'+text['id']+'/completion').json();assert preview['wordCount']==2
    response=client.put('/api/v1/texts/'+text['id']+'/status',json={'state':'completed','revision':preview['revision'],'completionFingerprint':preview['fingerprint']})
    assert response.status_code==200,response.text
    assert response.json()['markedKnown']==2 and response.json()['cursor']==len(text['body'])
    for base in ('食べる','猫'):
        word=client.get('/api/v1/words/'+words[base]).json()
        assert {s['state'] for s in word['statuses'].values()}=={'known'}
    dog=client.get('/api/v1/words/'+words['犬']).json()
    assert {a:s['state'] for a,s in dog['statuses'].items()}=={'listening':'learning','reading':'learning'}
    client.put('/api/v1/texts/'+text['id']+'/status',json={'state':'new'})
    assert client.get('/api/v1/words/'+words['猫']).json()['statuses']['reading']['state']=='known'


def test_stale_completion_scope_is_rejected_without_mutation(client):
    text=import_lesson(client,'Completion race',[[('鳥','とり','bird'),('魚','さかな','fish')]])
    client.put('/api/v1/texts/'+text['id']+'/status',json={'state':'new'})
    word=text['sentences'][0]['tokens'][0]['wordId'];statuses(client,word,'new','new')
    preview=client.get('/api/v1/texts/'+text['id']+'/completion').json()
    statuses(client,word,'learning','learning')
    response=client.put('/api/v1/texts/'+text['id']+'/status',json={'state':'completed','completionFingerprint':preview['fingerprint']})
    assert response.status_code==409
    assert client.get('/api/v1/texts/'+text['id']).json()['textState']=='new'
    assert client.get('/api/v1/words/'+word).json()['statuses']['reading']['state']=='learning'


def test_progress_after_retokenizing_partially_seen_verb_does_not_duplicate_encounters(client):
    text=import_lesson(client,'Retokenize partial read',[[('食べ','たべ','eat','食べる'),('た','た','past')]])
    g=app.state.graph
    # This dedicated test lesson starts inside the merged form, after 食べ.
    g.write('test.cursor',lambda t:t.update(text['id'],cursor=0))
    assert client.put('/api/v1/texts/'+text['id']+'/progress',json={'cursor':2}).status_code==200
    before=g.read(lambda t:t.snapshot());analysis=[]
    for row in g.read(lambda t:t.run('MATCH (s:Sentence)<-[:SENTENCE]-(p)-[:TOKEN]->(o)-[:WORD]->(w)-[:BASE_FORM]->(b) RETURN s.id AS id,s.body AS body,p.id AS placement,properties(o) AS o,properties(w) AS w,properties(b) AS b ORDER BY s.id,p.id,o.ordinal')):
        found=next((s for s in analysis if s['id']==row['id']),None)
        if found is None:found={'id':row['id'],'body':row['body'],'tokens':[],'placement':row['placement']};analysis.append(found)
        if found['placement']!=row['placement']:continue
        o,w,b=row['o'],row['w'],row['b']
        found['tokens'].append({'surface':w['surface'],'base':b['surface'],'reading':o['reading'],'baseReading':b['reading'],'partOfSpeech':w['partOfSpeech'],'start':o['start'],'end':o['end'],'selected':{'base':b['surface'],'baseReading':b['reading']},'meanings':[]})
    covered={s['id'] for s in analysis}
    for n in before['nodes']:
        if 'Sentence' in n['labels'] and n['properties']['id'] not in covered:analysis.append({'id':n['properties']['id'],'body':n['properties']['body'],'tokens':[]})
    target=next(s for s in analysis if s['id']==text['sentences'][0]['sentenceId'])
    target['tokens']=[{'surface':'食べた','base':'食べる','reading':'たべた','baseReading':'たべる','partOfSpeech':'verb','start':0,'end':3,'selected':{'base':'食べる','baseReading':'たべる'},'meanings':[]}]
    expected=fingerprint(before)
    g.write('test.retokenize',lambda t:apply(t,analysis,expected))
    after=client.get('/api/v1/texts/'+text['id']).json();assert after['cursor']==2
    response=client.put('/api/v1/texts/'+text['id']+'/progress',json={'cursor':3})
    assert response.status_code==200,response.text
    assert response.json()['cursor']==3
    assert client.get('/api/v1/graph/audit').json()['valid']
    snapshot=g.read(lambda t:t.snapshot());again,report=plan(snapshot,analysis)
    assert not report['created'] and not report['removed'] and report['changedPlacements']==0
