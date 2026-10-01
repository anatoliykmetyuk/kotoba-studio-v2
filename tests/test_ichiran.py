"""Adapter regressions and live tests against the pinned local Ichiran service."""
import pytest

from api import ichiran, language


def test_live_inflections_and_dictionary_expression():
    examples = [
        ('猫は食べた。', '食べた', '食べる', 'たべる'),
        ('私にとって大切です。', 'にとって', 'にとって', 'にとって'),
        ('明日の予定はもう決めてる。', '決めてる', '決める', 'きめる'),
        ('お互いに譲り合ってても難しい。', '譲り合ってても', '譲り合う', 'ゆずりあう'),
    ]
    for body, surface, base, reading in examples:
        tokens = language.tokenize(body)
        token = next(token for token in tokens if token['surface'] == surface)
        assert (token['base'], token['baseReading']) == (base, reading)
        assert token['choices'] and all(c['sourceType'] == 'JMdict' for c in token['choices'])
        assert all(body[token['start']:token['end']] == token['surface'] for token in tokens)
    assert not {'決め', 'てる'} & {token['surface'] for token in language.tokenize(examples[2][0])}
    assert not {'とっ', 'て'} & {token['surface'] for token in language.tokenize(examples[1][0])}


def test_live_normalization_preserves_spelling_and_original_offsets():
    body = '😀「ｶﾞｯｺｳ、猫。」 ABX48 ＡＢＸ４８ Sam’s café café 私にとって大切。'
    tokens = language.tokenize(body)
    assert {'ｶﾞｯｺｳ', '猫', '私', 'にとって', '大切'} <= {t['surface'] for t in tokens}
    assert all(body[t['start']:t['end']] == t['surface'] for t in tokens)
    assert all(not any(a <= t['start'] < t['end'] <= b for a, b in language.latin_spans(body)) for t in tokens)
    school = next(t for t in tokens if t['surface'] == 'ｶﾞｯｺｳ')
    assert school['base'] == 'ｶﾞｯｺｳ' and school['reading'] == 'がっこう'
    assert school['choices'] and all(c['base'] == 'ｶﾞｯｺｳ' for c in school['choices'])
    assert language.tokenize('Sam’s mug ABX48 ＡＢＸ４８ café') == []


def test_live_dictionary_presence_ignores_bad_reading_and_pos():
    known = language.dictionary_meanings('にとって', 'incorrect-reading')
    assert known['found'] and known['meanings']
    assert language.meanings('にとって', '', '名詞')
    assert language.dictionary_meanings('あいうえおかきくけこさしすせそ') == {'found': False, 'meanings': []}
    assert language.dictionary_meanings('甘め', 'あまめ')['found']


@pytest.mark.parametrize('payload', [{}, {'entries': None}, {'entries': {}}, [], None])
def test_malformed_dictionary_response_is_never_a_miss(monkeypatch, payload):
    ichiran.lookup.cache_clear()
    monkeypatch.setattr(ichiran, '_request', lambda *args: payload)
    with pytest.raises(RuntimeError, match='Invalid Ichiran dictionary response'):
        language.dictionary_meanings('test-invalid-response')
    ichiran.lookup.cache_clear()


def test_dictionary_entry_without_gloss_is_found(monkeypatch):
    monkeypatch.setattr(ichiran, 'lookup', lambda _: [{'text': '未知', 'kana': 'みち'}])
    assert language.dictionary_meanings('未知') == {'found': True, 'meanings': []}


def test_compound_head_must_come_from_upstream_metadata():
    with pytest.raises(RuntimeError, match='primary lexical component'):
        ichiran.word_details({'text': '決めてる', 'components': [{'text': '決めて'}]}, '決めてる')


def test_offset_mismatch_fails_instead_of_silently_realigning(monkeypatch):
    monkeypatch.setattr(ichiran, 'analyze', lambda _: [{'start': -1, 'end': 3, 'word': {}}])
    with pytest.raises(RuntimeError, match='source offsets'):
        language.tokenize('食べた')


