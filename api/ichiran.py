"""Transport and data adaptation for the pinned, local Ichiran dictionary service.

The adapter never invents segment boundaries or conjugation rules. Source spans,
ranked analyses, and conjugation roots all come from Ichiran.
"""
import copy
import hashlib
import os
import threading
import unicodedata
from functools import lru_cache

import httpx
import jaconv

_local = threading.local()


def _request(path, text):
    url = os.getenv('KOTOBA_ICHIRAN_URL', 'http://127.0.0.1:'+os.getenv('KOTOBA_ICHIRAN_PORT','8091')).rstrip('/')
    if not hasattr(_local, 'client'):
        _local.client = httpx.Client(timeout=httpx.Timeout(120, connect=5), trust_env=False)
    try:
        response = _local.client.post(url + path, json={'text': text})
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise RuntimeError(f'Local Ichiran service unavailable or invalid at {url}: {error}') from error


@lru_cache(maxsize=1024)
def analyze(text):
    result = _request('/analyze', text)
    rows = result.get('tokens') if isinstance(result, dict) else None
    if not isinstance(rows, list):
        raise RuntimeError('Invalid Ichiran token response')
    return rows


@lru_cache(maxsize=16000)
def lookup(text):
    result = _request('/dictionary', text)
    entries = result.get('entries') if isinstance(result, dict) else None
    if not isinstance(entries, list):
        raise RuntimeError('Invalid Ichiran dictionary response')
    return entries


def kana(value):
    if isinstance(value, list):
        value = value[0] if value else ''
    return jaconv.kata2hira(''.join(c for c in (value or '') if not c.isspace() and unicodedata.category(c) != 'Cf'))


def reading_parts(value):
    """Ichiran's public gloss format uses `spelling 【reading】`."""
    spelling, separator, reading = (value or '').partition(' 【')
    return spelling, kana(reading.rstrip('】') if separator else spelling)


def alternatives(word):
    return word.get('alternative') or [word]


def roots(word):
    """Yield upstream conjugation roots, including chains such as passive/past."""
    for conjugation in word.get('conj') or word.get('via') or []:
        if conjugation.get('via'):
            yield from roots(conjugation)
        elif conjugation.get('reading'):
            yield conjugation


def lexical_head(word):
    """Follow Ichiran's primary component, never guess from Japanese endings."""
    word = alternatives(word)[0]
    if word.get('components'):
        primary = next((part for part in word['components'] if part.get('primary')), None)
        if primary is None:
            raise RuntimeError('Ichiran compound is missing its primary lexical component')
        return lexical_head(primary)
    return word


def word_details(word, surface):
    variants = alternatives(word)
    primary = variants[0]
    reading = kana(primary.get('kana'))
    # A direct dictionary headword (including expressions such as にとって)
    # retains its exact spelling. Only upstream conjugations change the base.
    head = lexical_head(primary)
    original = next(roots(head), None) if not head.get('gloss') else None
    if original:
        base, base_reading = reading_parts(original['reading'])
    elif head is not primary:
        base, base_reading = head['text'], kana(head.get('kana'))
    else:
        base, base_reading = surface, reading
    choices = []
    for variant in variants:
        head = lexical_head(variant)
        sources = [head] if head.get('gloss') else list(roots(head))
        for source in sources:
            source_base, source_reading = reading_parts(source.get('reading'))
            # Direct headwords retain the exact source spelling, including
            # upstream-normalized kana. Conjugation roots keep their own lemma.
            if source is head:
                source_base = surface if head is variant else head.get('text', source_base)
            source_base = source_base or head.get('text', surface)
            source_reading = source_reading or kana(source.get('kana'))
            for ordinal, sense in enumerate(source.get('gloss') or []):
                gloss = sense.get('gloss', '').strip()
                if not gloss:
                    continue
                pos = sense.get('pos', '').strip('[]')
                key = hashlib.sha256((source_base + '\0' + pos + '\0' + gloss).encode()).hexdigest()
                sense_key = f"jmdict:{source['seq']}:{sense.get('ordinal', ordinal)}" if isinstance(source.get('seq'), int) else 'ichiran:jmdict:' + key
                choices.append({'sense': sense_key, 'meaning': gloss,
                                'base': source_base, 'baseReading': source_reading,
                                'partOfSpeech': pos, 'sourceType': 'JMdict'})
    unique = {}
    for choice in choices:
        unique.setdefault(choice['sense'], choice)
    return {'base': base, 'reading': reading, 'baseReading': base_reading,
            'partOfSpeech': choices[0]['partOfSpeech'] if choices else 'unknown',
            'choices': list(unique.values())}


def dictionary_meanings(surface, reading=''):
    entries = lookup(surface)
    # Reading is a ranking hint, never evidence that a dictionary entry is absent.
    ranked = sorted(entries, key=lambda entry: kana(entry.get('kana')) != kana(reading)) if reading else entries
    choices = [choice for entry in ranked
               for choice in word_details(entry, surface)['choices']]
    unique = {}
    for choice in choices:
        unique.setdefault(choice['sense'], choice)
    return {'found': bool(entries), 'meanings': copy.deepcopy(list(unique.values()))}
