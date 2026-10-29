"""Ordered checkpoint batches share validation and keep per-action receipts."""
import copy
import importlib
import json
import os
from uuid import uuid4

import pytest

from api import completion, domain
from api.graph import Conflict, Missing, packed
from cli.migrate import Memory
from test_practice import client, import_lesson

api = importlib.import_module('api.app')


def change(key, start=0, end=2, completed=True):
    return {'requestId': key, 'start': start, 'end': end, 'completed': completed}


@pytest.fixture
def batch(monkeypatch):
    tx = Memory()
    tx.create('Text', 'lesson', id='lesson', body='猫。犬。', textState='new')
    calls = []
    details = []
    def checkpoint(t, id, start, end, completed, *, include_detail=True):
        assert include_detail is False
        if start == 1:raise ValueError('Checkpoints must align with sentence boundaries')
        calls.append((id, start, end, completed))
        t.update(id, completed=completed)
        return {'markedKnown': int(completed)}
    def detail(t, id):
        details.append(id)
        return dict(t.get(id))
    monkeypatch.setattr(completion, 'checkpoint', checkpoint)
    monkeypatch.setattr(domain, 'text_detail', detail)
    return tx, calls, details


def test_ordered_actions_create_compact_receipts_and_read_detail_once(batch):
    tx, calls, details = batch
    changes = [change('check'), change('undo', completed=False), change('other', start=2, end=4)]
    result = completion.checkpoints(tx, 'lesson', changes)
    assert calls == [('lesson', 0, 2, True), ('lesson', 0, 2, False), ('lesson', 2, 4, True)]
    assert details == ['lesson'] and result['markedKnown'] == 2
    for item in changes:
        assert json.loads(tx.find('mutation:' + item['requestId'])['result']) == {
            'textId': 'lesson', **{key: item[key] for key in ('start', 'end', 'completed')}}
    completion.checkpoints(tx, 'lesson', changes)
    assert len(calls) == 3 and details == ['lesson', 'lesson']


def test_existing_new_and_legacy_receipts_skip_replayed_or_regrouped_actions(batch):
    tx, calls, details = batch
    tx.create('Mutation', 'mutation:compact', result=packed({'textId': 'lesson', 'start': 0, 'end': 2, 'completed': True}))
    tx.create('Mutation', 'mutation:legacy', result=packed({'id': 'lesson', 'sentences': [], 'markedKnown': 1}))
    result = completion.checkpoints(tx, 'lesson', [change('compact', start=1), change('legacy', start=1), change('fresh')])
    assert calls == [('lesson', 0, 2, True)] and details == ['lesson'] and result['markedKnown'] == 1


@pytest.mark.parametrize('receipt', [{'textId': 'another'}, {'id': 'another'}, [], {}])
def test_receipts_must_belong_to_the_requested_text(batch, receipt):
    tx, calls, details = batch
    tx.create('Mutation', 'mutation:wrong', result=packed(receipt))
    with pytest.raises(Conflict, match='different lesson'):
        completion.checkpoints(tx, 'lesson', [change('wrong')])
    assert not calls and not details


def test_missing_or_non_text_batch_owner_is_rejected_before_actions(batch):
    tx, calls, _ = batch
    tx.create('Folder', 'folder', id='folder', name='Folder')
    with pytest.raises(Missing, match='Text not found'):
        completion.checkpoints(tx, 'folder', [change('unused')])
    assert not calls and tx.find('mutation:unused') is None


def test_api_batch_has_one_structural_transaction_and_later_failure_rolls_back(batch, monkeypatch):
    tx, calls, details = batch
    writes = []
    class Graph:
        def write(self, action, fn, *args, **kwargs):
            writes.append((action, args, kwargs))
            before = copy.deepcopy((tx.nodes, tx.keys))
            try:return fn(tx)
            except Exception:
                tx.nodes, tx.keys = before
                raise
    monkeypatch.setattr(api, 'graph', Graph)
    with pytest.raises(ValueError, match='sentence boundaries'):
        api.checkpoints('lesson', api.CheckpointBatch(changes=[change('valid'), change('invalid', start=1)]))
    assert writes == [('text.checkpoints', (), {})]
    assert tx.find('mutation:valid') is None and tx.find('mutation:invalid') is None
    assert 'completed' not in tx.get('lesson') and not details


def test_single_route_replay_of_compact_batch_receipt_still_returns_full_text(batch, monkeypatch):
    tx, _, details = batch
    class Graph:
        def write(self, *_args, **_kwargs):return {'textId': 'lesson', 'start': 0, 'end': 2, 'completed': True}
        def read(self, fn):return fn(tx)
    monkeypatch.setattr(api, 'graph', Graph)
    result = api.checkpoint('lesson', api.Checkpoint(start=0, end=2, completed=True), 'batch-action')
    assert result['id'] == 'lesson' and result['markedKnown'] == 0 and details == ['lesson']
    with pytest.raises(Conflict, match='different lesson'):
        api.checkpoint('another', api.Checkpoint(start=0, end=2, completed=True), 'batch-action')


