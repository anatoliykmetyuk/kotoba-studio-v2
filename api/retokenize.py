"""Reviewable, atomic occurrence replacement using off-the-shelf analysis."""
import copy
import uuid
from collections import Counter, defaultdict

from api.graph import Conflict, digest, now, packed
from api.schema import validate_graph
from api.vocabulary import eligible_tokens, latin_word
from api.vocabulary_cleanup import fingerprint


def sentences(snapshot):
    return sorted(({'id':n['properties']['id'],'body':n['properties']['body']}
                   for n in snapshot['nodes'] if 'Sentence' in n['labels']), key=lambda s:s['id'])


def plan(snapshot, analysis):
    validate_graph(snapshot)
    nodes={n['properties']['id']:copy.deepcopy(n) for n in snapshot['nodes']}
    props={id:n['properties'] for id,n in nodes.items()}
    kinds={id:next(k for k in n['labels'] if k!='Entity') for id,n in nodes.items()}
    keys={p['identityKey']:id for id,p in props.items()}
    edges={(e['from'],e['type'],e['to']) for e in snapshot['edges']}
    outgoing=defaultdict(lambda:defaultdict(list)); incoming=defaultdict(lambda:defaultdict(list))
    for a,rel,b in edges:outgoing[a][rel].append(b);incoming[b][rel].append(a)
    meaning_sources={(a,props[b]['sourceType'],props[b]['sourceKey']):b for a,r,b in edges if r=='HAS_MEANING'}
    original=set(nodes);original_props={id:copy.deepcopy(p) for id,p in props.items()};removed=set();stamp=now()
    source={s['id']:s['body'] for s in sentences(snapshot)}
    if not isinstance(analysis,list) or len(analysis)!=len(source):raise ValueError('Analysis must cover every stored sentence exactly once')
    parsed={s['id']:s for s in analysis}
    if len(parsed)!=len(analysis) or set(parsed)!=set(source):raise ValueError('Analysis sentence IDs do not match the corpus')
    for id,s in parsed.items():
        if s['body']!=source[id]:raise ValueError('Analysis must preserve original sentence text')
        previous=0
        for token in s['tokens']:
            if type(token['start'])!=int or type(token['end'])!=int or not previous<=token['start']<token['end']<=len(s['body']):raise ValueError('Invalid token offsets')
            if s['body'][token['start']:token['end']]!=token['surface']:raise ValueError('Token spelling differs from source')
            previous=token['end']

    def entity(kind,key,**values):
        if key in keys:return keys[key]
        id=str(uuid.uuid5(uuid.NAMESPACE_URL,'https://kotoba.local/'+key))
        if id in nodes:raise ValueError('Generated identity collides with an existing entity')
        p={'id':id,'identityKey':key,'revision':0,'createdAt':stamp,'updatedAt':stamp,**values}
        nodes[id]={'labels':['Entity',kind],'properties':p};props[id]=p;kinds[id]=kind;keys[key]=id
        return id
    words={p['surface']:id for id,p in props.items() if kinds[id]=='Word'}
    conflicts={};new_forms={}
    def root(surface,reading,pos):
        if not surface or latin_word(surface):raise ValueError('Invalid Japanese base form')
        if surface in words:return props[words[surface]]['family']
        key='word:'+digest(surface);id=str(uuid.uuid5(uuid.NAMESPACE_URL,'https://kotoba.local/'+key))
        entity('Word',key,surface=surface,reading=reading,partOfSpeech=pos,family=id);words[surface]=id
        edges.add((id,'BASE_FORM',id))
        for area in ('listening','reading'):
            status=entity('LearningStatus',f'status:{id}:{area}',area=area,state='new');edges.add((id,'STATUS',status))
        return id
    def word(token):
        desired=token['selected']['base'];reading=token['selected'].get('baseReading',token['baseReading'])
        base=root(desired,reading,token['partOfSpeech']);surface=token['surface']
        if surface in words:
            id=words[surface]
            if props[id]['family']!=base:
                # Never silently replace a saved family's meaning or mastery.
                conflicts[surface]={'surface':surface,'retainedBase':props[props[id]['family']]['surface'],'analyzedBase':desired}
                base=props[id]['family']
        else:
            id=entity('Word','word:'+digest(surface),surface=surface,reading=token['reading'],partOfSpeech=token['partOfSpeech'],family=base)
            words[surface]=id;edges.add((id,'BASE_FORM',base));new_forms[surface]=props[base]['surface']
        meaning_owners=({id} if id!=base else {root(desired,reading,token['partOfSpeech'])}) if surface in conflicts else {id,base}
        for choice in token.get('meanings',[]):
            body=choice.get('meaning','').strip()
            if not body:continue
            values={'body':body,'reading':choice.get('baseReading',props[base]['reading']),
                    'partOfSpeech':choice.get('partOfSpeech',props[base]['partOfSpeech']),
                    'sourceType':choice.get('sourceType','JMdict'),'sourceKey':choice.get('sense','corpus:'+digest(body))}
            source_owners={owner for owner in meaning_owners if props[owner]['family']!=owner or choice.get('base',desired)==props[owner]['surface']}
            owners=[owner for owner in source_owners if (owner,values['sourceType'],values['sourceKey']) not in meaning_sources]
            if not owners:continue
            retained=next((meaning_sources[(owner,values['sourceType'],values['sourceKey'])] for owner in source_owners if (owner,values['sourceType'],values['sourceKey']) in meaning_sources),None)
            mid=retained or entity('Meaning','meaning:'+digest(packed(values)),**values)
            for owner in owners:
                edges.add((owner,'HAS_MEANING',mid));meaning_sources[(owner,values['sourceType'],values['sourceKey'])]=mid
        return id

    changed_places=[];occurrence_map={};old_total=0;new_total=0
    for placement in sorted(id for id,k in kinds.items() if k=='SentenceOccurrence'):
        sid=outgoing[placement]['SENTENCE'][0];s=parsed[sid]
        old=sorted(outgoing[placement]['TOKEN'],key=lambda id:props[id]['ordinal']);old_total+=len(old)
        exact={(props[id]['start'],props[id]['end'],outgoing[id]['WORD'][0]):id for id in old}
        replacement=[]
        for ordinal,token in enumerate(eligible_tokens(s['body'],s['tokens'])):
            wid=word(token);key=(token['start'],token['end'],wid)
            oid=exact.get(key)
            if oid:
                props[oid].update(ordinal=ordinal,reading=token['reading'])
            else:
                oid=entity('WordOccurrence',f'ichiran-occurrence:{placement}:{token["start"]}:{token["end"]}:{wid}',
                           ordinal=ordinal,start=token['start'],end=token['end'],reading=token['reading'])
                edges.add((placement,'TOKEN',oid));edges.add((oid,'WORD',wid))
            replacement.append(oid)
        new_total+=len(replacement)
        obsolete=set(old)-set(replacement);removed|=obsolete
        if old!=replacement or any(props[id]!=original_props[id] for id in set(old)&set(replacement)):
            changed_places.append(placement)
        for oid in obsolete:
            a,b=props[oid]['start'],props[oid]['end']
            candidates=[nid for nid in replacement if max(a,props[nid]['start'])<min(b,props[nid]['end'])]
            # Map prior evidence to one best-overlapping replacement, never
            # inflate encounter counts when one previous token becomes many.
            occurrence_map[oid]=max(candidates,key=lambda nid:(min(b,props[nid]['end'])-max(a,props[nid]['start']),-props[nid]['start'])) if candidates else None

    encounter_groups=defaultdict(list);discarded_evidence=[]
    for id,k in list(kinds.items()):
        if k!='Encounter':continue
        old_target=outgoing[id]['OCCURRED_IN'][0];target=occurrence_map.get(old_target,old_target)
        if target is None:
            removed.add(id);discarded_evidence.append({'encounter':copy.deepcopy(props[id]),'occurrence':copy.deepcopy(props[old_target])})
        else:encounter_groups[(props[id]['area'],target)].append((id,old_target))
    for (area,target),group in encounter_groups.items():
        group.sort(key=lambda item:(item[1]!=target,props[item[0]]['createdAt'],item[0]))
        keep,old_target=group[0];edges.discard((keep,'OCCURRED_IN',old_target));edges.add((keep,'OCCURRED_IN',target))
        for id,old_target in group[1:]:
            removed.add(id);discarded_evidence.append({'encounter':copy.deepcopy(props[id]),'occurrence':copy.deepcopy(props[old_target]),'mergedInto':keep})
    result={'nodes':[n for id,n in nodes.items() if id not in removed],
            'edges':[{'from':a,'type':rel,'to':b,'properties':{}} for a,rel,b in sorted(edges) if a not in removed and b not in removed]}
    validate_graph(result)
    report={'fingerprint':fingerprint(snapshot),'engine':'Ichiran','sentences':len(parsed),'changedPlacements':len(changed_places),
            'occurrencesBefore':old_total,'occurrencesAfter':new_total,
            'created':dict(sorted(Counter(kinds[id] for id in set(nodes)-original).items())),
            'removed':dict(sorted(Counter(kinds[id] for id in removed).items())),
            'newForms':new_forms,'retainedFamilies':list(conflicts.values()),'preservedEncounterEvidence':discarded_evidence,
            'preservedTexts':sum(k=='Text' for k in kinds.values())}
    return result,report


