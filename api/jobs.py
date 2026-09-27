"""Public, inspectable progress for durable import actions."""
import json,math
from datetime import datetime,timezone

def timestamp():return datetime.now(timezone.utc).isoformat()
def seconds(s):return datetime.fromisoformat(s).timestamp()
def progress(stage,completed,total,started_at):
    return {'stage':stage,'completed':completed,'total':total,'startedAt':started_at,'updatedAt':timestamp()}

def view(j,live=None):
    result=json.loads(j['result']);p=live or result.get('_progress')
    state=j['jobState'];now=datetime.now(timezone.utc).timestamp()
    if not p:p=progress('queued' if state=='pending' else 'starting',0,0,j['createdAt'])
    p=dict(p);elapsed=max(0,now-seconds(p['startedAt']));age=max(0,now-seconds(p['updatedAt']))
    stage=p['stage'];total=p['total'];completed=p['completed']
    units=completed+(total if stage in ('saving','validating','ready') else 0)
    all_units=2*total+1
    percent=min(99,int(100*units/all_units)) if total else 0
    remaining=math.ceil(elapsed*(all_units-units)/units) if units and state=='running' else None
    if state=='ready':percent=100;remaining=0;stage='ready';p['completed']=total;elapsed=max(0,seconds(j['updatedAt'])-seconds(p['startedAt']))
    if state=='failed':stage='failed';remaining=None;elapsed=max(0,seconds(j['updatedAt'])-seconds(p['startedAt']))
    if state=='pending':stage='queued';percent=0;remaining=None
    stalled=state=='running' and age>30
    if stalled:remaining=None
    payload=json.loads(j['payload'])
    return {'id':j['id'],'kind':j['kind'],'title':payload.get('title',''),'state':state,'error':j['error'],'attempts':j['attempts'],
            'result':{k:v for k,v in result.items() if not k.startswith('_')},
            'progress':p|{'stage':stage,'percent':percent,'elapsedSeconds':round(elapsed,1),'estimatedRemainingSeconds':remaining,
                          'secondsSinceProgress':round(age,1),'stalled':stalled,'leaseExpiresAt':j['lease']}}
