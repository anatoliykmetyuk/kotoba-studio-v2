"""One-time initialization of explicit sentence completion from lesson status."""
import copy
from api.graph import now


def migrate(snapshot):
    result=copy.deepcopy(snapshot)
    nodes={n['properties']['id']:n for n in result['nodes']}
    initialized=0;completed=0;stamp=now()
    for edge in result['edges']:
        if edge['type']!='PLACEMENT':continue
        text=nodes[edge['from']]['properties'];placement=nodes[edge['to']]['properties']
        if 'completed' in placement:continue
        placement['completed']=text['textState']=='completed'
        placement['revision']+=1;placement['updatedAt']=stamp
        initialized+=1;completed+=placement['completed']
    return result,{'sentencesInitialized':initialized,'completedSentences':completed,'alreadyMigrated':initialized==0}


def apply(t):
    before=t.snapshot();after,report=migrate(before)
    old={n['properties']['id']:n['properties'] for n in before['nodes']}
    updates=[n['properties'] for n in after['nodes'] if n['properties']!=old[n['properties']['id']]]
    if updates:t.run('UNWIND $values AS p MATCH (s:Entity:SentenceOccurrence {id:p.id}) SET s=p',values=updates)
    return report
