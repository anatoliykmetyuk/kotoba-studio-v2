"""Scalar query budgets and real transactional races with generic graph writes."""
import json
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event

import pytest

from api.graph import Conflict, Graph, Missing, Tx
from api.schema import InvalidGraph, SCHEMA, validate_graph


def properties(id, **values):
    return {'id': id, 'identityKey': 'fixture:' + id, 'revision': 0,
            'createdAt': 'created', 'updatedAt': 'created', **values}


def row(kind, entity):
    return {'n': entity, 'labels': ['Entity', kind]}


class Record:
    def __init__(self, value):
        self.value = value

    def data(self):
        return self.value

    def __getitem__(self, key):
        return self.value[key]


class Result(list):
    def single(self, strict=False):
        if strict:
            assert len(self) == 1
        return self[0] if self else None


class ScriptedTransaction:
    def __init__(self, responses):
        self.responses = list(responses)
        self.queries = []
        self.committed = self.rolled_back = False

    def run(self, query, params=None):
        self.queries.append((query, params))
        fragment, rows = self.responses.pop(0)
        assert fragment in query
        return Result(Record(value) for value in rows)

    def commit(self):
        assert not self.responses
        self.committed = True

    def rollback(self):
        self.rolled_back = True


class Session:
    def __init__(self, transaction):
        self.transaction = transaction

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def begin_transaction(self):
        return self.transaction


def graph_using(transaction):
    graph = Graph.__new__(Graph)
    graph.driver = type('Driver', (), {'session': lambda self: Session(transaction)})()
    return graph


def locked_schema():
    return ('SET s.revision=s.revision+1', [{'schema': properties(
        'schema', identityKey='schema:active', digest=SCHEMA['digest'], version=SCHEMA['version'])}])


def test_scalar_update_reuses_reads_and_returns_actual_updated_revision():
    original = properties('status', state='new')
    updated = original | {'state': 'known', 'revision': 1, 'updatedAt': 'server timestamp'}
    transaction = ScriptedTransaction([
        locked_schema(),
        ('MATCH (n:Entity {id:$id}) RETURN', [row('LearningStatus', original)]),
        ('SET n += $p', [row('LearningStatus', updated)]),
        ('CREATE (n:Entity:Audit)', []),
    ])

    def change(t):
        local = t.get('status')
        local['revision'] = 99
        assert t.get('status')['revision'] == 0
        result = t.update('status', expected=0, state='known')
        result['state'] = 'local copy'
        assert t.get('status') == updated | {'type': 'LearningStatus'}
        with pytest.raises(Conflict):
            t.update('status', expected=0, state='new')
        return t.get('status')

    result = graph_using(transaction).write('fixture.status', change, scalar_only=True)
    assert result == updated | {'type': 'LearningStatus'}
    assert transaction.committed and not transaction.rolled_back
    # One lock/schema check, one entity read, one update, one audit insert.
    assert len(transaction.queries) == 4


def test_find_and_create_prime_scalar_cache_without_changing_find_result():
    settings = properties('settings', payload='{}')
    transaction = ScriptedTransaction([
        ('identityKey:$key', [row('Settings', settings)]),
        ('identityKey:$key', []),
        ('CREATE (n:Entity:Settings)', []),
    ])
    t = Tx(transaction, scalar_only=True)
    found = t.find(settings['identityKey'])
    assert found == settings and 'type' not in found
    found['revision'] = 999
    assert t.get('settings')['revision'] == 0
    created = t.create('Settings', 'fixture:other', id='other', payload='{}')
    assert t.get(created['id']) == created | {'type': 'Settings'}
    created['payload'] = 'callback-local edit'
    assert t.get('other')['payload'] == '{}'
    assert not transaction.responses


