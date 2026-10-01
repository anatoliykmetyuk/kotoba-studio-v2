"""Offline schema evolution; invoked by `kotoba schema-plan/schema-apply`."""
import json,re,sys
from api.graph import Graph,Tx,packed,uid,Conflict
from api.schema import SCHEMA,validate_graph,InvalidGraph
p=json.load(sys.stdin);g=Graph()
with g.driver.session() as s:
 tx=s.begin_transaction();t=Tx(tx)
 try:
  t.run('MATCH (s:Schema {identityKey:"schema:active"}) SET s.revision=s.revision+1')
  if p.get('expectedFingerprint'):
   from api.vocabulary_cleanup import fingerprint
   if fingerprint(t.snapshot())!=p['expectedFingerprint']:raise Conflict('The corpus changed since the migration backup. Retry with a fresh backup.')
  if p.get('sourceSchema'):validate_graph(t.snapshot(),p['sourceSchema'])
  migration_report={}
  if p.get('migration')=='spelling-identity':
   from cli.spelling_identity import migrate
   from api.app import restore_into
   snapshot,migration_report=migrate(t.snapshot())
   restore_into(t,snapshot)
  if p.get('migration') in ('learning-status','spelling-identity'):
   from cli.learning_status import apply
   learning_report=apply(t)
   migration_report=migration_report|({'learningStatus':learning_report} if p.get('migration')=='spelling-identity' else learning_report)
  for statement in p['statements']:
   if re.search(r'\b(CALL|LOAD|DROP|CONSTRAINT|INDEX|DATABASE|TRANSACTIONS|USER|ROLE)\b',statement['query'],re.I):raise InvalidGraph('Only data transformations are allowed')
   t.run(statement['query'],**statement.get('params',{}))
  active=t.find('schema:active');t.update(active['id'],digest=SCHEMA['digest'],version=SCHEMA['version'])
  t.create('Audit','audit:'+uid(),actor='agent',action='schema.apply',details=packed({'digest':SCHEMA['digest']}))
  result=validate_graph(t.snapshot())
  if p['apply']:tx.commit()
  else:tx.rollback()
  print(json.dumps(result|{'applied':p['apply'],'migration':{k:v for k,v in migration_report.items() if k not in ('wordIds','statuses')}}))
 except BaseException:
  if not tx.closed():tx.rollback()
  raise
if p['apply']:g.initialize()
g.close()
