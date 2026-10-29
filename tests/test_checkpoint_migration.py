"""One-time checkpoint migration preserves completed lessons without vocabulary edits."""
import copy
from cli.reading_checkpoints import migrate
from api.domain import reading_progress


def test_initialize_only_from_completed_text_status_and_preserve_all_other_data():
    nodes=[{'labels':['Entity',kind],'properties':props} for kind,props in [
        ('Text',{'id':'done','textState':'completed','cursor':9,'body':'保護された本文'}),
        ('Text',{'id':'partial','textState':'new','cursor':9,'body':'途中の本文'}),
        ('SentenceOccurrence',{'id':'a','revision':3,'updatedAt':'old'}),
        ('SentenceOccurrence',{'id':'b','revision':4,'updatedAt':'old'}),
        ('LearningStatus',{'id':'status','state':'new'})]]
    before={'nodes':nodes,'edges':[{'from':'done','type':'PLACEMENT','to':'a'},
                                  {'from':'partial','type':'PLACEMENT','to':'b'}]}
    original=copy.deepcopy(before);after,report=migrate(before)
    assert before==original
    old={n['properties']['id']:n for n in before['nodes']};new={n['properties']['id']:n for n in after['nodes']}
    assert new['a']['properties']['completed'] is True
    assert new['b']['properties']['completed'] is False
    assert new['a']['properties']['revision']==4
    assert new['b']['properties']['revision']==5
    assert report=={'sentencesInitialized':2,'completedSentences':1,'alreadyMigrated':False}
    assert new['done']==old['done'] and new['partial']==old['partial'] and new['status']==old['status']
    assert after['edges']==before['edges']
    again,repeat=migrate(after)
    assert again==after and repeat['alreadyMigrated']


def test_progress_counts_occurrences_and_tokenless_sentences():
    assert reading_progress([{'tokens':[1,2,3],'completed':True},{'tokens':[1],'completed':False}])==.75
    assert reading_progress([{'tokens':[1],'completed':True},{'tokens':[],'completed':False}])==.5
    assert reading_progress([])==0


def test_ontology_rejects_invalid_flags_and_inconsistent_lesson_completion():
    import pytest
    from api.schema import InvalidGraph,validate_graph
    from test_retokenize import fixture
    before,_,text,_=fixture()
    for completed in ('true',1,None):
        invalid=copy.deepcopy(before)
        placement=next(n['properties'] for n in invalid['nodes'] if 'SentenceOccurrence' in n['labels'])
        placement['completed']=completed
        with pytest.raises(InvalidGraph):validate_graph(invalid)
    invalid=copy.deepcopy(before)
    next(n['properties'] for n in invalid['nodes'] if n['properties']['id']==text)['textState']='completed'
    with pytest.raises(InvalidGraph,match='completion must match'):validate_graph(invalid)
