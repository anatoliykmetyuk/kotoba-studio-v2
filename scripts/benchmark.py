import json,time,statistics,os
from pathlib import Path
import httpx
URL=os.getenv('KOTOBA_TEST_BASE_URL','http://127.0.0.1:3011').rstrip('/')+'/api/v1'
with httpx.Client(timeout=120) as c:
 text=c.get(URL+'/texts').json()[0];detail=c.get(URL+'/texts/'+text['id']).json();token=detail['sentences'][0]['tokens'][0]
 paths={'library':'/texts','reader':'/texts/'+text['id'],'word':'/words/'+token['wordId'],'explore':'/explore?minimum=0.8','word-examples':'/explore?wordId='+token['baseId'],'audit':'/graph/audit'}
 results={}
 for name,path in paths.items():
  elapsed=[]
  for _ in range(5):
   start=time.monotonic();r=c.get(URL+path);r.raise_for_status();elapsed.append(round((time.monotonic()-start)*1000,1))
  results[name]={'medianMs':statistics.median(elapsed),'maxMs':max(elapsed)}
 elapsed=[]
 for _ in range(8):
  start=time.monotonic();r=c.put(URL+'/words/'+token['wordId']+'/status',json={'area':'reading','state':token['states']['reading']});r.raise_for_status();elapsed.append(round((time.monotonic()-start)*1000,1))
 results['status-update']={'medianMs':statistics.median(elapsed),'maxMs':max(elapsed)}
 results['graph']=c.get(URL+'/graph/audit').json()
 Path('.runtime/benchmarks.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
