import copy
import uuid

import pytest

from api.graph import digest,packed
from api.retokenize import plan
from api.schema import SCHEMA,validate_graph


def fixture():
    nodes=[];edges=[]
    def node(kind,key,**values):
        id=str(uuid.uuid5(uuid.NAMESPACE_URL,key));p={'id':id,'identityKey':key,'revision':0,'createdAt':'2026-09-27T00:00:00+00:00','updatedAt':'2026-09-27T00:00:00+00:00',**values}
        nodes.append({'labels':['Entity',kind],'properties':p});return id
    def edge(a,r,b):edges.append({'from':a,'type':r,'to':b,'properties':{}})
    node('Schema','schema:active',digest=SCHEMA['digest'],version=SCHEMA['version'])
    body='食べた。私にとって。';text=node('Text','text:'+digest(body),title='Retokenize fixture',body=body,textState='new',cursor=4,archived=False)
    sentence=node('Sentence','sentence:'+digest(body),body=body);place=node('SentenceOccurrence','placement:'+text+':0',ordinal=0,start=0,end=len(body));edge(text,'PLACEMENT',place);edge(place,'SENTENCE',sentence)
    words={}
    def word(surface,base=None):
        base=base or surface
        if base not in words:
            key='word:'+digest(base);id=str(uuid.uuid5(uuid.NAMESPACE_URL,key));words[base]=node('Word',key,surface=base,reading='',partOfSpeech='verb',family=id);edge(id,'BASE_FORM',id)
            s=node('LearningStatus',f'status:{id}',state='known');edge(id,'STATUS',s)
        if surface not in words:
            words[surface]=node('Word','word:'+digest(surface),surface=surface,reading='',partOfSpeech='verb',family=words[base]);edge(words[surface],'BASE_FORM',words[base])
        return words[surface]
    entries=[('食べ','食べる',0,2),('た',None,2,3),('私',None,4,5),('に',None,5,6),('とっ','取る',6,8),('て',None,8,9)]
    for i,(surface,base,start,end) in enumerate(entries):
        wid=word(surface,base);o=node('WordOccurrence',f'occurrence:{place}:{i}',ordinal=i,start=start,end=end,reading='');edge(place,'TOKEN',o);edge(o,'WORD',wid)
        e=node('Encounter','encounter:reading:'+o,area='reading',evidence='reader-progress');edge(e,'OCCURRED_IN',o)
    values={'body':'a saved user definition','reading':'','partOfSpeech':'verb','sourceType':'user','sourceKey':'user:test'}
    m=node('Meaning','meaning:'+digest(packed(values)),**values);edge(words['食べる'],'HAS_MEANING',m)
    data={'nodes':nodes,'edges':edges};validate_graph(data)
    def token(surface,base,start,end,meaning):
        return {'surface':surface,'base':base,'reading':'','baseReading':'','partOfSpeech':'verb','start':start,'end':end,
                'selected':{'base':base,'baseReading':''},'meanings':[{'meaning':meaning,'baseReading':'','partOfSpeech':'verb','sourceType':'JMdict','sense':'jmdict:'+base}]}
    analysis=[{'id':sentence,'body':body,'tokens':[token('食べた','食べる',0,3,'to eat'),token('私','私',4,5,'I'),token('にとって','にとって',5,9,'for; from the standpoint of')]}]
    return data,analysis,text,words


def test_retokenization_preserves_text_status_and_user_meanings():
    before,analysis,text,words=fixture();after,report=plan(before,analysis);validate_graph(after)
    old={n['properties']['id']:n for n in before['nodes']};new={n['properties']['id']:n for n in after['nodes']}
    assert new[text]==old[text]
    for id in words.values():assert new[id]==old[id]
    for id,n in old.items():
        if set(n['labels']) & {'LearningStatus','Meaning'}:assert new[id]==n
    forms={n['properties']['surface']:n['properties'] for n in after['nodes'] if 'Word' in n['labels']}
    assert forms['食べた']['family']==words['食べる']
    expression=forms['にとって']['id'];states={e['to'] for e in after['edges'] if e['from']==expression and e['type']=='STATUS'}
    assert {new[id]['properties']['state'] for id in states}=={'new'}
    assert report['occurrencesBefore']==6 and report['occurrencesAfter']==3
    assert report['preservedTexts']==1 and not report['retainedFamilies']
    # Collapsed encounter nodes retain all original evidence in migration output.
    encounters=[n for n in after['nodes'] if 'Encounter' in n['labels']]
    assert len(encounters)==3 and len(report['preservedEncounterEvidence'])==3


