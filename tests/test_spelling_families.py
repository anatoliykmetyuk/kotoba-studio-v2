"""Snapshot migration coverage for explicitly reviewed spelling-family repairs."""
import copy
import uuid

import pytest

from api.graph import digest, packed
from api.retokenize import plan
from api.schema import SCHEMA, validate_graph


def spelling_fixture(*, target=None, canonical_source=False, ambiguous=False):
    nodes=[];edges=[]
    def node(kind,key,**values):
        id=str(uuid.uuid5(uuid.NAMESPACE_URL,key))
        p={'id':id,'identityKey':key,'revision':0,'createdAt':'2026-10-01T00:00:00+00:00',
           'updatedAt':'2026-10-01T00:00:00+00:00',**values}
        nodes.append({'labels':['Entity',kind],'properties':p});return id
    def edge(a,r,b):edges.append({'from':a,'type':r,'to':b,'properties':{}})
    def word(surface,base=None,state='known'):
        key='word:'+digest(surface);id=str(uuid.uuid5(uuid.NAMESPACE_URL,key))
        wid=node('Word',key,surface=surface,reading='はやい',partOfSpeech='adj-i',family=base or id)
        edge(wid,'BASE_FORM',base or wid)
        if base is None:
            values=([{'area':area,'state':state} for area in ('listening','reading')]
                    if 'area' in SCHEMA['classes']['LearningStatus']['required'] else [{'state':state}])
            for v in values:
                suffix=':'+v['area'] if 'area' in v else ''
                st=node('LearningStatus',f'status:{wid}{suffix}',**v);edge(wid,'STATUS',st)
        return wid
    node('Schema','schema:active',digest=SCHEMA['digest'],version=SCHEMA['version'])
    body='速く走った。'+('速く' if ambiguous else '早く')+'起きた。'
    text=node('Text','text:'+digest(body),title='Spelling repair fixture',body=body,textState='completed',cursor=4,archived=False)
    sentence=node('Sentence','sentence:'+digest(body),body=body)
    place=node('SentenceOccurrence','placement:'+text+':0',ordinal=0,start=0,end=len(body))
    edge(text,'PLACEMENT',place);edge(place,'SENTENCE',sentence)
    early=word('早い');speed=word('速く',None if canonical_source else early)
    early_form=word('早く',early)
    target_id=word('速い',early if target=='form' else None,state='learning') if target else None
    values={'body':'a saved definition','reading':'はやく','partOfSpeech':'adj-i','sourceType':'user','sourceKey':'user:test'}
    meaning=node('Meaning','meaning:'+digest(packed(values)),**values);edge(speed,'HAS_MEANING',meaning)
    tokens=[];occurrences=[]
    for ordinal,(surface,start,wid,base) in enumerate([
        ('速く',0,speed,'速い'),('速く' if ambiguous else '早く',6,speed if ambiguous else early_form,'早い')]):
        oid=node('WordOccurrence',f'occurrence:{place}:{ordinal}',ordinal=ordinal,start=start,end=start+2,reading='はやく')
        edge(place,'TOKEN',oid);edge(oid,'WORD',wid);occurrences.append(oid)
        encounter=node('Encounter','encounter:'+oid,**({'area':'reading'} if 'area' in SCHEMA['classes']['Encounter']['required'] else {}),evidence='reader-progress')
        edge(encounter,'OCCURRED_IN',oid)
        tokens.append({'surface':surface,'start':start,'end':start+2,'base':base,'reading':'はやく','baseReading':'はやい',
                       'partOfSpeech':'adj-i','selected':{'base':base,'baseReading':'はやい'},
                       'meanings':[{'base':base,'baseReading':'はやい','meaning':'fast' if base=='速い' else 'early',
                                    'partOfSpeech':'adj-i','sourceType':'JMdict','sense':'jmdict:1404975:0'}]})
    snapshot={'nodes':nodes,'edges':edges};validate_graph(snapshot)
    return snapshot,[{'id':sentence,'body':body,'tokens':tokens}],{'text':text,'early':early,'speed':speed,'target':target_id,'occurrences':occurrences}


def test_explicit_repair_copies_mastery_and_preserves_existing_ids_and_progress():
    before,analysis,ids=spelling_fixture()
    after,report=plan(before,analysis,['速く']);validate_graph(after)
    old={n['properties']['id']:n for n in before['nodes']};new={n['properties']['id']:n for n in after['nodes']}
    target=report['repairedFamilies'][0]['baseId']
    assert new[target]['properties']['surface']=='速い'
    assert new[ids['speed']]['properties']['family']==target
    assert new[ids['early']]==old[ids['early']]
    assert new[ids['text']]==old[ids['text']]
    assert set(old)<=set(new)
    for id,n in old.items():
        if set(n['labels']) & {'LearningStatus','Meaning','Encounter','WordOccurrence'}:assert new[id]==n
    statuses={e['to'] for e in after['edges'] if e['from']==target and e['type']=='STATUS'}
    assert statuses and {new[id]['properties']['state'] for id in statuses}=={'known'}
    assert report['repairedFamilies'][0]['statusPolicy']=='copy-previous-family'
    again,repeated=plan(after,analysis,['速く'])
    assert after==again and not repeated['repairedFamilies']


def test_existing_target_retains_its_own_mastery():
    before,analysis,ids=spelling_fixture(target='root')
    after,report=plan(before,analysis,['速く'])
    nodes={n['properties']['id']:n['properties'] for n in after['nodes']}
    assert nodes[ids['speed']]['family']==ids['target']
    for edge in after['edges']:
        if edge['type']=='STATUS':
            assert nodes[edge['to']]['state']==('learning' if edge['from']==ids['target'] else 'known')
    assert report['repairedFamilies'][0]['statusPolicy']=='preserve-existing-target'


def test_unrequested_family_conflict_remains_reviewable():
    before,analysis,ids=spelling_fixture();after,report=plan(before,analysis)
    word=next(n['properties'] for n in after['nodes'] if n['properties']['id']==ids['speed'])
    assert word['family']==ids['early'] and not report['repairedFamilies']
    assert report['retainedFamilies']==[{'surface':'速く','retainedBase':'早い','analyzedBase':'速い'}]


@pytest.mark.parametrize('options,requested,error', [
    ({},['unknown'],'stored spelling'),
    ({'canonical_source':True},['速く'],'Canonical family roots'),
    ({'ambiguous':True},['速く'],'conflicting upstream roots'),
    ({'target':'form'},['速く'],'not a canonical root'),
])
def test_unproven_or_structural_repairs_rejected(options,requested,error):
    before,analysis,_=spelling_fixture(**options);saved=copy.deepcopy(before)
    with pytest.raises(ValueError,match=error):plan(before,analysis,requested)
    assert before==saved
