import copy,json
from pathlib import Path
import pytest
from api.schema import validate_graph,InvalidGraph
from cli.migrate import states

def test_status_migration_matrix():
 for spelling in ('読む','よむ','時々','𠮷'):
  for state in ('new','learning','familiar','known'):
   mapped=states(spelling,state)
   assert mapped['listening']==state
   assert mapped['reading']==(state if state in ('known','familiar') or spelling=='よむ' else 'new')

def corpus():
 path=Path('data/migration/graph.json')
 if not path.exists():pytest.skip('Generate the read-only migration plan first')
 from cli.spelling_identity import migrate
 from api.schema import SCHEMA
 graph,_=migrate(json.loads(path.read_text()))
 from cli.learning_status import migrate as unify
 graph,_=unify(graph)
 for n in graph['nodes']:
  if 'Schema' in n['labels']:n['properties']['digest']=SCHEMA['digest']
 return graph

def test_migration_reconciliation_and_no_writing():
 graph=corpus();validate_graph(graph)
 report=json.loads(next(n['properties']['payload'] for n in graph['nodes'] if n['properties']['identityKey']=='legacy:report'))
 assert len(report['texts'])==report['counts']['texts']
 assert len(report['vocabulary'])==report['counts']['vocabulary']
 assert len(report['phrases'])==report['counts']['phrase_vocabulary']
 assert all('Writing' not in n['labels'] for n in graph['nodes'])
 assert all(n['properties']['kind']!='writing' for n in graph['nodes'] if 'Activity' in n['labels'])
 for record in report['vocabulary']:
  base=record['baseId']
  evidence=next((json.loads(n['properties']['payload']) for n in graph['nodes'] if n['properties']['identityKey']=='migration:spelling-identity'),{})
  base=evidence.get('wordIds',{}).get(base,base)
  base=next(e['to'] for e in graph['edges'] if e['from']==base and e['type']=='BASE_FORM')
  owned={e['to'] for e in graph['edges'] if e['from']==base and e['type']=='STATUS'}
  actual=[n['properties']['state'] for n in graph['nodes'] if n['properties']['id'] in owned]
  order=['new','learning','familiar','known']
  assert len(actual)==1 and order.index(actual[0])>=min(order.index(v) for v in record['states'].values())

def test_phrase_requires_graph_members_and_one_status():
 graph=corpus();phrase=next(n['properties']['id'] for n in graph['nodes'] if 'Phrase' in n['labels'])
 for relation in ('PHRASE_MEMBER','STATUS'):
  bad=copy.deepcopy(graph);bad['edges']=[e for e in bad['edges'] if not(e['from']==phrase and e['type']==relation)]
  with pytest.raises(InvalidGraph):validate_graph(bad)

def test_no_goal_system_data_is_imported():
 graph=corpus()
 for node in graph['nodes']:
  p=node['properties']
  assert not p['identityKey'].startswith('legacy:records:')
  if 'Settings' in node['labels']:
   settings=json.loads(p['payload']);assert not {'wordsTarget','practiceTarget','pointsTarget','goals','targets'}&settings.keys()
   assert 'activity' not in settings.get('legacy',{})
  if 'Activity' in node['labels']:
   assert not {'points','credit_key','daily_activity_id'}&json.loads(p['details']).keys()
