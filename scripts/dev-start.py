import os,subprocess,json
from pathlib import Path
root=Path(__file__).resolve().parents[1];runtime=root/'.runtime';runtime.mkdir(exist_ok=True)
env=os.environ|{'KOTOBA_WORKER_TOKEN':'dev-only','KOTOBA_API_URL':'http://127.0.0.1:8791','HF_HUB_OFFLINE':'1'}
processes={}
for name,args in [('api',[str(root/'.venv/bin/python'),'-m','uvicorn','api.app:app','--host','127.0.0.1','--port','8791']),('web',['npm','run','dev']),('worker',[str(root/'.venv/bin/python'),'-m','worker.main'])]:
 with (runtime/(name+'.log')).open('a') as output:
  p=subprocess.Popen(args,cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,start_new_session=True);processes[name]=p.pid
(runtime/'dev-pids.json').write_text(json.dumps(processes));print(processes)
