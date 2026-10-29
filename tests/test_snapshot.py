"""Complete graph snapshots avoid per-record recursive driver conversions."""
import pytest

from api.graph import Tx
from api.schema import InvalidGraph, SCHEMA, validate_graph


class RawRecord(dict):
    def data(self, *args, **kwargs):
        raise AssertionError('Snapshot projections must not use Record.data()')


class AggregatedResult:
    def __init__(self, key, values):
        self.record = RawRecord({key: values})
        self.consumed = False

    def single(self, strict=False):
        assert strict, 'A snapshot must require exactly one aggregate record'
        assert not self.consumed
        self.consumed = True
        return self.record


class SnapshotTransaction:
    def __init__(self, nodes, edges):
        self.results = [AggregatedResult('nodes', nodes), AggregatedResult('edges', edges)]
        self.queries = []

    def run(self, query):
        self.queries.append(query)
        return self.results[len(self.queries) - 1]


def node(kind, id, **values):
    return {'internalId': 'internal:' + id, 'labels': ['Entity', kind], 'properties': {
        'id': id, 'identityKey': 'fixture:' + id, 'revision': 0,
        'createdAt': 'created', 'updatedAt': 'updated', **values,
    }}


def test_snapshot_retains_exact_shape_and_all_operational_records():
    nodes = [
        node('Schema', 'schema', identityKey='schema:active', digest=SCHEMA['digest'], version=SCHEMA['version']),
        node('Audit', 'audit', actor='test', action='test.snapshot', details='{}'),
        node('Mutation', 'mutation', result='{}'),
        node('Word', 'word', surface='猫', reading='ねこ', partOfSpeech='noun', family='word'),
        node('LearningStatus', 'status', state='known'),
    ]
    edges = [
        {'from': 'word', 'type': 'BASE_FORM', 'to': 'word', 'properties': {}},
        {'from': 'word', 'type': 'STATUS', 'to': 'status', 'properties': {}},
    ]
    transaction = SnapshotTransaction(nodes, edges)
    snapshot = Tx(transaction).snapshot()
    assert snapshot == {'nodes': nodes, 'edges': edges}
    assert snapshot['nodes'] is nodes and snapshot['edges'] is edges
    assert validate_graph(snapshot)['valid']
    assert len(transaction.queries) == 2
    assert transaction.queries[0] == (
        'MATCH (n) RETURN collect({internalId:elementId(n),labels:labels(n),properties:properties(n)}) AS nodes')
    assert transaction.queries[1] == (
        'MATCH (a)-[r]->(b) RETURN collect({`from`:a.id,type:type(r),`to`:b.id,properties:properties(r)}) AS edges')
    assert all(result.consumed for result in transaction.results)


def test_empty_snapshot_returns_empty_lists_and_invalidates_scalar_cache():
    transaction = SnapshotTransaction([], [])
    t = Tx(transaction, scalar_only=True)
    t._entities['cached'] = {'id': 'cached', 'revision': 0}
    assert t.snapshot() == {'nodes': [], 'edges': []}
    assert not t._entities
    assert len(transaction.queries) == 2


@pytest.mark.parametrize('nodes,edges', [
    ([{'internalId': 'invalid', 'labels': [], 'properties': {}}], []),
    ([], [{'from': None, 'type': 'UNKNOWN', 'to': None, 'properties': {'extra': True}}]),
])
def test_snapshot_does_not_filter_invalid_records_before_validation(nodes, edges):
    snapshot = Tx(SnapshotTransaction(nodes, edges)).snapshot()
    assert snapshot == {'nodes': nodes, 'edges': edges}
    with pytest.raises(InvalidGraph):
        validate_graph(snapshot)
