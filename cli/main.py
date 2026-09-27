"""Project-local operator CLI. All application output is JSON."""
import argparse,json,os,signal,subprocess,sys,time,secrets
from pathlib import Path
import httpx
ROOT=Path(__file__).resolve().parents[1]

def environment(name):
 runtime=ROOT/'.runtime'/name;runtime.mkdir(parents=True,exist_ok=True);path=runtime/'environment.json'
 if path.exists():env=json.loads(path.read_text())
 else:
  env={'KOTOBA_WORKER_TOKEN':secrets.token_urlsafe(32),'KOTOBA_PORT':'3010' if name=='production' else '3011'}
  path.write_text(json.dumps(env));path.chmod(0o600)
 env['KOTOBA_DATA_DIR']=str(ROOT/'data/docker'/name)
 return runtime,env

def compose(name,args,**kwargs):
 _,env=environment(name)
 if not kwargs.get('capture_output') and 'stdout' not in kwargs:kwargs['stdout']=sys.stderr
 files=['-f',str(ROOT/'compose.yaml')]
 if name=='production':files+=['-f',str(ROOT/'compose.production.yaml')]
 if name=='acceptance':files+=['-f',str(ROOT/'compose.acceptance.yaml')]
 return subprocess.run(['docker','compose','-p','kotoba-v2-'+name,*files,*args],cwd=ROOT,env=os.environ|env,check=True,**kwargs)
def start_ichiran():
 subprocess.run(['docker','compose','-p','kotoba-v2-ichiran','-f',str(ROOT/'compose.ichiran.yaml'),'up','-d','--build'],cwd=ROOT,check=True,stdout=sys.stderr)
 deadline=time.monotonic()+300
 with httpx.Client(timeout=5) as c:
  while time.monotonic()<deadline:
   try:
    if c.get('http://127.0.0.1:'+os.getenv('KOTOBA_ICHIRAN_PORT','8091')+'/health').is_success:return
   except httpx.HTTPError:pass
   time.sleep(1)
 raise SystemExit('Ichiran is still initializing. Inspect its compose logs before retrying.')

def stop_worker(name):
 runtime,_=environment(name);pidfile=runtime/'worker.pid'
 if pidfile.exists():
  pid=int(pidfile.read_text());cmd=subprocess.run(['ps','-p',str(pid),'-o','command='],capture_output=True,text=True).stdout
  cwd=subprocess.run(['lsof','-a','-p',str(pid),'-d','cwd','-Fn'],capture_output=True,text=True).stdout
  if '-m worker.main' in cmd and '\nn'+str(ROOT)+'\n' in cwd:
   os.kill(pid,signal.SIGTERM)
   for _ in range(40):
    try:os.kill(pid,0)
    except ProcessLookupError:break
    time.sleep(.25)
   else:os.kill(pid,signal.SIGKILL)
  pidfile.unlink(missing_ok=True)
