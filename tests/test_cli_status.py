import json
import subprocess
from types import SimpleNamespace

import pytest

from cli import main as cli


def test_status_reports_health_and_matching_tailscale_routes(monkeypatch,capsys):
 config={'TCP':{'3010':{'HTTPS':True},'8443':{'HTTPS':True}},'Web':{
  'example.ts.net:3010':{'Handlers':{'/':{'Proxy':'http://localhost:3010/'}}},
  'example.ts.net:8443':{'Handlers':{'/':{'Proxy':'http://127.0.0.1:3011'}}},
  'unrelated.ts.net:3010':{'Handlers':{'/other':{'Proxy':'http://127.0.0.1:3010'}}},
 }}
 def run(args,**kwargs):
  assert args==['tailscale','serve','status','--json']
  assert kwargs['timeout']==5
  return SimpleNamespace(stdout=json.dumps(config))
 monkeypatch.setattr(cli.subprocess,'run',run)
 monkeypatch.setattr(cli,'environment',lambda name:(None,{'KOTOBA_PORT':'3010'}))
 monkeypatch.setattr(cli,'call',lambda url,path:{'ready':True,'database':True})
 monkeypatch.setattr('sys.argv',['kotoba','status'])
 cli.main()
 assert json.loads(capsys.readouterr().out)=={'ready':True,'database':True,'urls':[
  'http://127.0.0.1:3010','https://example.ts.net:3010']}
 assert cli.app_urls('http://127.0.0.1:3011')==['http://127.0.0.1:3011','https://example.ts.net:8443']


@pytest.mark.parametrize('failure',[FileNotFoundError(),subprocess.CalledProcessError(1,'tailscale'),
 subprocess.TimeoutExpired('tailscale',5),ValueError('invalid JSON')])
def test_optional_discovery_failure_preserves_urls(monkeypatch,failure):
 def run(*args,**kwargs):raise failure
 monkeypatch.setattr(cli.subprocess,'run',run)
 assert cli.app_urls('http://127.0.0.1:3010/','https://public.example/')==[
  'http://127.0.0.1:3010','https://public.example']


def test_remote_override_does_not_discover_local_routes(monkeypatch,capsys):
 monkeypatch.setattr(cli,'environment',lambda name:(None,{'KOTOBA_PORT':'3010','KOTOBA_PUBLIC_URL':'https://local.example'}))
 monkeypatch.setattr(cli,'call',lambda url,path:{'ready':True})
 def unexpected(*args,**kwargs):pytest.fail('Remote endpoint must not discover local routes')
 monkeypatch.setattr(cli.subprocess,'run',unexpected)
 monkeypatch.setattr('sys.argv',['kotoba','--url','https://remote.example','status'])
 cli.main()
 assert json.loads(capsys.readouterr().out)['urls']==['https://remote.example']
