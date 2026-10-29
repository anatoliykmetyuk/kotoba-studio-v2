"""Checkpoint evidence uses one validated batch while retaining once-only credit."""
import json
from datetime import datetime
from uuid import UUID
from zoneinfo import ZoneInfo

import pytest

from api import completion
from api.schema import InvalidGraph, validate_properties


class Encounters:
    def __init__(self, occurrences):
        self.occurrences = occurrences
        self.recorded = {}
        self.calls = []
        self.activities = []

    def run(self, query, **params):
        self.calls.append((query, params))
        if 'NOT EXISTS' in query:
            assert "Encounter {area:'reading'}" in query
            return [{'id': id} for id in self.occurrences if id not in self.recorded]
        assert 'UNWIND $encounters' in query
        assert 'CREATE (e:Entity:Encounter)' in query and 'CREATE (e)-[:OCCURRED_IN]->(o)' in query
        for row in params['encounters']:
            assert row['occurrenceId'] not in self.recorded
            self.recorded[row['occurrenceId']] = row['properties']
        return []

    def create(self, concept, key, **props):
        assert concept == 'Activity', 'Encounter nodes must be created by the bounded batch'
        self.activities.append({'identityKey': key, **props})

    def link(self, *_):
        pytest.fail('Encounter relationships must be created by the bounded batch')


@pytest.mark.parametrize('count', [1, 10, 100])
def test_encounters_have_generated_properties_and_constant_query_count(count):
    tx = Encounters([f'occurrence-{i}' for i in range(count)])
    checked = []
    original = completion.validate_properties
    def validate(kind, props):
        checked.append((kind, dict(props)))
        return original(kind, props)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(completion, 'validate_properties', validate)
        completion.record_encounters(tx, 'lesson', ['placement'])
    assert len(tx.calls) == 2
    assert tx.calls[0][1] == {'id': 'lesson', 'placements': ['placement']}
    assert len(checked) == count
    assert len({props['id'] for props in tx.recorded.values()}) == count
    for occurrence, props in tx.recorded.items():
        assert UUID(props['id']).version == 4
        assert props['identityKey'] == 'encounter:reading:' + occurrence
        assert props['revision'] == 0
        assert props['createdAt'] == props['updatedAt']
        assert datetime.fromisoformat(props['createdAt']).tzinfo is not None
        assert props['area'] == 'reading' and props['evidence'] == 'reader-checkpoint'
        validate_properties('Encounter', props)
    assert tx.activities == [{'identityKey': tx.activities[0]['identityKey'],
                              'day': datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat(),
                              'kind': 'reading', 'amount': count, 'details': '{"textId":"lesson"}'}]
    assert UUID(tx.activities[0]['identityKey'].removeprefix('activity:')).version == 4


def test_empty_or_repeated_completion_does_not_write_or_double_credit():
    empty = Encounters([])
    completion.record_encounters(empty, 'empty', [])
    assert len(empty.calls) == 1 and not empty.recorded and not empty.activities
    tx = Encounters(['one', 'two'])
    completion.record_encounters(tx, 'lesson', ['placement'])
    original = dict(tx.recorded)
    # Undo leaves evidence intact. A fresh check discovers no missing rows.
    completion.record_encounters(tx, 'lesson', ['placement'])
    assert tx.recorded == original and len(tx.calls) == 3
    assert len(tx.activities) == 1 and tx.activities[0]['amount'] == 2
    tx.occurrences.append('new')
    completion.record_encounters(tx, 'lesson', ['placement'])
    assert len(tx.activities) == 2 and tx.activities[1]['amount'] == 1
    assert json.loads(tx.activities[1]['details']) == {'textId': 'lesson'}


def test_invalid_generated_encounter_properties_abort_before_the_write(monkeypatch):
    tx = Encounters(['one', 'two'])
    def reject(*_):
        raise InvalidGraph('Invalid Encounter properties')
    monkeypatch.setattr(completion, 'validate_properties', reject)
    with pytest.raises(InvalidGraph, match='Invalid Encounter'):
        completion.record_encounters(tx, 'lesson', ['placement'])
    assert len(tx.calls) == 1 and not tx.recorded and not tx.activities
