"""Compile the official OML JSON AST into the application's closed-world profile."""
import hashlib, json, subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def local(ref): return ref['$ref'].split(':')[-1]
def compile_schema():
    subprocess.run([str(ROOT/"ontology/gradlew"), "-p", str(ROOT/"ontology"), "build", "--rerun-tasks", "--console=plain"], check=True)
    result = {'version': 1, 'classes': {}, 'properties': {}, 'relations': {}, 'enums': {}, 'keys': {}}
    statements = []
    for path in sorted((ROOT/'ontology/build/json/kotoba.local').glob('*.omljson')):
        doc = json.loads(path.read_text()); statements += doc['ownedStatements']
    if not statements: raise ValueError('Run official OML validation/conversion first.')
    for s in statements:
        kind = s['eClass'].split('//')[-1]; name = s.get('name')
        if kind in ('Aspect','Concept'):
            name = name or local(s['ref'])
            c = result['classes'].setdefault(name, {'abstract': kind=='Aspect', 'parents': [], 'required': {}, 'relations': {}})
            c['parents'] += [local(x['superTerm']) for x in s.get('ownedSpecializations',[])]
            for r in s.get('ownedPropertyRestrictions',[]):
                if not r['eClass'].endswith('PropertyCardinalityRestrictionAxiom'): raise ValueError(f'Unsupported restriction: {r}')
                if r.get('kind','exactly') != 'exactly' or r.get('range'): raise ValueError(f'Unsupported cardinality: {r}')
                prop = r['property']; target = c['required'] if prop['eClass'].endswith('ScalarProperty') else c['relations']
                target[local(prop)] = r.get('cardinality',1)
            for key in s.get('ownedKeys',[]): result['keys'].setdefault(name,[]).append([local(p) for p in key['properties']])
        elif kind == 'ScalarProperty':
            if not s.get('functional') or len(s.get('ranges',[])) != 1: raise ValueError('Only functional scalar properties are supported')
            result['properties'][name] = local(s['ranges'][0])
        elif kind == 'Scalar':
            if 'ownedEnumeration' not in s: raise ValueError(f'Unsupported custom scalar {name}')
            result['enums'][name] = [v['value'] for v in s['ownedEnumeration']['literals']]
        elif kind == 'UnreifiedRelation':
            result['relations'][name]={'from':[local(x) for x in s['sources']], 'to':[local(x) for x in s['targets']], 'functional':s.get('functional',False)}
        else: raise ValueError(f'Unsupported OML construct: {kind}')
    for name,c in result['classes'].items():
        for parent in c['parents']:
            if parent != 'Entity': raise ValueError(f'Unsupported inheritance {parent}')
            c['required'] = result['classes'][parent]['required'] | c['required']
    h=hashlib.sha256()
    for p in sorted((ROOT/'ontology/src').glob('*.oml')): h.update(p.name.encode()); h.update(p.read_bytes())
    result['digest']=h.hexdigest()
    out=ROOT/'ontology/compiled.json'; out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(f'Compiled {len(result["classes"])-1} concepts; schema {result["digest"][:12]}')
if __name__=='__main__': compile_schema()
