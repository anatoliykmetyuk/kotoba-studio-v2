"""Exercise actual offline schema commands against the disposable database.

Historical schema fixtures are official generated contracts, retained unedited
for migration compatibility checks, not alternative current schemas.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from api.graph import Graph
from api.schema import SCHEMA,validate_graph
from api.vocabulary_cleanup import fingerprint
from cli.migrate import Memory


@pytest.fixture
def database():
    if os.getenv('KOTOBA_TEST_DATABASE')!='disposable':pytest.fail('Enable the owned disposable database')
    assert os.getenv('NEO4J_URI','bolt://127.0.0.1:17687')=='bolt://127.0.0.1:17687'
    g=Graph();yield g;g.close()


def historical(meaning_identity=False):
    schema=json.loads(Path('tests/fixtures/schema-'+('meaning-identity' if meaning_identity else 'learning-areas')+'.json').read_text())
    m=Memory();m.create('Schema','schema:active',digest=schema['digest'],version=schema['version'])
    for owner,meaning in [('a','first'),('b','second')] if meaning_identity else [('a',None)]:
        fields={'meaning':meaning} if meaning_identity else {}
        m.create('Word','old:'+owner,id=owner,surface='試験',reading='しけん',partOfSpeech='noun',family=owner,**fields)
        m.link(owner,'BASE_FORM',owner)
        for area,state in [('reading','known'),('listening','familiar')]:
            status=m.create('LearningStatus',f'status:{owner}:{area}',area=area,state=state);m.link(owner,'STATUS',status['id'])
    m.create('Text','text:test',title='Preservation fixture',body='試験',cursor=1,textState='new',archived=False)
    snapshot=m.snapshot();validate_graph(snapshot,schema)
    return snapshot,schema


def seed(g,snapshot):
    with g.driver.session() as session:
        session.run('MATCH (n) DETACH DELETE n').consume()
        # This constraint did not exist on the historical homograph schema.
        surfaces=[n['properties']['surface'] for n in snapshot['nodes'] if 'Word' in n['labels']]
        if len(set(surfaces))!=len(surfaces):session.run('DROP CONSTRAINT Word_surface IF EXISTS').consume()
        for kind in {next(k for k in n['labels'] if k!='Entity') for n in snapshot['nodes']}:
            session.run(f'UNWIND $nodes AS p CREATE (n:Entity:{kind}) SET n=p',nodes=[n['properties'] for n in snapshot['nodes'] if kind in n['labels']]).consume()
        for edge in snapshot['edges']:
            session.run(f'MATCH (a:Entity {{id:$a}}),(b:Entity {{id:$b}}) CREATE (a)-[:{edge["type"]}]->(b)',a=edge['from'],b=edge['to']).consume()


def command(snapshot,schema,migration,apply=False,expected=None):
    payload={'statements':[],'migration':migration,'apply':apply,'sourceSchema':schema,'expectedFingerprint':expected or fingerprint(snapshot)}
    return subprocess.run([sys.executable,'-m','cli.schema_admin'],input=json.dumps(payload),text=True,capture_output=True)


def test_status_plan_rollback_apply_preservation_and_guard(database):
    snapshot,schema=historical();seed(database,snapshot)
    before=database.read(lambda t:t.snapshot());result=command(snapshot,schema,'learning-status')
    assert result.returncode==0,result.stderr
    assert json.loads(result.stdout)['applied'] is False
    assert fingerprint(database.read(lambda t:t.snapshot()))==fingerprint(before)
    rejected=command(snapshot,schema,'learning-status',True,'0'*64)
    assert rejected.returncode!=0 and 'corpus changed' in rejected.stderr
    assert fingerprint(database.read(lambda t:t.snapshot()))==fingerprint(before)
    applied=command(snapshot,schema,'learning-status',True)
    assert applied.returncode==0,applied.stderr
    after=database.read(lambda t:t.snapshot());assert validate_graph(after)['valid']
    old_text=next(n['properties'] for n in snapshot['nodes'] if 'Text' in n['labels'])
    assert next(n['properties'] for n in after['nodes'] if 'Text' in n['labels'])==old_text
    status=[n['properties'] for n in after['nodes'] if 'LearningStatus' in n['labels']]
    assert len(status)==1 and status[0]['state']=='familiar' and 'area' not in status[0]


def test_existing_spelling_command_chains_unified_status_upgrade(database):
    snapshot,schema=historical(True);seed(database,snapshot)
    result=command(snapshot,schema,'spelling-identity',True)
    assert result.returncode==0,result.stderr
    after=database.read(lambda t:t.snapshot());assert validate_graph(after)['valid']
    assert len([n for n in after['nodes'] if 'Word' in n['labels']])==1
    assert [n['properties']['state'] for n in after['nodes'] if 'LearningStatus' in n['labels']]==['familiar']
    assert {n['properties']['body'] for n in after['nodes'] if 'Meaning' in n['labels']}=={'first','second'}
