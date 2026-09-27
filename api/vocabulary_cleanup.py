"""Plan and atomically remove Latin vocabulary without changing source text."""
import copy
import hashlib
import json
from collections import Counter, defaultdict

from api.graph import Conflict, packed, uid
from api.schema import validate_graph
from api.vocabulary import latin_spans, latin_word


def fingerprint(snapshot):
    # The writer lock increments Schema.revision before planning. Operational
    # audits and job heartbeats do not change the corpus being reviewed.
    nodes = [n for n in snapshot['nodes'] if not set(n['labels']) & {'Schema', 'Audit', 'Mutation', 'Job'}]
    ids = {n['properties']['id'] for n in nodes}
    data = {'nodes': sorted(({'labels': sorted(n['labels']), 'properties': n['properties']} for n in nodes), key=lambda n:n['properties']['id']),
            'edges': sorted((e for e in snapshot['edges'] if e['from'] in ids and e['to'] in ids), key=lambda e:(e['from'],e['type'],e['to']))}
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def plan(snapshot):
    validate_graph(snapshot)
    nodes = {n['properties']['id']: copy.deepcopy(n) for n in snapshot['nodes']}
    props = {id: n['properties'] for id,n in nodes.items()}
    kinds = {id: next(k for k in n['labels'] if k != 'Entity') for id,n in nodes.items()}
    edges = {(e['from'], e['type'], e['to']) for e in snapshot['edges']}
    outgoing = defaultdict(lambda: defaultdict(list))
    incoming = defaultdict(lambda: defaultdict(list))
    for a,rel,b in edges:
        outgoing[a][rel].append(b)
        incoming[b][rel].append(a)
    words = {id for id in nodes if kinds[id] == 'Word'}
    latin_words = {id for id in words if latin_word(props[id]['surface'])}
    removed = set(latin_words)
    removed_occurrences = set()
    spans = {}
    affected_texts = Counter()
    for id in nodes:
        if kinds[id] != 'WordOccurrence':
            continue
        word = outgoing[id]['WORD'][0]
        placement = incoming[id]['TOKEN'][0]
        sentence = outgoing[placement]['SENTENCE'][0]
        if sentence not in spans:
            spans[sentence] = list(latin_spans(props[sentence]['body']))
        if word in latin_words or any(a <= props[id]['start'] < props[id]['end'] <= b for a,b in spans[sentence]):
            removed_occurrences.add(id)
            affected_texts[incoming[placement]['PLACEMENT'][0]] += 1
    removed |= removed_occurrences

    # Remove newly unused numeric fragments, but preserve independent number
    # occurrences, saved phrases and surviving forms in the same family.
    numeric_candidates = {outgoing[id]['WORD'][0] for id in removed_occurrences} - removed
    numeric_candidates = {id for id in numeric_candidates if all(char.isnumeric() for char in props[id]['surface'])}
    for id in sorted(numeric_candidates):
        if (not (set(incoming[id]['WORD']) - removed_occurrences)
                and not incoming[id]['MEMBER_WORD']
                and not (set(incoming[id]['BASE_FORM']) - {id} - latin_words - numeric_candidates)):
            removed.add(id)

    # A Latin canonical base may have Japanese forms. Elect a surviving form
    # and transfer its existing statuses and meanings intact.
    families = []
    for root in sorted(removed & words):
        if props[root]['family'] != root:
            continue
        survivors = sorted((set(incoming[root]['BASE_FORM']) - removed), key=lambda id:(props[id]['surface'],id))
        if not survivors:
            continue
        replacement = survivors[0]
        for word in survivors:
            props[word]['family'] = replacement
            edges.discard((word,'BASE_FORM',root))
            edges.add((word,'BASE_FORM',replacement))
        for rel in ('STATUS','HAS_MEANING','PROVENANCE'):
            for child in outgoing[root][rel]:
                edges.discard((root,rel,child))
                edges.add((replacement,rel,child))
        families.append({'removedBaseId':root,'baseId':replacement,'surface':props[replacement]['surface'],'preservedWordIds':survivors})

    # A saved phrase's ordered members are its identity. Removing a member
    # would silently change that identity and its authored meaning.
    removed_phrases = {a for a,rel,b in edges if rel == 'PHRASE_MEMBER' and any(w in removed for w in outgoing[b]['MEMBER_WORD'])}
    removed |= removed_phrases
    removed |= {b for a,rel,b in edges if rel == 'PHRASE_MEMBER' and a in removed_phrases}
    removed |= {a for a,rel,b in edges if rel == 'OCCURRED_IN' and b in removed_occurrences}

    # Only remove data newly orphaned by this cleanup. Shared meanings, speech,
    # provenance and translations remain if any surviving owner uses them.
    dependent = {'LearningStatus','Meaning','Speech','Translation','Provenance','Source'}
    while True:
        candidates = {b for a,rel,b in edges if a in removed and b not in removed and kinds[b] in dependent}
        orphaned = {b for b in candidates if not any(a not in removed for a,rel,target in edges if target == b)}
        if not orphaned:
            break
        removed |= orphaned
    # A worker must never finish a speech job whose target was removed.
    removed |= {id for id in nodes if kinds[id] == 'Job' and json.loads(props[id]['payload']).get('speechId') in removed}

    # Keep ordinals contiguous while retaining each surviving UUID and offset.
    reindexed = 0
    for placement in {incoming[id]['TOKEN'][0] for id in removed_occurrences}:
        rels=outgoing[placement]
        remaining = sorted((id for id in rels['TOKEN'] if id not in removed), key=lambda id:props[id]['ordinal'])
        for ordinal,id in enumerate(remaining):
            if props[id]['ordinal'] != ordinal:
                props[id]['ordinal'] = ordinal
                reindexed += 1
    surviving_edges = [{'from':a,'type':rel,'to':b,'properties':{}} for a,rel,b in sorted(edges) if a not in removed and b not in removed]
    result = {'nodes':[node for id,node in nodes.items() if id not in removed], 'edges':surviving_edges}
    validate_graph(result)
    report = {'fingerprint':fingerprint(snapshot), 'removed':dict(sorted(Counter(kinds[id] for id in removed).items())),
              'words':[{'id':id,'surface':props[id]['surface']} for id in sorted(removed & words,key=lambda id:(props[id]['surface'],id))],
              'texts':[{'id':id,'title':props[id]['title'],'removedOccurrences':count} for id,count in sorted(affected_texts.items())],
              'preservedFamilies':families,
              'removedPhrases':[{'id':id,'surface':props[id]['surface'],'meaning':props[id]['meaning']} for id in sorted(removed_phrases)],
              'reindexedOccurrences':reindexed, 'remainingLatinWords':sum(latin_word(n['properties']['surface']) for n in result['nodes'] if 'Word' in n['labels'])}
    return result, report


