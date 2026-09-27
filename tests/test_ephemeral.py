import base64
from concurrent.futures import ThreadPoolExecutor

import pytest

from api.ephemeral import Capacity, PhraseJobs
from api.graph import Conflict, Missing


def queue():
    current = [0.0]
    return PhraseJobs(clock=lambda: current[0]), current


def test_phrase_jobs_are_fresh_and_results_expire():
    jobs, current = queue()
    first = jobs.submit('translation', {'text': '猫', 'context': '猫です。'})['jobId']
    second = jobs.submit('translation', {'text': '猫', 'context': '猫です。'})['jobId']
    assert first != second
    job = jobs.claim()
    assert job['id'] == first and job['payload']['context'] == '猫です。'
    jobs.complete(first, job['attempts'], {'translation': 'cat'})
    assert jobs.view(first)['result'] == {'translation': 'cat'}
    assert jobs.entries[first]['job']['payload'] == '{}'
    assert jobs.claim()['id'] == second
    current[0] += jobs.RESULT_SECONDS
    jobs.cleanup()
    with pytest.raises(Missing):
        jobs.view(first)
    assert jobs.view(second)['state'] == 'failed'
    assert 'timed out' in jobs.view(second)['error']


def test_pending_expiration_and_lease_cannot_run_forever():
    jobs, current = queue()
    id = jobs.submit('translation', {'text': '猫'})['jobId']
    current[0] = jobs.REQUEST_SECONDS
    assert jobs.view(id)['state'] == 'failed'
    assert jobs.claim() is None
    current[0] += jobs.RESULT_SECONDS
    jobs.cleanup()
    assert not jobs.entries

    id = jobs.submit('translation', {'text': '犬'})['jobId']
    job = jobs.claim()
    for _ in range(5):
        current[0] += 100
        jobs.heartbeat(id, job['attempts'])
    current[0] += 100
    assert jobs.view(id)['state'] == 'failed'
    with pytest.raises(Conflict):
        jobs.complete(id, job['attempts'], {'translation': 'late'})


def test_bounded_queue_audio_and_invalid_completion_release_resources():
    jobs, current = queue()
    jobs.MAX_ACTIVE = 1
    jobs.MAX_JOBS = 2
    first = jobs.submit('translation', {'text': '猫'})['jobId']
    with pytest.raises(Capacity):
        jobs.submit('translation', {'text': '猫'})
    jobs.claim()
    assert jobs.complete(first, 1, {'translation': ''}) == {'state': 'failed'}
    assert jobs.view(first)['state'] == 'failed'
    second = jobs.submit('speech', {'text': '猫'})['jobId']
    jobs.claim()
    audio = b'RIFF0000WAVE' + b'x' * 80
    jobs.complete(second, 1, {'audio': base64.b64encode(audio).decode()})
    assert jobs.audio_bytes == len(audio)
    assert jobs.audio(second) == audio
    with pytest.raises(Capacity):
        jobs.submit('translation', {'text': '猫'})
    current[0] += jobs.RESULT_SECONDS
    jobs.cleanup()
    assert jobs.audio_bytes == 0 and not jobs.entries

    jobs.MAX_AUDIO = 16
    id = jobs.submit('speech', {'text': '猫'})['jobId']
    jobs.claim()
    assert jobs.complete(id, 1, {'audio': base64.b64encode(audio).decode()}) == {'state': 'failed'}
    assert jobs.audio_bytes == 0


def test_atomic_claim_and_stale_attempts():
    jobs, current = queue()
    id = jobs.submit('translation', {'text': '猫'})['jobId']
    with ThreadPoolExecutor(max_workers=8) as pool:
        claimed = list(pool.map(lambda _: jobs.claim(), range(8)))
    assert len([j for j in claimed if j]) == 1
    with pytest.raises(Conflict):
        jobs.complete(id, 2, {'translation': 'wrong attempt'})
    jobs.cancel(id)
    assert jobs.view(id)['state'] == 'failed'
    with pytest.raises(Conflict):
        jobs.heartbeat(id, 1)
