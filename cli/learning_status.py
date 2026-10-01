"""Offline, idempotent migration to one lowest-state status per family."""
import copy
from collections import defaultdict

from api.graph import now
from api.schema import InvalidGraph

STATES=('new','learning','familiar','known')


def migrate(snapshot):
    data=copy.deepcopy(snapshot)
    nodes={n['properties']['id']:n for n in data['nodes']}
    owners=defaultdict(list)
    for edge in data['edges']:
        if edge['type']=='STATUS':owners[edge['from']].append(edge['to'])
    removed=set();migrated=0;stamp=now()
    for owner,ids in owners.items():
        statuses=[nodes[id]['properties'] for id in ids]
        if len(statuses)==1 and 'area' not in statuses[0]:continue
        if len(statuses)!=2 or {s.get('area') for s in statuses}!={'reading','listening'}:
            raise InvalidGraph('Migration requires both legacy learning statuses')
        keep=next(s for s in statuses if s['area']=='reading')
        keep['state']=min((s['state'] for s in statuses),key=STATES.index)
        keep['revision']=max(s['revision'] for s in statuses)+1
        keep['identityKey']=f'status:{owner}'
        keep['updatedAt']=stamp;keep.pop('area')
        removed.update(id for id in ids if id!=keep['id']);migrated+=1
    data['nodes']=[n for n in data['nodes'] if n['properties']['id'] not in removed]
    data['edges']=[e for e in data['edges'] if e['from'] not in removed and e['to'] not in removed]
    return data,{'familiesMigrated':migrated,'statusesRemoved':len(removed),'alreadyMigrated':migrated==0}


def apply(t):
    before=t.snapshot();after,report=migrate(before)
    old={n['properties']['id']:n['properties'] for n in before['nodes']}
    new={n['properties']['id']:n['properties'] for n in after['nodes']}
    removed=sorted(set(old)-set(new))
    updates=[p for id,p in new.items() if p!=old[id]]
    if removed:t.run('MATCH (s:Entity:LearningStatus) WHERE s.id IN $ids DETACH DELETE s',ids=removed)
    if updates:t.run('UNWIND $values AS p MATCH (s:Entity:LearningStatus {id:p.id}) SET s=p',values=updates)
    return report