def test_live_sense_identity_and_order_follow_jmdict_for_base_and_inflection():
    box = language.tokenize('箱')[0]
    assert [choice['sense'] for choice in box['choices']] == [f'jmdict:1585650:{i}' for i in range(7)]
    assert box['choices'][0]['meaning'].startswith('box;')
    inflected = language.tokenize('食べた')[0]['choices']
    base = language.dictionary_meanings('食べる', 'たべる')['meanings']
    assert [choice['sense'] for choice in inflected] == [choice['sense'] for choice in base]


@pytest.mark.parametrize('surface,expected', [
    ('行った', {'1589060': ('行う', 'おこなう'), '1578850': ('行く', 'いく')}),
    ('開いた', {'1202440': ('開く', 'ひらく'), '1586270': ('開く', 'あく')}),
])
def test_live_alternative_senses_preserve_their_own_lemma_and_reading(surface, expected):
    choices = language.tokenize(surface)[0]['choices']
    assert {c['sense'].split(':')[1] for c in choices} == set(expected)
    for choice in choices:
        assert (choice['base'], choice['baseReading']) == expected[choice['sense'].split(':')[1]]


def test_live_dictionary_reading_hint_ranks_all_alternatives():
    unranked = language.dictionary_meanings('上手')['meanings']
    ranked = language.dictionary_meanings('上手', 'うわて')['meanings']
    assert {c['sense'] for c in ranked} == {c['sense'] for c in unranked}
    assert ranked[0]['sense'].startswith('jmdict:1580400:')
    assert ranked[0]['baseReading'] == 'うわて'
    assert any(c['baseReading'] == 'じょうず' for c in ranked)


def test_dictionary_dedup_keeps_the_preferred_reading(monkeypatch):
    monkeypatch.setattr(ichiran, 'lookup', lambda _: [
        {'text': '明日', 'reading': '明日 【あす】', 'kana': 'あす', 'seq': 1,
         'gloss': [{'gloss': 'tomorrow', 'ordinal': 0}]},
        {'text': '明日', 'reading': '明日 【あした】', 'kana': 'あした', 'seq': 1,
         'gloss': [{'gloss': 'tomorrow', 'ordinal': 0}]},
    ])
    choices = ichiran.dictionary_meanings('明日', 'あした')['meanings']
    assert len(choices) == 1 and choices[0]['baseReading'] == 'あした'


@pytest.mark.parametrize('surface,base', [
    ('速く', '速い'), ('早く', '早い'), ('遠く', '遠い'), ('近く', '近い'), ('多く', '多い'),
    ('速かった', '速い'), ('早かった', '早い'),
])
def test_live_adjective_families_preserve_their_upstream_spelling(surface, base):
    body = '「' + surface + '。」'
    token = next(t for t in language.tokenize(body) if t['surface'] == surface)
    assert token['base'] == base
    assert token['partOfSpeech'] == 'adj-i'
    assert body[token['start']:token['end']] == surface
    canonical = [c for c in token['choices'] if c['base'] == base]
    assert canonical and all(c['base'] == base for c in canonical)


def test_canonical_adverbial_root_uses_spelling_as_well_as_reading():
    def candidate(surface, base):
        return {'text': surface, 'kana': 'はやく', 'conj': [
            {'reading': base + ' 【はやい】', 'prop': [{'pos': 'adj-i', 'type': 'Adverbial'}],
             'seq': 1404975, 'gloss': [{'gloss': 'fast', 'pos': '[adj-i]', 'ordinal': 0}]}]}
    word = {'alternative': [
        {'text': '速く', 'kana': 'はやく', 'seq': 1400150, 'gloss': [{'gloss': 'quickly', 'pos': '[adv]'}]},
        candidate('早く', '早い'), candidate('速く', '速い'),
    ]}
    details = ichiran.word_details(word, '速く')
    assert details['base'] == '速い' and details['baseReading'] == 'はやい'
    assert details['partOfSpeech'] == 'adj-i'
    assert any(c['base']=='速い' for c in details['choices'])


@pytest.mark.parametrize('surface', ['とって', '通り', 'なし', '出来る', 'より', 'にとって'])
def test_live_unrelated_homographs_keep_the_primary_dictionary_headword(surface):
    token = next(t for t in language.tokenize(surface) if t['surface'] == surface)
    assert token['base'] == surface
