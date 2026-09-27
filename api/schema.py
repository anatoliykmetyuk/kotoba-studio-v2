import hashlib,json
from collections import Counter,defaultdict
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SCHEMA=json.loads((ROOT/'ontology/compiled.json').read_text())
class InvalidGraph(ValueError): pass

def validate_properties(kind,p,schema=SCHEMA):
    c=schema["classes"].get(kind)
    if not c or c["abstract"]:raise InvalidGraph("Unknown concept")
    allowed=set(c['required'])
    if set(p)!=allowed: raise InvalidGraph(f'{kind} properties: missing {allowed-set(p)}, unexpected {set(p)-allowed}')
    for name,v in p.items():
        datatype=schema['properties'][name]
        valid=(v in schema['enums'][datatype]) if datatype in schema['enums'] else {'string':isinstance(v,str),'integer':type(v)==int,'decimal':type(v) in (int,float),'boolean':type(v)==bool}.get(datatype,False)
        if not valid: raise InvalidGraph(f'{kind}.{name}: invalid {datatype} value')
    if p["revision"]<0:raise InvalidGraph("Negative revision")
    if kind=="Text" and not 0<=p["cursor"]<=len(p["body"]):raise InvalidGraph("Cursor outside text")

def validate_graph(snapshot, schema=SCHEMA):
    nodes={}; keys=set(); by_type=defaultdict(list)
    for item in snapshot['nodes']:
        labels=set(item['labels']); p=item['properties']; kinds=labels-{'Entity'}
        if len(kinds)!=1 or 'Entity' not in labels: raise InvalidGraph(f'Invalid labels: {labels}')
        kind=next(iter(kinds)); c=schema['classes'].get(kind)
        if not c or c['abstract']: raise InvalidGraph(f'Unknown concept {kind}')
        validate_properties(kind,p,schema)
        if p['id'] in nodes or p['identityKey'] in keys: raise InvalidGraph('Duplicate identity')
        if p['revision']<0: raise InvalidGraph('Negative revision')
        nodes[p['id']]=(kind,p);keys.add(p['identityKey']);by_type[kind].append(p)
    outgoing=defaultdict(lambda:defaultdict(list)); incoming=defaultdict(lambda:defaultdict(list)); edges=set()
    for e in snapshot['edges']:
        signature=(e['from'],e['type'],e['to'])
        if signature in edges: raise InvalidGraph('Duplicate relationship')
        edges.add(signature)
        r=schema['relations'].get(e['type'])
        if not r or e.get('properties'): raise InvalidGraph('Unknown relationship or relationship properties')
        if e['from'] not in nodes or e['to'] not in nodes: raise InvalidGraph('Dangling relationship')
        a=nodes[e['from']][0];b=nodes[e['to']][0]
        if a not in r['from'] and 'Entity' not in r['from'] or b not in r['to'] and 'Entity' not in r['to']: raise InvalidGraph('Invalid relationship endpoints')
        outgoing[e['from']][e['type']].append(e['to']); incoming[e['to']][e['type']].append(e['from'])
    for id,(kind,p) in nodes.items():
        for name,count in schema['classes'][kind]['relations'].items():
            if len(outgoing[id][name])!=count: raise InvalidGraph(f'{kind}.{name} requires exactly {count}')
        for name,ends in outgoing[id].items():
            if schema['relations'][name]['functional'] and len(ends)>1: raise InvalidGraph(f'{name} is functional')
        if kind=='Word':
            base=outgoing[id]['BASE_FORM'][0]; bp=nodes[base][1]
            if outgoing[base]['BASE_FORM']!=[base] or p['family']!=bp['family'] or bp['family']!=base: raise InvalidGraph('Base form must be a canonical self-linked family root')
            status=outgoing[id]['STATUS']
            if id==base:
                if Counter(nodes[x][1]['area'] for x in status)!=Counter(['reading','listening']): raise InvalidGraph('Canonical Word requires both learning areas')
            elif status: raise InvalidGraph('Forms inherit status from their base')
        if kind=='Phrase':
            if Counter(nodes[x][1]['area'] for x in outgoing[id]['STATUS'])!=Counter(['reading','listening']):raise InvalidGraph('Phrase requires both learning areas')
            members=outgoing[id]['PHRASE_MEMBER']
            if len(members)<2:raise InvalidGraph('Phrase requires at least two ordered words')
            if sorted(nodes[x][1]['ordinal'] for x in members)!=list(range(len(members))):raise InvalidGraph('Phrase member ordinals must be contiguous')
        if kind=='PhraseMember' and len(incoming[id]['PHRASE_MEMBER'])!=1:raise InvalidGraph('Phrase member requires one Phrase')
        if kind=='LearningStatus':
            owners=incoming[id]['STATUS']
            if len(owners)!=1 or nodes[owners[0]][0] not in ('Word','Phrase'): raise InvalidGraph('Status must have one Word/Phrase owner')
        if kind=='SentenceOccurrence' and len(incoming[id]['PLACEMENT'])!=1: raise InvalidGraph('Sentence occurrence requires one Text')
        if kind=='WordOccurrence' and len(incoming[id]['TOKEN'])!=1: raise InvalidGraph('Word occurrence requires one placement')
        if kind in ('SentenceOccurrence','WordOccurrence') and (p['start']<0 or p['end']<=p['start']): raise InvalidGraph('Invalid occurrence offsets')
        if kind=='Text' and not 0<=p['cursor']<=len(p['body']): raise InvalidGraph('Cursor outside text')
    active=[n for n in by_type['Schema'] if n['identityKey']=='schema:active']
    if len(active)!=1 or active[0]['digest']!=schema['digest']: raise InvalidGraph('Active schema must be preserved')
    for owner,rels in outgoing.items():
        for rel in ('TOKEN','PLACEMENT','PHRASE_MEMBER'):
            ordinals=[nodes[x][1]['ordinal'] for x in rels[rel]]
            if len(set(ordinals))!=len(ordinals):raise InvalidGraph('Duplicate occurrence ordinal')
    forms=set(); sentences=set(); texts=set()
    for w in by_type['Word']:
        key=w['surface']
        if key in forms: raise InvalidGraph('Duplicate Word spelling')
        forms.add(key)
    for kind,seen in [('Sentence',sentences),('Text',texts)]:
        for p in by_type[kind]:
            if p['body'] in seen: raise InvalidGraph(f'Duplicate {kind} content')
            seen.add(p['body'])
    # Natural identity is separate from UUIDs; arbitrary agent writes obey the same dedup rules.
    for kind,fields in [('Meaning',('body','reading','partOfSpeech','sourceType','sourceKey')),('Folder',('name',)),('Source',('url',)),('Speech',('pronunciation','voice','speed','engine')),('Translation',('body','meaning'))]:
        unique=set()
        for entity in by_type[kind]:
            key=tuple(entity[field].strip().casefold() if kind=='Folder' else entity[field] for field in fields)
            if key in unique:raise InvalidGraph(f'Duplicate {kind}')
            unique.add(key)
    encounters=set()
    for encounter in by_type['Encounter']:
        targets=outgoing[encounter['id']]['OCCURRED_IN']
        if len(targets)!=1:raise InvalidGraph('Encounter requires a word occurrence')
        key=(encounter['area'],targets[0])
        if key in encounters:raise InvalidGraph('Duplicate encounter')
        encounters.add(key)
    phrases=set()
    for phrase in by_type['Phrase']:
        members=sorted(outgoing[phrase['id']]['PHRASE_MEMBER'],key=lambda x:nodes[x][1]['ordinal'])
        signature=(tuple(outgoing[m]['MEMBER_WORD'][0] for m in members),phrase['meaning'])
        if signature in phrases:raise InvalidGraph('Duplicate Phrase meaning and members')
        phrases.add(signature)
    for o in by_type['WordOccurrence']:
        placement=nodes[incoming[o['id']]['TOKEN'][0]][1]; sentence=nodes[outgoing[placement['id']]['SENTENCE'][0]][1]
        word=nodes[outgoing[o['id']]['WORD'][0]][1]
        if o['end']>len(sentence['body']) or sentence['body'][o['start']:o['end']]!=word['surface']: raise InvalidGraph('Word occurrence does not match sentence')
    for o in by_type['SentenceOccurrence']:
        text=nodes[incoming[o['id']]['PLACEMENT'][0]][1]; sentence=nodes[outgoing[o['id']]['SENTENCE'][0]][1]
        if o['end']>len(text['body']) or text['body'][o['start']:o['end']]!=sentence['body']: raise InvalidGraph('Sentence occurrence does not match text')
    return {'valid':True,'nodes':len(nodes),'edges':len(edges),'schema':schema['digest']}
