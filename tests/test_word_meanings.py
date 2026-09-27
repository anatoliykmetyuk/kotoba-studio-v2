"""Dictionary absence is the only condition permitting lazy word inference."""
import pytest


@pytest.fixture
def worker(monkeypatch):
    monkeypatch.setenv('KOTOBA_WORKER_TOKEN','test-word-meaning-worker')
    from worker import main
    return main


def meaning_job():
    return {'kind':'word-meaning','payload':{'wordId':'test-word','text':'甘め','reading':'あまめ','partOfSpeech':'名詞'}}


def test_word_dictionary_precedes_inference_and_ignores_pos_filter(worker,monkeypatch):
    from api import language
    choices=[{'meaning':'slightly sweet','sourceType':'JMdict','sense':'jmdict:123:0'}]
    calls=[]
    def lookup(surface,reading):
        calls.append((surface,reading));return {'found':True,'meanings':choices}
    monkeypatch.setattr(language,'dictionary_meanings',lookup,raising=False)
    monkeypatch.setattr(worker,'generate',lambda *_:pytest.fail('Existing dictionary entry must not invoke the model'))
    assert worker.perform(meaning_job())=={'meanings':choices}
    assert calls==[('甘め','あまめ')]


@pytest.mark.parametrize('failure',['empty','unavailable'])
def test_word_dictionary_empty_gloss_or_failure_never_means_missing(worker,monkeypatch,failure):
    from api import language
    def lookup(*_):
        if failure=='unavailable':raise RuntimeError('dictionary unavailable')
        return {'found':True,'meanings':[]}
    monkeypatch.setattr(language,'dictionary_meanings',lookup,raising=False)
    monkeypatch.setattr(worker,'generate',lambda *_:pytest.fail('Only a true dictionary miss permits inference'))
    with pytest.raises((ValueError,RuntimeError)):worker.perform(meaning_job())


def test_word_true_dictionary_miss_uses_existing_local_model_with_provenance(worker,monkeypatch):
    from api import language
    monkeypatch.setattr(language,'dictionary_meanings',lambda *_:{'found':False,'meanings':[]},raising=False)
    requests=[]
    def generate(system,payload,schema):
        requests.append((system,payload,schema));return {'meaning':' somewhat sweet '}
    monkeypatch.setattr(worker,'generate',generate)
    result=worker.perform(meaning_job())
    assert result=={'meanings':[{'meaning':'somewhat sweet','baseReading':'あまめ','partOfSpeech':'名詞',
                                'sourceType':'local-model','sense':f'local-model:{worker.MODEL}:test-word'}]}
    assert len(requests)==1 and requests[0][1]=={'text':'甘め','reading':'あまめ','partOfSpeech':'名詞'}


@pytest.mark.parametrize('meaning',['','   ',None,42,'x'*2001])
def test_invalid_generated_word_meaning_is_not_accepted(worker,monkeypatch,meaning):
    from api import language
    monkeypatch.setattr(language,'dictionary_meanings',lambda *_:{'found':False,'meanings':[]},raising=False)
    monkeypatch.setattr(worker,'generate',lambda *_:{'meaning':meaning})
    with pytest.raises(ValueError,match='Invalid generated word meaning'):worker.perform(meaning_job())
