"""Script-based vocabulary eligibility, independent of tokenization and dictionaries."""
import re
import unicodedata

_JAPANESE = re.compile(r'[\u3041-\u3096\u309d-\u30ff\u31f0-\u31ff\uff66-\uff9f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U0001b000-\U0001b16f\U00020000-\U000323af々〆〇]')
_JOINERS = "'’ʼ-‐‑"


def latin_letter(char):
    return unicodedata.category(char).startswith('L') and 'LATIN' in unicodedata.name(char, '')


def latin_spans(body):
    """Maximal Latin/mark/number runs, with internal apostrophes and hyphens.

    Offsets are Python Unicode code points, like corpus occurrence offsets.
    A run must contain a Latin letter; standalone numbers stay vocabulary.
    """
    def part(char):
        return latin_letter(char) or unicodedata.category(char)[0] in ('M', 'N')
    index = 0
    while index < len(body):
        if not part(body[index]):
            index += 1
            continue
        start = index
        has_latin = False
        while index < len(body):
            char = body[index]
            if part(char):
                has_latin |= latin_letter(char)
                index += 1
            elif char in _JOINERS and index + 1 < len(body) and part(body[index + 1]):
                index += 1
            else:
                break
        if has_latin:
            yield start, index


def latin_word(surface):
    """Exclude Latin spellings; retain mixed Japanese forms and UniDic lemmas."""
    has_japanese = any(_JAPANESE.fullmatch(char) and unicodedata.category(char)[0] in ('L', 'M', 'N') for char in surface)
    return not has_japanese and any(latin_letter(char) for char in surface)


def eligible_tokens(body, tokens):
    spans = list(latin_spans(body))
    return [token for token in tokens if not latin_word(token['surface']) and not any(
        start <= token['start'] < token['end'] <= end for start, end in spans)]