def test_public_queries_invalidate_cached_entities():
    original = properties('status', state='new')
    newer = original | {'state': 'learning', 'revision': 1}
    transaction = ScriptedTransaction([
        ('MATCH (n:Entity {id:$id}) RETURN', [row('LearningStatus', original)]),
        ('RETURN 1 AS ok', [{'ok': 1}]),
        ('MATCH (n:Entity {id:$id}) RETURN', [row('LearningStatus', newer)]),
        ('SET n.state=$state', []),
        ('MATCH (n:Entity {id:$id}) RETURN', [row('LearningStatus', newer | {'revision': 2})]),
    ])
    t = Tx(transaction, scalar_only=True)
    assert t.get('status')['revision'] == 0
    t.run('RETURN 1 AS ok')
    assert t.get('status')['revision'] == 1
    # Generic graph transactions may execute arbitrary mutations, then helpers.
    t.scalar_only = False
    t.run('MATCH (n:LearningStatus {id:$id}) SET n.state=$state', id='status', state='learning')
    t.scalar_only = True
    assert t.get('status')['revision'] == 2
    assert not transaction.responses


def test_scalar_validation_rejects_invalid_properties_and_graph_mutations():
    transaction = ScriptedTransaction([
        ('MATCH (n:Entity {id:$id}) RETURN', [row('LearningStatus', properties('status', state='new'))]),
    ])
    t = Tx(transaction, scalar_only=True)
    for values in ({'state': 'unknown'}, {'revision': 9}, {'identityKey': 'replaced'}, {'family': 'other'}):
        with pytest.raises(InvalidGraph):
            t.update('status', **values)
    with pytest.raises(InvalidGraph):
        t.create('Word', 'forbidden')
    with pytest.raises(InvalidGraph):
        t.run('MATCH (n) DETACH DELETE n')
    assert len(transaction.queries) == 1


@pytest.mark.parametrize('schema', [None, {'digest': 'different'}])
def test_schema_mismatch_rolls_back_before_callback(schema):
    transaction = ScriptedTransaction([
        ('SET s.revision=s.revision+1', [] if schema is None else [{'schema': schema}]),
    ])
    with pytest.raises(InvalidGraph):
        graph_using(transaction).write('fixture', lambda t: pytest.fail('Callback must not run'), scalar_only=True)
    assert transaction.rolled_back and not transaction.committed


def test_idempotent_replay_does_not_update_entity_or_append_audit():
    result = {'id': 'status', 'state': 'known', 'revision': 1}
    transaction = ScriptedTransaction([
        locked_schema(),
        ('identityKey:$key', [row('Mutation', properties('mutation', result=json.dumps(result)))]),
    ])
    actual = graph_using(transaction).write('fixture', lambda t: pytest.fail('Callback must not run'),
                                            request_id='same', scalar_only=True)
    assert actual == result
    assert transaction.rolled_back and not transaction.committed
    assert not transaction.responses


@pytest.mark.parametrize('dry_run', [False, True])
def test_new_request_checks_identity_once_and_preserves_dry_run(dry_run):
    transaction = ScriptedTransaction([
        locked_schema(),
        ('identityKey:$key', []),
        ('CREATE (n:Entity:Mutation)', []),
        ('CREATE (n:Entity:Audit)', []),
    ])
    result = graph_using(transaction).write('fixture', lambda t: {'ok': True}, request_id='new',
                                            scalar_only=True, dry_run=dry_run)
    assert result == {'ok': True}
    assert transaction.committed is not dry_run
    assert transaction.rolled_back is dry_run
    assert not transaction.responses
    assert len(transaction.queries) == 4


def test_generic_writes_still_validate_complete_graph_and_rollback():
    transaction = ScriptedTransaction([
        locked_schema(),
        ('CREATE (n:Unknown)', []),
        ('CREATE (n:Entity:Audit)', []),
        ('elementId(n)', [{'nodes': [{'internalId': 'bad', 'labels': ['Unknown'], 'properties': {}}]}]),
        ('MATCH (a)-[r]->(b)', [{'edges': []}]),
    ])
    with pytest.raises(InvalidGraph):
        graph_using(transaction).write('fixture.structural', lambda t: t.run('CREATE (n:Unknown)'))
    assert transaction.rolled_back and not transaction.committed
    assert not transaction.responses