def test_repeat_plan_has_no_occurrence_or_meaning_changes():
    before,analysis,_,_=fixture();after,_=plan(before,analysis);again,report=plan(after,analysis)
    assert after==again
    assert report['created']=={} and report['removed']=={} and report['changedPlacements']==0


def test_incomplete_or_changed_analysis_rejected():
    before,analysis,_,_=fixture()
    with pytest.raises(ValueError):plan(before,[])
    with pytest.raises(ValueError):plan(before,analysis+analysis)
    for path,value in [('body','changed'),('tokens',[])]:
        invalid=copy.deepcopy(analysis);invalid[0][path]=value
        if path=='body':
            with pytest.raises(ValueError):plan(before,invalid)
    invalid=copy.deepcopy(analysis);invalid[0]['tokens'][0]['end']=2
    with pytest.raises(ValueError):plan(before,invalid)


def test_existing_conflicting_family_is_reported_and_retained():
    before,analysis,_,words=fixture()
    analysis[0]['tokens'][1]['selected']['base']='わたくし'
    after,report=plan(before,analysis)
    assert report['retainedFamilies']==[{'surface':'私','retainedBase':'私','analyzedBase':'わたくし'}]
    private=next(n['properties'] for n in after['nodes'] if n['properties']['id']==words['私'])
    assert private['family']==words['私']


def test_conflicting_form_meaning_never_pollutes_retained_base():
    before,analysis,_,words=fixture()
    # Interpret an existing inflected surface against a different dictionary
    # lemma, while preserving its previously saved family association.
    analysis[0]['tokens'][0].update(surface='食べ',end=2)
    analysis[0]['tokens'][0]['selected']['base']='別の語'
    analysis[0]['tokens'][0]['meanings'][0]['meaning']='a different lexical entry'
    after,report=plan(before,analysis)
    meanings={n['properties']['id']:n['properties']['body'] for n in after['nodes'] if 'Meaning' in n['labels']}
    base_meanings=[meanings[e['to']] for e in after['edges'] if e['from']==words['食べる'] and e['type']=='HAS_MEANING']
    form_meanings=[meanings[e['to']] for e in after['edges'] if e['from']==words['食べ'] and e['type']=='HAS_MEANING']
    assert 'a different lexical entry' not in base_meanings
    assert 'a different lexical entry' in form_meanings


@pytest.mark.parametrize('token_index', [0, 1])
def test_alternative_meanings_never_pollute_canonical_word(token_index):
    before,analysis,_,_=fixture()
    token=analysis[0]['tokens'][token_index]
    token['meanings'][0]['base']=token['selected']['base']
    token['meanings'].append({'base':'別の語','baseReading':'べつのご','meaning':'another lemma',
                              'sourceType':'JMdict','sense':'jmdict:999:0'})
    after,_=plan(before,analysis)
    nodes={n['properties']['id']:n['properties'] for n in after['nodes']}
    words={n['properties']['surface']:n['properties'] for n in after['nodes'] if 'Word' in n['labels']}
    def attached(surface):
        return {nodes[e['to']]['body'] for e in after['edges'] if e['from']==words[surface]['id'] and e['type']=='HAS_MEANING'}
    base=token['selected']['base']
    assert token['meanings'][0]['meaning'] in attached(base)
    assert 'another lemma' not in attached(base)
    if token['surface']!=base:assert 'another lemma' in attached(token['surface'])
