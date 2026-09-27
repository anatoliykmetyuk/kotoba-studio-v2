"""Opt-in real dictionary/model round trip against the disposable graph."""
import os
import time

import pytest
from api.app import app
from api import domain,language
from test_api import client

pytestmark=pytest.mark.skipif(os.getenv('KOTOBA_LIVE_MODELS')!='1',reason='Requires the running local dictionary and Qwen')


def test_actual_dictionary_and_model_fallback_are_persisted(client):
    from worker import main as worker
    assert language.dictionary_meanings('甘め','あまめ')['found'] is True
    headers={'Authorization':'Bearer api-test-worker'}
    for surface,reading,source in [('甘め','あまめ','JMdict'),('萼片','がくへん','JMdict'),('猫語通信端末','ねこごつうしんたんまつ','local-model')]:
        def create(t):
            token={'surface':surface,'reading':reading,'baseReading':reading,'partOfSpeech':'noun'}
            return domain.family(t,token,{'base':surface,'baseReading':reading})
        word=app.state.graph.write('test.live-meaning-fixture',create)
        route='/api/v1/words/'+word['id']+'/meanings'
        before=client.get('/api/v1/words/'+word['id']).json()['meanings']
        if before:
            assert all(m['sourceType']==source for m in before)
            assert client.post(route).json()['cached'] is True
            continue
        lookup=language.dictionary_meanings(surface,reading)
        assert lookup['found'] is (source=='JMdict')
        pending=client.post(route);assert pending.status_code==202,pending.text
        job=client.post('/api/v1/worker/claim',headers=headers).json()['job']
        assert job['id']==pending.json()['jobId']
        started=time.monotonic();result=worker.perform(job)
        completed=client.post('/api/v1/worker/'+job['id']+'/complete',headers=headers,
                              json={'attempt':job['attempts'],'result':result})
        assert completed.status_code==200,completed.text
        meanings=completed.json()['meanings'];assert meanings
        assert all(m['sourceType']==source and m['body'].strip() for m in meanings)
        snapshot=client.get('/api/v1/graph/export').json()
        cached=client.post(route);assert cached.status_code==200 and cached.json()['cached'] is True
        assert cached.json()['meanings']==meanings
        assert client.get('/api/v1/graph/export').json()==snapshot
        print(f'{surface}: {source}, {len(meanings)} meanings, {time.monotonic()-started:.2f}s, subsequent call cached')
    assert client.get('/api/v1/graph/audit').status_code==200
