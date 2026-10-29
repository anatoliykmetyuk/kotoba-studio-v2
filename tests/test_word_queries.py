"""Popup reads stay independent of the size of the corpus."""
import pytest

from api import domain
from api.graph import Missing
from api.schema import InvalidGraph


class Read:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def run(self, query, **params):
        self.calls.append((query, params))
        return self.rows


def test_core_word_details_preserve_fields_without_reading_examples():
    word = {'id': 'form', 'family': 'base', 'surface': '読んだ', 'revision': 4}
    base = {'id': 'base', 'family': 'base', 'surface': '読む', 'revision': 2}
    meanings = [{'id': 'form-sense', 'body': 'read'}, {'id': 'base-sense', 'body': 'to read'}]
    status = {'id': 'status', 'state': 'known', 'revision': 8}
    forms = [word, base]
    tx = Read([{'word': word, 'base': base, 'meanings': meanings, 'forms': forms, 'statuses': [status]}])
    detail = domain.word_detail(tx, 'form')
    assert detail == word | {'type': 'Word', 'base': base | {'type': 'Word'},
                             'meaning': 'read; to read', 'meanings': meanings,
                             'forms': forms, 'status': status,
                             'statuses': {'reading': status, 'listening': status}, 'examples': []}
    assert len(tx.calls) == 1 and tx.calls[0][1] == {'id': 'form'}
    assert all(term not in tx.calls[0][0] for term in (':PLACEMENT', ':TOKEN', ':Text', 'COUNT'))


@pytest.mark.parametrize('statuses', [[], [{'state': 'new'}, {'state': 'known'}]])
def test_core_word_details_require_the_single_shared_status(statuses):
    tx = Read([{'word': {}, 'base': {}, 'meanings': [], 'forms': [], 'statuses': statuses}])
    with pytest.raises(InvalidGraph, match='one learning status'):
        domain.word_detail(tx, 'word')


@pytest.mark.parametrize('read', [domain.word_detail, domain.word_examples])
def test_missing_or_non_word_identifiers_are_rejected(read):
    with pytest.raises(Missing, match='Word not found'):
        read(Read([]), 'absent')


def test_explicit_examples_keep_existing_shape_and_empty_family_result():
    example = {'textId': 'lesson', 'title': 'Reading', 'textState': 'new', 'sentenceId': 'sentence',
               'occurrenceId': 'placement', 'body': '読む。', 'start': 0, 'seen': False}
    tx = Read([{'examples': [example]}])
    assert domain.word_examples(tx, 'form') == [example]
    assert len(tx.calls) == 1 and tx.calls[0][1] == {'id': 'form'}
    assert domain.word_examples(Read([{'examples': []}]), 'base') == []
