"""Lowest-state schema migration, invariants and preservation."""
import copy

import pytest

from api.domain import create_statuses
from api.schema import SCHEMA, InvalidGraph, validate_graph
from cli.learning_status import STATES, migrate
from cli.migrate import Memory


@pytest.mark.parametrize('reading',STATES)
@pytest.mark.parametrize('listening',STATES)
def test_migration_uses_lowest_status_and_preserves_other_records(reading,listening):
    m=Memory();m.create('Schema','schema:active',digest=SCHEMA['digest'],version=SCHEMA['version'])
    word=m.create('Word','word:test',id='word-test',surface='試験',reading='しけん',partOfSpeech='noun',family='word-test')
    m.link(word['id'],'BASE_FORM',word['id'])
    for area,state,revision in [('reading',reading,4),('listening',listening,9)]:
        status=m.create('LearningStatus',f'status:{word["id"]}:{area}',area=area,state=state)
        m.update(status['id'],revision=revision);m.link(word['id'],'STATUS',status['id'])
    before=m.snapshot();original=copy.deepcopy(before)
    after,report=migrate(before)
    assert before==original
    statuses=[n['properties'] for n in after['nodes'] if 'LearningStatus' in n['labels']]
    assert len(statuses)==1 and statuses[0]['state']==min((reading,listening),key=STATES.index)
    assert statuses[0]['revision']==10 and 'area' not in statuses[0]
    assert report['familiesMigrated']==report['statusesRemoved']==1
    assert validate_graph(after)['valid']
    assert [n for n in after['nodes'] if 'LearningStatus' not in n['labels']]==[n for n in before['nodes'] if 'LearningStatus' not in n['labels']]
    again,report=migrate(after)
    assert again==after and report['alreadyMigrated']
    bad=copy.deepcopy(after);bad['edges']=[e for e in bad['edges'] if e['type']!='STATUS']
    with pytest.raises(InvalidGraph):validate_graph(bad)
    bad=copy.deepcopy(after);status=copy.deepcopy(next(n for n in bad['nodes'] if 'LearningStatus' in n['labels']))
    status['properties'].update(id='second-status',identityKey='second-status')
    bad['nodes'].append(status);bad['edges'].append({'from':word['id'],'type':'STATUS','to':'second-status','properties':{}})
    with pytest.raises(InvalidGraph):validate_graph(bad)


def test_creation_and_phrase_migration_use_same_lowest_rule():
    m=Memory();create_statuses(m,'new-owner',{'reading':'known','listening':'familiar'})
    assert m.find('status:new-owner')['state']=='familiar'
    snapshot=m.snapshot();status=snapshot['nodes'][0]['properties']
    status['area']='reading'
    with pytest.raises(InvalidGraph):migrate(snapshot)