@pytest.mark.parametrize('changes', [[], [change(str(i)) for i in range(51)], [change('')], [change('x' * 129)]])
def test_batch_request_bounds(changes):
    with pytest.raises(ValueError):api.CheckpointBatch(changes=changes)


def test_checkpoint_detail_is_optional_but_default_stays_compatible(monkeypatch):
    class Tx:
        def get(self, _):return {'type': 'Text', 'body': '猫。'}
        def run(self, *_args, **_kwargs):return [{'p': {'id': 'placement', 'start': 0, 'end': 2, 'completed': False}}]
    reads = []
    monkeypatch.setattr(domain, 'text_detail', lambda _t, id: (reads.append(id) or {'id': id, 'sentences': []}))
    assert completion.checkpoint(Tx(), 'lesson', 0, 2, False, include_detail=False) == {'markedKnown': 0}
    assert not reads
    assert completion.checkpoint(Tx(), 'lesson', 0, 2, False) == {'id': 'lesson', 'sentences': [], 'markedKnown': 0}
    assert reads == ['lesson']


@pytest.mark.skipif(os.getenv('KOTOBA_TEST_DATABASE') != 'disposable', reason='Requires the owned disposable Neo4j')
def test_live_batch_preserves_order_retry_undo_legacy_receipts_and_atomic_failure(client):
    text = import_lesson(client, 'Ordered checkpoint batch', [[('連続甲', 'れんぞくこう', 'one'), ('連続乙', 'れんぞくおつ', 'two')], [('連続丙', 'れんぞくへい', 'three')]])
    assert client.put('/api/v1/texts/' + text['id'] + '/status', json={'state': 'new'}).status_code == 200
    for sentence in text['sentences']:
        for token in sentence['tokens']:
            assert client.put('/api/v1/words/' + token['baseId'] + '/status', json={'state': 'new'}).status_code == 200
    first, second = text['sentences']
    actions = [change(str(uuid4()), first['start'], first['end']),
               change(str(uuid4()), first['start'], first['end'], False),
               change(str(uuid4()), second['start'], second['end'])]
    endpoint = '/api/v1/texts/' + text['id'] + '/checkpoints'
    result = client.post(endpoint, json={'changes': actions})
    assert result.status_code == 200, result.text
    result = result.json()
    assert [s['completed'] for s in result['sentences']] == [False, True]
    assert result['readingProgress'] == pytest.approx(1 / 3) and result['markedKnown'] == 3
    assert all(w['state'] == 'known' for s in result['sentences'] for w in s['tokens'])
    graph = api.app.state.graph
    def evidence():
        return graph.read(lambda t: t.run('''MATCH (:Text {id:$id})-[:PLACEMENT]->()-[:TOKEN]->(o)<-[:OCCURRED_IN]-(e:Encounter)
            RETURN e.id AS id ORDER BY id''', id=text['id']))
    credited = evidence()
    replay = client.post(endpoint, json={'changes': actions})
    assert replay.status_code == 200 and replay.json()['markedKnown'] == 0
    assert evidence() == credited and len(credited) == 3
    single = client.put('/api/v1/texts/' + text['id'] + '/checkpoint',
                        json={key: actions[0][key] for key in ('start', 'end', 'completed')},
                        headers={'Idempotency-Key': actions[0]['requestId']})
    assert single.status_code == 200 and [s['completed'] for s in single.json()['sentences']] == [False, True]
    legacy = str(uuid4())
    assert client.put('/api/v1/texts/' + text['id'] + '/checkpoint',
                      json={'start': second['start'], 'end': second['end'], 'completed': False},
                      headers={'Idempotency-Key': legacy}).status_code == 200
    mixed = client.post(endpoint, json={'changes': [change(legacy, 0, len(text['body'])), change(str(uuid4()), first['start'], first['end'])]})
    assert mixed.status_code == 200 and [s['completed'] for s in mixed.json()['sentences']] == [True, False]
    before = client.get('/api/v1/texts/' + text['id']).json()
    invalid = [change(str(uuid4()), second['start'], second['end']), change(str(uuid4()), 1, first['end'])]
    failed = client.post(endpoint, json={'changes': invalid})
    assert failed.status_code == 422, failed.text
    assert client.get('/api/v1/texts/' + text['id']).json() == before and evidence() == credited
    assert graph.read(lambda t: t.run('MATCH (m:Mutation) WHERE m.identityKey IN $keys RETURN m.id AS id',
                                     keys=['mutation:' + item['requestId'] for item in invalid])) == []
    other = import_lesson(client, 'Other batch owner', [[('連続他', 'れんぞくた', 'other')]])
    wrong = client.post('/api/v1/texts/' + other['id'] + '/checkpoints', json={'changes': [actions[0]]})
    assert wrong.status_code == 409
    assert client.get('/api/v1/graph/audit').json()['valid']
