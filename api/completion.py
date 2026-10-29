"""Explicit section completion and atomic promotion of untouched vocabulary."""
from api import domain
from api.graph import Conflict,Missing,digest,packed,now


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
    placements=t.run('MATCH (:Text {id:$id})-[:PLACEMENT]->(p) RETURN p.id AS id',id=id)
    record_encounters(t,id,[row['id'] for row in placements])
    result=domain.text_state(t,id,'completed')
    return result|{'markedKnown':report['wordCount']}


def record_encounters(t,text_id,placement_ids):
    """Reading evidence is credited once per occurrence, including after undo."""
    rows=t.run('''MATCH (:Text {id:$id})-[:PLACEMENT]->(p)-[:TOKEN]->(o)
        WHERE p.id IN $placements AND NOT EXISTS {
          MATCH (:Encounter {area:'reading'})-[:OCCURRED_IN]->(o)
        }
        RETURN o.id AS id''',id=text_id,placements=placement_ids)
    for row in rows:
        encounter=t.create('Encounter','encounter:reading:'+row['id'],area='reading',evidence='reader-checkpoint')
        t.link(encounter['id'],'OCCURRED_IN',row['id'])
    if rows:
        from datetime import datetime
        from zoneinfo import ZoneInfo
        from api.graph import uid
        t.create('Activity','activity:'+uid(),day=datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat(),
                 kind='reading',amount=len(rows),details=packed({'textId':text_id}))


def checkpoint(t,id,start,end,completed):
    text=t.get(id)
    if text['type']!='Text':raise Missing('Text not found')
    if start>=end or end>len(text['body']):raise ValueError('Invalid checkpoint range')
    placements=t.run('''MATCH (:Text {id:$id})-[:PLACEMENT]->(p)
        WHERE p.start>=$start AND p.end<=$end
        RETURN properties(p) AS p ORDER BY p.ordinal''',id=id,start=start,end=end)
    if not placements or placements[0]['p']['start']!=start or placements[-1]['p']['end']!=end:
        raise ValueError('Checkpoints must align with sentence boundaries')
    ids=[row['p']['id'] for row in placements]
    changed=[row['p']['id'] for row in placements if row['p']['completed']!=completed]
    marked=0
    if changed:
        if completed:
            rows=t.run('''MATCH (:Text {id:$id})-[:PLACEMENT]->(p)-[:TOKEN]->()-[:WORD]->()-[:BASE_FORM]->(b:Word)-[:STATUS]->(s:LearningStatus)
                WHERE p.id IN $placements AND s.state='new'
                WITH DISTINCT b,s
                SET s.state='known',s.revision=s.revision+1,s.updatedAt=$stamp
                RETURN count(DISTINCT b) AS marked''',id=id,placements=ids,stamp=now())
            marked=rows[0]['marked']
            record_encounters(t,id,changed)
        t.run('''MATCH (:Text {id:$id})-[:PLACEMENT]->(p) WHERE p.id IN $placements
            SET p.completed=$completed,p.revision=p.revision+1,p.updatedAt=$stamp''',
            id=id,placements=changed,completed=completed,stamp=now())
        remaining=t.run('''MATCH (:Text {id:$id})-[:PLACEMENT]->(p)
            RETURN count(CASE WHEN p.completed=false THEN 1 END) AS remaining''',id=id)[0]['remaining']
        t.update(id,textState='new' if remaining else 'completed')
    return domain.text_detail(t,id)|{'markedKnown':marked}