def apply(t, expected_fingerprint=None):
    before = t.snapshot()
    after, report = plan(before)
    if expected_fingerprint is not None and report['fingerprint'] != expected_fingerprint:
        raise Conflict('The corpus changed after the cleanup plan. Back up and review a fresh plan.')
    old = {n['properties']['id']:n['properties'] for n in before['nodes']}
    new = {n['properties']['id']:n['properties'] for n in after['nodes']}
    old_edges = {(e['from'],e['type'],e['to']) for e in before['edges']}
    new_edges = {(e['from'],e['type'],e['to']) for e in after['edges']}
    changed = {id for id in new if new[id] != old[id]}
    changed |= {id for a,rel,b in old_edges ^ new_edges for id in (a,b) if id in new}
    for a,rel,b in sorted(old_edges - new_edges):
        t.unlink(a,rel,b)
    for a,rel,b in sorted(new_edges - old_edges):
        t.link(a,rel,b)
    if old.keys() - new.keys():
        t.run('MATCH (n:Entity) WHERE n.id IN $ids DETACH DELETE n', ids=sorted(old.keys() - new.keys()))
    for id in sorted(changed):
        delta = {key:value for key,value in new[id].items() if old[id][key] != value}
        t.update(id,**delta)
    if changed or old.keys() != new.keys():
        t.create('Migration','migration:exclude-latin:'+uid(),payload=packed(report))
    return report
