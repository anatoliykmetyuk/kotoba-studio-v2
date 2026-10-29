"""Worker waits release the event loop and wake without idle database writes."""
import asyncio
import importlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from api.worker_queue import WorkerWakeup

api = importlib.import_module('api.app')
HEADERS = {'Authorization': 'Bearer queue-test-worker'}


def test_notification_between_scan_and_wait_is_not_lost():
    async def check():
        wakeup = WorkerWakeup()
        revision = wakeup.revision
        await asyncio.to_thread(wakeup.notify)
        await asyncio.sleep(0)
        await asyncio.wait_for(wakeup.wait(revision, 10), timeout=.2)
    asyncio.run(check())


def test_notification_wakes_all_waiters_from_another_thread():
    async def check():
        wakeup = WorkerWakeup()
        waiters = [asyncio.create_task(wakeup.wait(wakeup.revision, 10)) for _ in range(3)]
        await asyncio.sleep(0)
        await asyncio.to_thread(wakeup.notify)
        await asyncio.wait_for(asyncio.gather(*waiters), timeout=.2)
    asyncio.run(check())


@pytest.fixture
def waiting_client(monkeypatch, tmp_path):
    class EmptyGraph:
        def __init__(self):
            self.scanned = threading.Event()
            self.reads = 0
        def initialize(self):pass
        def close(self):pass
        def read(self, fn):
            self.reads += 1
            self.scanned.set()
            return fn(self)
        def run(self, *_args, **_kwargs):return []
        def write(self, *_args, **_kwargs):
            raise AssertionError('An idle claim cannot write the database')
    monkeypatch.setattr(api, 'Graph', EmptyGraph)
    monkeypatch.setenv('KOTOBA_MEDIA_DIR', str(tmp_path))
    monkeypatch.setenv('KOTOBA_WORKER_TOKEN', 'queue-test-worker')
    with TestClient(api.app) as client:
        yield client, api.app.state.graph


def test_waiting_claim_wakes_for_phrase_submission_and_does_not_block_health(waiting_client):
    client, graph = waiting_client
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(client.post, '/api/v1/worker/claim?wait=2', headers=HEADERS)
        assert graph.scanned.wait(timeout=1)
        assert client.get('/api/v1/health').status_code == 200
        start = time.monotonic()
        submitted = client.post('/api/v1/phrase-tools/translation', json={'text': '猫'})
        claimed = pending.result(timeout=1)
        assert time.monotonic() - start < 1
    assert claimed.status_code == 200
    assert claimed.json()['job']['id'] == submitted.json()['jobId']


def test_idle_wait_is_bounded_and_uses_periodic_read_only_recovery(waiting_client, monkeypatch):
    client, graph = waiting_client
    monkeypatch.setattr(WorkerWakeup, 'RESCAN_SECONDS', .02)
    start = time.monotonic()
    result = client.post('/api/v1/worker/claim?wait=.065', headers=HEADERS)
    assert result.json() == {'job': None}
    assert .06 <= time.monotonic() - start < 1
    assert 3 <= graph.reads <= 6
    before = graph.reads
    assert client.post('/api/v1/worker/claim', headers=HEADERS).json() == {'job': None}
    assert graph.reads == before + 1


def test_wait_authentication_and_bounds_are_checked_before_scanning(waiting_client):
    client, graph = waiting_client
    assert client.post('/api/v1/worker/claim?wait=25').status_code == 401
    assert client.post('/api/v1/worker/claim?wait=26', headers=HEADERS).status_code == 422
    assert client.post('/api/v1/worker/claim?wait=-1', headers=HEADERS).status_code == 422
    assert graph.reads == 0


def test_native_worker_uses_bounded_wait_without_a_post_job_sleep(monkeypatch):
    monkeypatch.setenv('KOTOBA_WORKER_TOKEN', 'queue-test-worker')
    from worker import main as worker
    stop = threading.Event()
    calls = []
    class Reply:
        def __init__(self, body):self.body = body
        def raise_for_status(self):pass
        def json(self):return self.body
    class Client:
        def post(self, url, **kwargs):
            calls.append((url, kwargs))
            if url.endswith('/claim'):
                if len(calls) == 1:
                    return Reply({'job': {'id': 'job', 'kind': 'translation', 'attempts': 1, 'payload': {}}})
                stop.set()
                return Reply({'job': None})
            return Reply({})
    monkeypatch.setattr(worker, 'CLIENT', Client())
    monkeypatch.setattr(worker, 'STOP', stop)
    monkeypatch.setattr(worker, 'perform', lambda _: {'translation': 'cat'})
    monkeypatch.setattr(worker.signal, 'signal', lambda *_: None)
    worker.main()
    assert [url.rsplit('/', 1)[-1] for url, _ in calls] == ['claim', 'complete', 'claim']
    assert calls[0][1] == {'params': {'wait': 25}}
    assert calls[2][1] == {'params': {'wait': 25}}
