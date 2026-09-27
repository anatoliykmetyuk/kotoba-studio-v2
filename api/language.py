"""Offset-preserving Japanese analysis using the local Ichiran service."""
import re

from api import ichiran
from api.vocabulary import eligible_tokens, latin_spans


def sentences(body):
    result = []
    for match in re.finditer(r'[^。！？!?\n]+(?:[。！？!?]+[」』”）)]*)?|[。！？!?]+', body):
        raw = match.group()
        stripped = raw.strip()
        if stripped:
            start = match.start() + len(raw) - len(raw.lstrip())
            result.append({'body': stripped, 'start': start, 'end': start + len(stripped)})
    return result


def dictionary_meanings(surface, reading=''):
    return ichiran.dictionary_meanings(surface, reading)


def meanings(base, reading='', pos=''):
    # Ichiran already ranks lexical candidates and filters senses using its own
    # morphology. A caller's old POS label must not manufacture a dictionary miss.
    return dictionary_meanings(base, reading)['meanings']


def tokenize(body):
    # Mask Latin runs before analysis without altering code-point positions or
    # the text saved in the corpus. English is never sent to a dictionary lookup.
    chars = list(body)
    for start, end in latin_spans(body):
        chars[start:end] = ' ' * (end - start)
    tokens = []
    previous_end = 0
    for row in ichiran.analyze(''.join(chars)):
        start, end = row['start'], row['end']
        if not (isinstance(start, int) and isinstance(end, int) and previous_end <= start < end <= len(body)):
            raise RuntimeError('Ichiran returned invalid source offsets')
        previous_end = end
        surface = body[start:end]
        tokens.append({'surface': surface, 'start': start, 'end': end,
                       **ichiran.word_details(row['word'], surface)})
    return eligible_tokens(body, tokens)


def analyze(body):
    result = sentences(body)
    for sentence in result:
        sentence['tokens'] = tokenize(sentence['body'])
    return result


def kanji(text):
    return bool(re.search(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U000323af々〆〇]', text))
