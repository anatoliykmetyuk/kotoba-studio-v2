"""Real graph boundaries for explicitly requested popup examples and worker wakeups."""
import threading
from concurrent.futures import ThreadPoolExecutor

from api import domain
from api.app import app
from api.graph import Tx
from test_api import client


def test_word_examples_are_explicit_family_scoped_deduplicated_and_bounded(client, monkeypatch):
    sentences = []
    offset = 0
    for i, body in enumerate(['読む。'] + ['読んだ読んだ。'] * 55):
        surface = '読む' if i == 0 else '読んだ'
        tokens = []
        for start in ([0] if i == 0 else [0, 3]):
            tokens.append({'surface': surface, 'reading': surface, 'baseReading': 'よむ',
                           'partOfSpeech': 'verb', 'start': start, 'end': start + len(surface),
                           'selected': {'base': '読む', 'baseReading': 'よむ'},
                           'meanings': [{'meaning': 'to read', 'base': '読む', 'sourceType': 'JMdict', 'sense': 'jmdict:42:0'}]})
        sentences.append({'body': body, 'start': offset, 'end': offset + len(body), 'tokens': tokens})
        offset += len(body)
    body = ''.join(s['body'] for s in sentences)
    saved = app.state.graph.write('test.examples', lambda t: domain.finalize_import(
        t, {'title': 'Explicit examples fixture', 'body': body}, {'sentences': sentences}))
    text = client.get('/api/v1/texts/' + saved['textId']).json()
    base_id = text['sentences'][0]['tokens'][0]['baseId']
    form_id = text['sentences'][1]['tokens'][0]['wordId']
    client.put('/api/v1/words/' + base_id + '/status', json={'state': 'known'})
    before = app.state.graph.read(lambda t: t.snapshot())
    queries = []
    run = Tx.run
    def record(tx, query, **params):
        queries.append(query)
        return run(tx, query, **params)
    monkeypatch.setattr(Tx, 'run', record)
    core = client.get('/api/v1/words/' + form_id)
    assert core.status_code == 200, core.text
    core = core.json()
    assert len(queries) == 1 and ':PLACEMENT' not in queries[0] and ':TOKEN' not in queries[0]
    assert core['examples'] == [] and core['status']['state'] == 'known'
    assert core['base']['id'] == base_id and core['base']['type'] == 'Word'
    assert {w['surface'] for w in core['forms']} == {'読む', '読んだ'}
    assert core['meanings'] and core['meaning'] == 'to read'
    base = client.get('/api/v1/words/' + base_id + '/examples')
    form = client.get('/api/v1/words/' + form_id + '/examples')
    assert base.status_code == form.status_code == 200
    assert base.json() == form.json()
    examples = form.json()['examples']
    assert len(examples) == 50
    assert [e['start'] for e in examples] == [s['start'] for s in sentences[:50]]
    assert len({e['occurrenceId'] for e in examples}) == 50
    assert set(examples[0]) == {'textId', 'title', 'textState', 'sentenceId', 'occurrenceId', 'body', 'start', 'seen'}
    assert examples[0]['body'] == '読む。' and examples[1]['body'] == '読んだ読んだ。'
    assert all(e['textId'] == saved['textId'] and e['seen'] is False for e in examples)
    assert client.get('/api/v1/words/' + saved['textId'] + '/examples').status_code == 404
    assert client.get('/api/v1/words/absent/examples').status_code == 404
    assert app.state.graph.read(lambda t: t.snapshot()) == before


def test_waiting_worker_wakes_after_durable_import_commit_and_keeps_fifo(client, monkeypatch):
    graph = app.state.graph
    scanned = threading.Event()
    read = graph.read
    def observed(fn):
        result = read(fn)
        if fn.__name__ == 'candidates' and not result:
            scanned.set()
        return result
    monkeypatch.setattr(graph, 'read', observed)
    headers = {'Authorization': 'Bearer api-test-worker'}
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.post, '/api/v1/worker/claim?wait=2', headers=headers)
        assert scanned.wait(timeout=1)
        submitted = client.post('/api/v1/imports', json={'title': 'Wake fixture', 'body': 'worker wake fixture'})
        assert submitted.status_code == 202
        claimed = pending.result(timeout=1)
    assert claimed.status_code == 200
    first = claimed.json()['job']
    assert first['id'] == submitted.json()['jobId'] and first['attempts'] == 1
    assert client.post('/api/v1/worker/' + first['id'] + '/complete', headers=headers,
                       json={'attempt': first['attempts'], 'result': {'sentences': []}}).status_code == 200
    older = client.post('/api/v1/imports', json={'title': 'Older import', 'body': 'older worker fifo fixture'}).json()['jobId']
    newer = client.post('/api/v1/phrase-tools/translation', json={'text': '猫'}).json()['jobId']
    assert client.post('/api/v1/worker/claim', headers=headers).json()['job']['id'] == older
    assert client.post('/api/v1/worker/' + older + '/complete', headers=headers,
                       json={'attempt': 1, 'result': {'sentences': []}}).status_code == 200
    assert client.post('/api/v1/worker/claim', headers=headers).json()['job']['id'] == newer
    assert client.post('/api/v1/worker/' + newer + '/complete', headers=headers,
                       json={'attempt': 1, 'result': {'translation': 'cat'}}).status_code == 200
