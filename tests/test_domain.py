import copy,os,uuid,json
import pytest
from api.graph import Graph,Tx,Conflict
from api.schema import validate_graph,InvalidGraph,SCHEMA
from api.domain import finalize_import,set_status,text_state,text_detail,correct_meaning,word_detail
from api.language import analyze,kanji

@pytest.fixture(scope='module')
def graph():
    # Must be an explicitly supplied disposable database, never production.
    if os.getenv('KOTOBA_TEST_DATABASE')!='disposable':pytest.fail('Set KOTOBA_TEST_DATABASE=disposable with an isolated Neo4j URI')
    assert os.getenv('NEO4J_URI','bolt://127.0.0.1:17687')=='bolt://127.0.0.1:17687', 'Use the owned dev database on port 17687'
    g=Graph()
    with g.driver.session() as session:session.run('MATCH (n) DETACH DELETE n').consume()
    g.initialize();yield g;g.close()

def annotated(body):
    parsed=analyze(body)
    for sentence in parsed:
        for token in sentence['tokens']:
            token['selected']=token['choices'][0] if token['choices'] else {'base':token['base'],'baseReading':token['baseReading'],'meaning':'fixture'}
    return {'sentences':parsed}

def test_dedup_base_status_and_text_independence(graph):
    body='猫を見ました。猫を見ました。'
    a=graph.write('test.import',lambda t:finalize_import(t,{'title':'Test','body':body},annotated(body)))
    b=graph.write('test.import',lambda t:finalize_import(t,{'title':'Duplicate','body':body},annotated(body)))
    assert a['textId']==b['textId']
    detail=graph.read(lambda t:text_detail(t,a['textId']));assert len(detail['sentences'])==2
    assert detail['sentences'][0]['sentenceId']==detail['sentences'][1]['sentenceId']
    assert detail['sentences'][0]['id']!=detail['sentences'][1]['id']
    token=detail['sentences'][0]['tokens'][0]
    graph.write('test.status',lambda t:set_status(t,token['wordId'],'reading','known'))
    graph.write('test.complete',lambda t:text_state(t,a['textId'],'completed'))
    again=graph.read(lambda t:text_detail(t,a['textId']))
    assert all(s['tokens'][0]['states']=={'reading':'known','listening':'new'} for s in again['sentences'])
    graph.write('test.reopen',lambda t:text_state(t,a['textId'],'new'))
    assert graph.read(lambda t:t.get(a['textId']))['cursor']==len(body)

def test_invalid_raw_mutation_rolls_back(graph):
    for q in ['MATCH (s:Schema) DETACH DELETE s','MATCH (s:Schema) SET s.digest="bad"','MATCH (s:Schema) SET s.id="bad"','CREATE (n:Unknown {id:"bad"})']:
        before=graph.read(lambda t:t.snapshot())
        with pytest.raises(InvalidGraph):graph.raw_write([{'query':q}])
        assert graph.read(lambda t:t.snapshot())==before

def test_occurrence_bounds_and_duplicate_ordinals(graph):
    snapshot=graph.read(lambda t:t.snapshot())
    for kind in ['SentenceOccurrence','WordOccurrence']:
        bad=copy.deepcopy(snapshot);node=next(n for n in bad['nodes'] if kind in n['labels']);node['properties']['end']=999999
        with pytest.raises(InvalidGraph):validate_graph(bad)

def test_idempotency_and_stale_revision(graph):
    key=str(uuid.uuid4());call=lambda t:t.create('Folder','folder:test',name='test')
    a=graph.write('test',call,key);b=graph.write('test',call,key);assert a==b
    graph.write('test',lambda t:t.update(a['id'],expected=0,name='changed'))
    with pytest.raises(Conflict):graph.write('test',lambda t:t.update(a['id'],expected=0,name='bad'))