def start_worker(name):
 stop_worker(name);runtime,env=environment(name)
 env=os.environ|env|{'KOTOBA_API_URL':'http://127.0.0.1:'+env['KOTOBA_PORT'],'HF_HUB_OFFLINE':'1','KOTOBA_TTS_MODEL':str(ROOT/'data/models/kokoro')}
 with (runtime/'worker.log').open('a') as log:
  proc=subprocess.Popen([str(ROOT/'.venv/bin/python'),'-m','worker.main'],cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
 (runtime/'worker.pid').write_text(str(proc.pid))

def call(url,path,body=None,method=None):
 with httpx.Client(timeout=300) as c:
  r=c.request(method or ('GET' if body is None else 'POST'),url.rstrip('/')+'/api/v1'+path,json=body);r.raise_for_status();return r.json()
def wait_ready(url):
 deadline=time.monotonic()+90
 with httpx.Client(timeout=5) as client:
  while time.monotonic()<deadline:
   try:
    response=client.get(url.rstrip('/')+'/api/v1/health')
    if response.is_success and response.json().get('ready'):return
   except (httpx.HTTPError,ValueError):pass
   time.sleep(1)
 raise SystemExit('API did not become ready; inspect docker compose logs.')
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--environment',choices=['production','acceptance'],default='production');p.add_argument('--url');sub=p.add_subparsers(dest='command',required=True)
 for name in ('start','stop','status','worker-restart','schema','audit'):sub.add_parser(name)
 q=sub.add_parser('query');q.add_argument('cypher');q.add_argument('--params',default='{}')
 q=sub.add_parser('transaction');q.add_argument('file',type=Path);q.add_argument('--dry-run',action='store_true')
 q=sub.add_parser('request');q.add_argument('method');q.add_argument('path');q.add_argument('--json');q.add_argument('--file',type=Path)
 q=sub.add_parser('backup');q.add_argument('directory',type=Path)
 q=sub.add_parser('restore');q.add_argument('directory',type=Path)
 q=sub.add_parser('retokenize-plan')
 q=sub.add_parser('retokenize-apply');q.add_argument('--job',required=True);q.add_argument('--backup',type=Path,required=True);q.add_argument('--fingerprint',required=True)
 q=sub.add_parser('vocabulary-plan')
 q=sub.add_parser('vocabulary-apply');q.add_argument('--backup',type=Path,required=True);q.add_argument('--fingerprint',required=True)
 q=sub.add_parser('schema-plan');q.add_argument('--transformation',type=Path);q.add_argument('--migration',choices=['spelling-identity'])
 q=sub.add_parser('schema-apply');q.add_argument('--transformation',type=Path);q.add_argument('--backup',type=Path,required=True);q.add_argument('--migration',choices=['spelling-identity'])
 a=p.parse_args();runtime,env=environment(a.environment);url=a.url or 'http://127.0.0.1:'+env['KOTOBA_PORT']
 if a.command=='start':
  start_ichiran()
  compose(a.environment,['up','-d','--build']);
  wait_ready(url)
  start_worker(a.environment);result={'url':env.get('KOTOBA_PUBLIC_URL',url),'environment':a.environment}
 elif a.command=='stop':stop_worker(a.environment);compose(a.environment,['stop']);result={'stopped':a.environment}
 elif a.command=='worker-restart':start_worker(a.environment);result={'worker':'restarted'}
 elif a.command=='status':result=call(url,'/health')
 elif a.command=='schema':result=call(url,'/schema')
 elif a.command=='audit':result=call(url,'/graph/audit')
 elif a.command=='query':result=call(url,'/graph/query',{'query':a.cypher,'params':json.loads(a.params)})
 elif a.command=='transaction':result=call(url,'/graph/transaction',{'statements':json.loads(a.file.read_text()),'dryRun':a.dry_run})
 elif a.command=='request':result=call(url,a.path,json.loads(a.file.read_text() if a.file else a.json) if a.file or a.json else None,a.method.upper())
 elif a.command=='retokenize-plan':result=call(url,'/maintenance/retokenize/plan',{})
 elif a.command=='retokenize-apply':
  from api.vocabulary_cleanup import fingerprint
  data=call(url,'/graph/export')
  if fingerprint(data)!=a.fingerprint:raise SystemExit('The corpus changed. Create and inspect a fresh retokenization plan.')
  a.backup.mkdir(parents=True,exist_ok=False)
  (a.backup/'graph.json').write_text(json.dumps(data,ensure_ascii=False));(a.backup/'schema.json').write_text(json.dumps(call(url,'/schema')))
  compose(a.environment,['exec','-T','api','tar','-czf','-','-C','/data','media'],stdout=(a.backup/'media.tar.gz').open('wb'))
  result=call(url,'/maintenance/retokenize/apply',{'jobId':a.job,'expectedFingerprint':a.fingerprint})
  (a.backup/'retokenize-report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 elif a.command=='vocabulary-plan':result=call(url,'/maintenance/exclude-latin-vocabulary',{'dryRun':True})
 elif a.command=='vocabulary-apply':
  from api.vocabulary_cleanup import fingerprint
  data=call(url,'/graph/export')
  if fingerprint(data)!=a.fingerprint:raise SystemExit('The corpus changed since the plan. Review a fresh vocabulary-plan.')
  a.backup.mkdir(parents=True,exist_ok=False)
  (a.backup/'graph.json').write_text(json.dumps(data,ensure_ascii=False));(a.backup/'schema.json').write_text(json.dumps(call(url,'/schema')))
  compose(a.environment,['exec','-T','api','tar','-czf','-','-C','/data','media'],stdout=(a.backup/'media.tar.gz').open('wb'))
  result=call(url,'/maintenance/exclude-latin-vocabulary',{'dryRun':False,'expectedFingerprint':a.fingerprint})
  (a.backup/'cleanup-report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 elif a.command=='backup':
  a.directory.mkdir(parents=True,exist_ok=True);data=call(url,'/graph/export');(a.directory/'graph.json').write_text(json.dumps(data,ensure_ascii=False));(a.directory/'schema.json').write_text(json.dumps(call(url,'/schema')))
  compose(a.environment,['exec','-T','api','tar','-czf','-','-C','/data','media'],stdout=(a.directory/'media.tar.gz').open('wb'));result={'backup':str(a.directory.resolve()),'nodes':len(data['nodes'])}
 elif a.command=='restore':
  from api.schema import validate_graph
  data=json.loads((a.directory/'graph.json').read_text());validate_graph(data)
  stop_worker(a.environment)
  try:
   compose(a.environment,['exec','-T','api','tar','-xzf','-','-C','/data'],stdin=(a.directory/'media.tar.gz').open('rb'))
   result=call(url,'/graph/restore',data)
  finally:start_worker(a.environment)
 elif a.command in ('schema-plan','schema-apply'):
  from api.schema import validate_graph,SCHEMA
  data=call(url,'/graph/export');old=call(url,'/schema')
  if a.command=='schema-apply':
   a.backup.mkdir(parents=True,exist_ok=True);(a.backup/'graph.json').write_text(json.dumps(data,ensure_ascii=False));(a.backup/'schema.json').write_text(json.dumps(old))
   compose(a.environment,['exec','-T','api','tar','-czf','-','-C','/data','media'],stdout=(a.backup/'media.tar.gz').open('wb'))
  transformation=json.loads(a.transformation.read_text()) if a.transformation else []
  payload={'statements':transformation,'apply':a.command=='schema-apply','migration':a.migration}
  if payload['apply']:stop_worker(a.environment);compose(a.environment,['stop','api'])
  compose(a.environment,['build','api'])
  proc=compose(a.environment,['run','--rm','--no-deps','-T','api','python','-m','cli.schema_admin'],input=json.dumps(payload),text=True,capture_output=True);result=json.loads(proc.stdout)
  if payload['apply']:
   compose(a.environment,['up','-d','api']);compose(a.environment,['restart','web']);wait_ready(url);start_worker(a.environment)
 else:raise SystemExit('Unknown command')
 print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