def apply(t,analysis,expected_fingerprint):
    before=t.snapshot()
    if fingerprint(before)!=expected_fingerprint:raise Conflict('The corpus changed. Create and review a new retokenization plan.')
    after,report=plan(before,analysis)
    old={n['properties']['id']:n for n in before['nodes']};new={n['properties']['id']:n for n in after['nodes']}
    a={(e['from'],e['type'],e['to']) for e in before['edges']};b={(e['from'],e['type'],e['to']) for e in after['edges']}
    created=set(new)-set(old);deleted=set(old)-set(new)
    changed={id for id in set(old)&set(new) if old[id]['properties']!=new[id]['properties']}
    changed|={id for x,rel,y in a^b for id in (x,y) if id in old and id in new}
    for kind in sorted({next(k for k in new[id]['labels'] if k!='Entity') for id in created}):
        values=[new[id]['properties'] for id in sorted(created) if kind in new[id]['labels']]
        t.run(f'UNWIND $values AS p CREATE (n:Entity:{kind}) SET n=p',values=values)
    for rel in sorted({rel for x,rel,y in a-b}):
        pairs=[{'a':x,'b':y} for x,r,y in a-b if r==rel]
        t.run(f'UNWIND $pairs AS p MATCH (a:Entity {{id:p.a}})-[r:{rel}]->(b:Entity {{id:p.b}}) DELETE r',pairs=pairs)
    for rel in sorted({rel for x,rel,y in b-a}):
        pairs=[{'a':x,'b':y} for x,r,y in b-a if r==rel]
        t.run(f'UNWIND $pairs AS p MATCH (a:Entity {{id:p.a}}),(b:Entity {{id:p.b}}) MERGE (a)-[:{rel}]->(b)',pairs=pairs)
    if deleted:t.run('MATCH (n:Entity) WHERE n.id IN $ids DETACH DELETE n',ids=sorted(deleted))
    updates=[]
    for id in sorted(changed):
        previous=old[id]['properties'];delta={k:v for k,v in new[id]['properties'].items() if v!=previous[k]}
        updates.append({'id':id,'delta':delta})
    if updates:t.run('UNWIND $updates AS p MATCH (n:Entity {id:p.id}) SET n+=p.delta,n.revision=n.revision+1,n.updatedAt=$stamp',updates=updates,stamp=now())
    if created or deleted or changed:
        t.create('Migration','migration:ichiran:'+expected_fingerprint,payload=packed(report))
    report['changed']=bool(created or deleted or changed)
    return report