@pytest.fixture(scope='module')
def live_graph():
    if os.getenv('KOTOBA_TEST_DATABASE') != 'disposable':
        pytest.fail('Set KOTOBA_TEST_DATABASE=disposable with the isolated Neo4j database')
    assert os.getenv('NEO4J_URI', 'bolt://127.0.0.1:17687') == 'bolt://127.0.0.1:17687'
    graph = Graph()
    with graph.driver.session() as session:
        session.run('MATCH (n) DETACH DELETE n').consume()
    graph.initialize()
    yield graph
    graph.close()


def seed_status(graph):
    key = str(uuid.uuid4())

    def seed(t):
        word = t.create('Word', 'fixture:word:' + key, id=key, surface='試験' + key,
                        reading='しけん', partOfSpeech='noun', family=key)
        status = t.create('LearningStatus', 'fixture:status:' + key, state='new')
        t.link(word['id'], 'BASE_FORM', word['id'])
        t.link(word['id'], 'STATUS', status['id'])
        return word, status

    return graph.write('fixture.seed', seed)


def race(*operations):
    start = Barrier(len(operations))

    def run(operation):
        start.wait(timeout=10)
        try:
            return operation()
        except (Conflict, Missing) as error:
            return error

    with ThreadPoolExecutor(max_workers=len(operations)) as pool:
        return list(pool.map(run, operations))


def test_live_same_revision_scalar_updates_commit_once(live_graph):
    _, status = seed_status(live_graph)
    first_entered, second_started, second_entered, release = (Event() for _ in range(4))

    def first_change(t):
        first_entered.set()
        assert release.wait(timeout=10)
        return t.update(status['id'], expected=0, state='learning')

    def second_change(t):
        second_entered.set()
        return t.update(status['id'], expected=0, state='known')

    def second_write():
        second_started.set()
        return live_graph.write('fixture.concurrent.status', second_change, scalar_only=True)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(live_graph.write, 'fixture.concurrent.status', first_change, scalar_only=True)
        try:
            assert first_entered.wait(timeout=10)
            second = pool.submit(second_write)
            assert second_started.wait(timeout=10)
            # A second writer must wait before its read/revision check, rather
            # than reading revision 0 then waiting only for the entity SET.
            assert not second_entered.wait(timeout=.2)
        finally:
            release.set()
        assert first.result(timeout=10)['revision'] == 1
        with pytest.raises(Conflict):
            second.result(timeout=10)
    assert second_entered.is_set()
    assert live_graph.read(lambda t: t.get(status['id']))['revision'] == 1
    assert live_graph.read(lambda t: validate_graph(t.snapshot()))['valid']


def test_live_concurrent_idempotency_records_one_mutation_and_audit(live_graph):
    _, status = seed_status(live_graph)
    request_id = str(uuid.uuid4())

    def write():
        return live_graph.write('fixture.concurrent.idempotency',
            lambda t: t.update(status['id'], state='known'), request_id=request_id, scalar_only=True)

    results = race(write, write)
    assert results[0] == results[1]
    assert results[0]['revision'] == 1
    assert live_graph.read(lambda t: t.get(status['id']))['revision'] == 1
    audits = live_graph.read(lambda t: t.run(
        'MATCH (a:Audit {action:$action}) RETURN a.details AS details', action='fixture.concurrent.idempotency'))
    assert sum(json.loads(audit['details'])['requestId'] == request_id for audit in audits) == 1
    assert live_graph.read(lambda t: validate_graph(t.snapshot()))['valid']


def test_live_generic_delete_and_scalar_revision_check_remain_serialized(live_graph):
    word, status = seed_status(live_graph)
    results = race(
        lambda: live_graph.write('fixture.concurrent.scalar',
            lambda t: t.update(status['id'], expected=0, state='known'), scalar_only=True),
        lambda: live_graph.raw_write([{'query': '''MATCH (w:Word {id:$word})-[:STATUS]->(s)
            DETACH DELETE w,s RETURN $word AS id''', 'params': {'word': word['id']}}],
            expected_revisions={status['id']: 0}),
    )
    assert len([result for result in results if isinstance(result, (Conflict, Missing))]) == 1
    assert live_graph.read(lambda t: validate_graph(t.snapshot()))['valid']
