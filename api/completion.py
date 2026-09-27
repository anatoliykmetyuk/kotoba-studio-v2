"""Explicit lesson completion promotes untouched vocabulary in both areas."""
from api import domain
from api.graph import Conflict,Missing,digest,packed


def preview(t,id):
    text=t.get(id)
    if text['type']!='Text':raise Missing('Text not found')
    rows=t.run('''MATCH (t:Text {id:$id})-[:PLACEMENT]->()-[:TOKEN]->()-[:WORD]->()-[:BASE_FORM]->(b:Word)
        WITH DISTINCT b MATCH (b)-[:STATUS]->(s:LearningStatus)
        RETURN b.id AS id,collect(properties(s)) AS statuses ORDER BY id''',id=id)
    eligible=[row for row in rows if any(s['state']=='new' for s in row['statuses'])]
    signature=[{'id':row['id'],'statuses':sorted(({'id':s['id'],'state':s['state'],'revision':s['revision']} for s in row['statuses']),key=lambda s:s['id'])} for row in rows]
    fingerprint=digest(packed({'textId':id,'revision':text['revision'],'families':signature}))
    return {'textId':id,'revision':text['revision'],'wordCount':len(eligible),'fingerprint':fingerprint},eligible


def finish(t,id,revision=None,fingerprint=None):
    report,families=preview(t,id)
    if revision is not None and revision!=report['revision']:raise Conflict('The lesson changed. Review completion again.')
    if fingerprint is not None and fingerprint!=report['fingerprint']:raise Conflict('Learning statuses changed. Review completion again.')
    # One graph writer transaction covers mastery, encounters, cursor and Text.
    for family in families:
        for status in family['statuses']:
            if status['state']!='known':t.update(status['id'],state='known')
    text=t.get(id);domain.progress(t,id,len(text['body']))
    result=domain.text_state(t,id,'completed')
    return result|{'markedKnown':report['wordCount']}
