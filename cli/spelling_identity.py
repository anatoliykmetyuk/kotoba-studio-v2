"""Atomic, repeatable migration from meaning-specific words to unique spellings."""
import copy,json,uuid
from collections import defaultdict
from api.graph import digest,packed,now

STATES=['new','learning','familiar','known']
def migrate(snapshot):
    data=copy.deepcopy(snapshot)
    nodes={n['properties']['id']:n for n in data['nodes']};edges=data['edges']
    words={id:n['properties'] for id,n in nodes.items() if 'Word' in n['labels']}
    if not any('meaning' in w for w in words.values()):return data,{'alreadyMigrated':True}
    original=copy.deepcopy(words);parent={w['family']:w['family'] for w in words.values()}
    def root(a):
        while parent[a]!=a:parent[a]=parent[parent[a]];a=parent[a]
        return a
    by_surface=defaultdict(list)
    for w in words.values():by_surface[w['surface']].append(w)
    for group in by_surface.values():
        for w in group[1:]:parent[root(w['family'])]=root(group[0]['family'])
    components=defaultdict(list)
    for id in parent:components[root(id)].append(id)
    chosen={}
    for ids in components.values():
        winner=min(ids,key=lambda id:(words[id]['createdAt'],id))
        for id in ids:chosen[id]=winner
    mapping={};survivors={}
    for surface,group in by_surface.items():
        canonical=chosen[group[0]['family']]
        winner=min(group,key=lambda w:(w['id']!=canonical,w['id']!=w['family'],w['createdAt'],w['id']))
        survivors[winner['id']]=winner
        for w in group:mapping[w['id']]=winner['id']
    stamp=now();removed=set(words)-set(survivors);report={'wordIds':mapping,'statuses':[],'mergedWords':len(removed),'mergedPhrases':0}
    for w in survivors.values():
        w.pop('meaning',None);w['family']=mapping[chosen[original[w['id']]['family']]]
        w['identityKey']='word:'+digest(w['surface']);w['revision']+=1;w['updatedAt']=stamp
    def entity(kind,key,props):
        id=str(uuid.uuid5(uuid.NAMESPACE_URL,'https://kotoba.local/'+key))
        existing=next((i for i,n in nodes.items() if n['properties']['identityKey']==key),None)
        if existing:return existing
        nodes[id]={'labels':['Entity',kind],'properties':{'id':id,'identityKey':key,'revision':0,'createdAt':stamp,'updatedAt':stamp,**props}}
        return id
    added=[]
    for old in original.values():
        if not old.get('meaning','').strip():continue
        props={'body':old['meaning'].strip(),'reading':old['reading'],'partOfSpeech':old['partOfSpeech'],'sourceType':'legacy','sourceKey':'legacy:'+digest(old['meaning'].strip())}
        mid=entity('Meaning','meaning:'+digest(packed(props)),props)
        added.append({'from':mapping[old['id']],'type':'HAS_MEANING','to':mid,'properties':{}})
    # Coalesce status owners independently in each learning area, preserving the
    # most advanced explicitly saved state. Full original values are in evidence.
    status_groups=defaultdict(list)
    for e in edges:
        if e['type']=='STATUS' and e['from'] in original:
            owner=mapping[chosen[original[e['from']]['family']]]
            status_groups[(owner,nodes[e['to']]['properties']['area'])].append(e['to'])
    def merge_status(owner,area,ids):
        keep=min(ids,key=lambda id:(nodes[id]['properties']['identityKey']!=f'status:{owner}:{area}',id))
        values=[copy.deepcopy(nodes[id]['properties']) for id in ids];p=nodes[keep]['properties']
        p['state']=max((v['state'] for v in values),key=STATES.index);p['revision']+=1;p['updatedAt']=stamp
        for id in ids:
            if id!=keep:removed.add(id);mapping[id]=keep
        added.append({'from':owner,'type':'STATUS','to':keep,'properties':{}})
        report['statuses'].append({'owner':owner,'area':area,'state':p['state'],'original':values})
    for (owner,area),ids in status_groups.items():merge_status(owner,area,ids)
    rebuilt=[]
    for e in edges:
        if e['from'] in original and e['type'] in ('BASE_FORM','STATUS'):continue
        rebuilt.append(e|{'from':mapping.get(e['from'],e['from']),'to':mapping.get(e['to'],e['to'])})
    rebuilt+=added
    for w in survivors.values():rebuilt.append({'from':w['id'],'type':'BASE_FORM','to':w['family'],'properties':{}})
    # Rewiring homographs may make phrase member sequences identical.
    members=defaultdict(list);member_word={e['from']:e['to'] for e in rebuilt if e['type']=='MEMBER_WORD'}
    for e in rebuilt:
        if e['type']=='PHRASE_MEMBER':members[e['from']].append(e['to'])
    phrases={};phrase_map={}
    for id,n in sorted(nodes.items()):
        if 'Phrase' not in n['labels']:continue
        ordered=sorted(members[id],key=lambda m:nodes[m]['properties']['ordinal'])
        key=(tuple(member_word[m] for m in ordered),n['properties']['meaning'])
        if key not in phrases:phrases[key]=id;continue
        keep=phrases[key];phrase_map[id]=keep;removed.add(id);removed.update(ordered);report['mergedPhrases']+=1
    if phrase_map:
        groups=defaultdict(list)
        for e in rebuilt:
            if e['type']=='STATUS' and ('Phrase' in nodes[e['from']]['labels']):
                groups[(phrase_map.get(e['from'],e['from']),nodes[e['to']]['properties']['area'])].append(e['to'])
        added=[]
        for (owner,area),ids in groups.items():merge_status(owner,area,ids)
        rebuilt=[e for e in rebuilt if not(e['type']=='STATUS' and 'Phrase' in nodes[e['from']]['labels'])]
        rebuilt+=added
    unique={}
    for e in rebuilt:
        a=mapping.get(e['from'],e['from']);a=phrase_map.get(a,a);b=mapping.get(e['to'],e['to']);b=phrase_map.get(b,b)
        if a in removed or b in removed:continue
        unique[(a,e['type'],b)]=e|{'from':a,'to':b}
    for id in removed:nodes.pop(id,None)
    evidence=entity('Migration','migration:spelling-identity',{'payload':packed(report)})
    return {'nodes':list(nodes.values()),'edges':list(unique.values())},report
