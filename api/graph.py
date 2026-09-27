import json,os,uuid,hashlib,re
from datetime import datetime,timezone
from neo4j import GraphDatabase
from api.schema import SCHEMA,validate_graph,validate_properties,InvalidGraph

def now(): return datetime.now(timezone.utc).isoformat()
def uid(): return str(uuid.uuid4())
def digest(value): return hashlib.sha256(value.encode()).hexdigest()
def packed(value): return json.dumps(value,ensure_ascii=False,separators=(',',':'))
class Conflict(ValueError): pass
class Missing(ValueError): pass

class Tx:
    def __init__(self,tx,scalar_only=False): self.tx=tx;self.scalar_only=scalar_only
    def _execute(self,query,/,**params):return [r.data() for r in self.tx.run(query,params)]
    def run(self,query,/,**params):
        if self.scalar_only and re.search(r'\b(CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|CALL|LOAD)\b',query,re.I):raise InvalidGraph('Scalar transaction cannot execute graph mutations')
        return self._execute(query,**params)
    def get(self,id):
        rows=self.run('MATCH (n:Entity {id:$id}) RETURN properties(n) AS n, labels(n) AS labels',id=id)
        if not rows: raise Missing('Entity not found')
        return rows[0]['n'] | {'type':next(l for l in rows[0]['labels'] if l!='Entity')}
    def find(self,key):
        r=self.run('MATCH (n:Entity {identityKey:$key}) RETURN properties(n) AS n',key=key)
        return r[0]['n'] if r else None
    def meaning_sources(self,id):
        return self.run('MATCH (w:Word {id:$id})-[:HAS_MEANING]->(m:Meaning) RETURN m.sourceType AS sourceType,m.sourceKey AS sourceKey',id=id)
    def create(self,concept,key,**props):
        if concept not in SCHEMA['classes'] or concept=='Entity': raise InvalidGraph('Unknown concept')
        if self.scalar_only and concept not in ('Audit','Mutation','Activity','Settings'):raise InvalidGraph('Scalar transaction cannot create domain entities')
        existing=self.find(key)
        if existing:return existing
        p={'id':props.pop('id',uid()),'identityKey':key,'revision':0,'createdAt':now(),'updatedAt':now(),**props}
        validate_properties(concept,p)
        self._execute(f'CREATE (n:Entity:{concept}) SET n=$p',p=p);return p
    def update(self,id,expected=None,**props):
        old=self.get(id)
        if expected is not None and old['revision']!=expected: raise Conflict('This record changed. Reload and retry.')
        if any(k in props for k in ('id','identityKey','revision','createdAt')): raise InvalidGraph('Identity and revision are immutable')
        if self.scalar_only:
            allowed={'LearningStatus':{'state'},'Text':{'title','archived','cursor','textState'},'Job':{'jobState','lease','attempts','error','result'},'Settings':{'payload'}}
            if not set(props)<=allowed.get(old['type'],set()):raise InvalidGraph('This update requires structural validation')
        validate_properties(old['type'],{k:v for k,v in (old|props).items() if k!='type'})
        self._execute('MATCH (n:Entity {id:$id}) SET n += $p, n.revision=n.revision+1, n.updatedAt=$now',id=id,p=props,now=now())
        return self.get(id)
    def link(self,a,rel,b):
        if self.scalar_only:raise InvalidGraph('Scalar transaction cannot change relationships')
        if rel not in SCHEMA['relations']: raise InvalidGraph('Unknown relationship')
        self.run(f'MATCH (a:Entity {{id:$a}}),(b:Entity {{id:$b}}) MERGE (a)-[:{rel}]->(b)',a=a,b=b)
    def unlink(self,a,rel,b=None):
        if self.scalar_only:raise InvalidGraph("Scalar transaction cannot change relationships")
        if rel not in SCHEMA['relations']: raise InvalidGraph('Unknown relationship')
        self.run(f'MATCH (a:Entity {{id:$a}})-[r:{rel}]->(b) WHERE $b IS NULL OR b.id=$b DELETE r',a=a,b=b)
    def snapshot(self):
        return {'nodes':self.run('MATCH (n) RETURN elementId(n) AS internalId, labels(n) AS labels, properties(n) AS properties'), 'edges':self.run('MATCH (a)-[r]->(b) RETURN a.id AS `from`,type(r) AS type,b.id AS `to`,properties(r) AS properties')}