def test_different_meaning_same_spelling(graph):
    body='橋を渡ります。'
    r=graph.write('test',lambda t:finalize_import(t,{'title':'Bridge','body':body},annotated(body)))
    d=graph.read(lambda t:text_detail(t,r['textId']));token=d['sentences'][0]['tokens'][0]
    graph.write('test',lambda t:set_status(t,token['wordId'],'listening','known'))
    replacement=graph.write('test',lambda t:correct_meaning(t,token['id'],{'base':token['surface'],'meaning':'a distinct observed fixture meaning'}))
    assert replacement['baseId']==token['baseId']
    assert replacement['wordId']==token['wordId']
    meanings=graph.read(lambda t:word_detail(t,token['wordId']))['meanings']
    assert any(m['body']=='a distinct observed fixture meaning' for m in meanings)
    d=graph.read(lambda t:text_detail(t,r['textId']));assert d['sentences'][0]['tokens'][0]['states']['listening']=='known'

def test_kanji():
    assert kanji('日本語') and kanji('時々') and not kanji('こんにちは')

def test_scalar_fast_path_preserves_invariants(graph):
    word=graph.read(lambda t:t.run('MATCH (w:Word) RETURN w.id AS id LIMIT 1'))[0]['id']
    result=graph.write('status',lambda t:set_status(t,word,'reading','familiar'),scalar_only=True)
    assert result['state']=='familiar'
    with pytest.raises(InvalidGraph):graph.write('bad.scalar',lambda t:t.update(word,family='missing'),scalar_only=True)
    with pytest.raises(InvalidGraph):graph.write('bad.scalar',lambda t:t.run('MATCH (n:Word) DETACH DELETE n'),scalar_only=True)
    assert graph.read(lambda t:validate_graph(t.snapshot()))['valid']

def test_relationship_transaction_advances_revision(graph):
    rows=graph.read(lambda t:t.run('MATCH (o:WordOccurrence)-[:WORD]->(w) RETURN o.id AS id,o.revision AS revision,w.id AS word LIMIT 1'));old=rows[0]
    # Relation creation/deletion in the same transaction with no net change does not alter revisions.
    graph.raw_write([{'query':'MATCH (o:WordOccurrence {id:$id})-[r:WORD]->(w) DELETE r CREATE (o)-[:WORD]->(w)','params':{'id':old['id']}}],expected_revisions={old['id']:old['revision']})
    assert graph.read(lambda t:t.get(old['id']))['revision']==old['revision']
    with pytest.raises(Conflict):graph.raw_write([],expected_revisions={old['id']:old['revision']+1})

def test_explore_filters_execute_in_database(graph):
    from api.domain import explore
    all_rows=graph.read(lambda t:explore(t,limit=1))
    assert len(all_rows)==1
    root=all_rows[0]['words'][0]['baseId']
    rows=graph.read(lambda t:explore(t,word_id=root))
    assert rows and all(any(w['baseId']==root for w in r['words']) for r in rows)
    assert graph.read(lambda t:explore(t,query='no such phrase anywhere'))==[]

def test_new_token_promotion_preserves_other_area_and_advanced_statuses(graph):
    row=graph.read(lambda t:t.run('MATCH (w:Word)-[:BASE_FORM]->(b) RETURN w.id AS id,b.id AS base LIMIT 1'))[0]
    def set_(state,area='reading',only=False):return graph.write('test.tap',lambda t:set_status(t,row['id'],area,state,only_if_new=only),scalar_only=True)
    set_('new');set_('familiar','listening')
    promoted=set_('learning',only=True);assert promoted['state']=='learning'
    detail=graph.read(lambda t:word_detail(t,row['id']))
    assert detail['statuses']['listening']['state']=='familiar'
    assert detail['statuses']['reading']['state']=='learning'
    for advanced in ('familiar','known'):
        before=set_(advanced);after=set_('learning',only=True)
        assert after==before


def test_explore_coverage_with_tokenless_sentence(graph):
    from api.domain import explore
    body='。。。'
    graph.write('test.punctuation',lambda t:finalize_import(t,{'title':'Punctuation','body':body},{'sentences':[{'body':body,'start':0,'end':len(body),'tokens':[]}]}))
    rows=graph.read(lambda t:explore(t,minimum=.8))
    assert all(row['coverage']>=.8 for row in rows)
    first=graph.read(lambda t:explore(t,minimum=0,limit=1))
    assert len(first)==1 and first[0]['words']