class Graph:
    def __init__(self):
        self.driver=GraphDatabase.driver(os.getenv('NEO4J_URI','bolt://127.0.0.1:17687'),auth=None)
    def read(self,fn):
        with self.driver.session() as s:return s.execute_read(lambda tx:fn(Tx(tx)))
    def initialize(self):
        with self.driver.session() as s:
            if s.run("SHOW INDEXES YIELD name, owningConstraint WHERE name='Word_surface' AND owningConstraint IS NULL RETURN name").data():
                s.run('DROP INDEX Word_surface IF EXISTS').consume()
            for cls,keys in SCHEMA['keys'].items():
                for fields in keys:
                    expr=','.join('n.'+x for x in fields)
                    s.run(f'CREATE CONSTRAINT {cls}_{"_".join(fields)} IF NOT EXISTS FOR (n:{cls}) REQUIRE ({expr}) IS UNIQUE').consume()
            for kind in ['Word','Text','Sentence','Job','WordOccurrence','SentenceOccurrence']:
                s.run(f'CREATE INDEX {kind}_id IF NOT EXISTS FOR (n:{kind}) ON (n.id)').consume()
            s.run('CREATE INDEX Job_queue IF NOT EXISTS FOR (n:Job) ON (n.jobState,n.createdAt)').consume()

            def boot(tx):
                t=Tx(tx);current=t.find('schema:active')
                if current and current['digest']!=SCHEMA['digest']:raise InvalidGraph('Database schema differs. Run schema migration before starting.')
                t.create('Schema','schema:active',digest=SCHEMA['digest'],version=SCHEMA['version'])
                validate_graph(t.snapshot())
            s.execute_write(boot)
    def write(self,action,fn,request_id=None,actor='user',dry_run=False,scalar_only=False):
        with self.driver.session() as s:
            tx=s.begin_transaction();t=Tx(tx)
            try:
                # One database lock serializes all writers, including agent transactions.
                t.run('MATCH (s:Schema {identityKey:"schema:active"}) SET s.revision=s.revision+1 RETURN s.id')
                schema=t.find('schema:active')
                if not schema or schema['digest']!=SCHEMA['digest']:raise InvalidGraph('Schema mismatch')
                old=t.find('mutation:'+request_id) if request_id else None
                if old:tx.rollback();return json.loads(old['result'])
                t.scalar_only=scalar_only
                result=fn(t)
                if request_id:t.create('Mutation','mutation:'+request_id,result=packed(result))
                t.create('Audit','audit:'+uid(),actor=actor,action=action,details=packed({'requestId':request_id}))
                if not scalar_only:validate_graph(t.snapshot())
                if dry_run:tx.rollback()
                else:tx.commit()
                return result
            except BaseException:tx.rollback();raise
    def query(self,query,params=None):
        def execute(t):
            summary=t.tx.run('EXPLAIN '+query,params or {}).consume()
            if summary.query_type!='r' or re.search(r'\b(CALL|LOAD)\b',query,re.I):raise InvalidGraph('Read query required; use graph transaction for mutations')
            return [r.data() for r in t.tx.run(query,params or {})]
        return self.read(execute)
    def raw_write(self,statements,dry_run=False,expected_revisions=None):
        def apply(t):
            for id,revision in (expected_revisions or {}).items():
                if t.get(id)['revision']!=revision:raise Conflict('Graph entity changed. Reload and retry.')
            old_snapshot=t.snapshot();before={n['internalId']:n for n in old_snapshot['nodes']}
            old_edges={(e['from'],e['type'],e['to']) for e in old_snapshot['edges']}
            results=[]
            for item in statements:
                q=item['query']
                if re.search(r'\b(CALL|LOAD|DROP|CONSTRAINT|INDEX|DATABASE|TRANSACTIONS|USER|ROLE)\b',q,re.I):raise InvalidGraph('Administrative operations belong to schema commands')
                results.append(t.run(q,**item.get('params',{})))
            new_snapshot=t.snapshot();after={n['internalId']:n for n in new_snapshot['nodes']}
            new_edges={(e['from'],e['type'],e['to']) for e in new_snapshot['edges']}
            affected={x for a,_,b in old_edges.symmetric_difference(new_edges) for x in (a,b)}
            for eid,old in before.items():
                previous=old['properties'];new=after.get(eid)
                protected=bool(set(old['labels']) & {'Schema','Audit','Mutation'})
                if not new:
                    if protected:raise InvalidGraph('Cannot delete operational records through graph data transactions')
                    continue
                p=new['properties']
                if old['labels']!=new['labels'] or any(previous[k]!=p.get(k) for k in ('id','identityKey','createdAt','revision')):raise InvalidGraph('Identity, type and revisions are managed by the service')
                if previous!=p or p['id'] in affected:
                    if protected:raise InvalidGraph('Cannot edit operational records through graph data transactions')
                    t.update(p['id'])
            return results
        return self.write('graph.transaction',apply,actor='agent',dry_run=dry_run)
    def close(self):self.driver.close()
