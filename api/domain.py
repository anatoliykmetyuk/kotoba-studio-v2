import json,uuid
from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo
from api.graph import digest,uid,packed,now,Missing,Conflict
from api.schema import InvalidGraph
from api.language import analyze
from api.vocabulary import eligible_tokens,latin_word

AREAS=('reading','listening');STATES=('new','learning','familiar','known')
# Stored dictionary entry and sense numbers define presentation order. Graph
# relationship iteration is unordered and must not select a practice answer.
MEANING_ORDER="""m.sourceType,
    CASE WHEN m.sourceKey STARTS WITH 'jmdict:' THEN toInteger(split(m.sourceKey,':')[1]) END,
    CASE WHEN m.sourceKey STARTS WITH 'jmdict:' THEN toInteger(split(m.sourceKey,':')[2]) END,
    m.sourceKey,m.body"""
def status_nodes(t,owner):
    return {r['s']['area']:r['s'] for r in t.run('MATCH (w:Entity {id:$id})-[:STATUS]->(s) RETURN properties(s) AS s',id=owner)}
def create_statuses(t,owner,states=None):
    for area in AREAS:
        s=t.create('LearningStatus',f'status:{owner}:{area}',area=area,state=(states or {}).get(area,'new'));t.link(owner,'STATUS',s['id'])
def add_meanings(t,word,choices,*,direct_lookup=False):
    if not any(c.get('meaning','').strip() for c in choices):return
    stored={(m['sourceType'],m['sourceKey']) for m in t.meaning_sources(word['id'])}
    for choice in choices:
        # An ambiguous inflection may name several lexical roots. Its surface
        # retains every alternative, while a canonical Word owns only its senses.
        if not direct_lookup and word['family']==word['id'] and choice.get('base',word['surface'])!=word['surface']:continue
        body=choice.get('meaning','').strip()
        if not body:continue
        props={'body':body,'reading':choice.get('baseReading',word['reading']),
               'partOfSpeech':choice.get('partOfSpeech',word['partOfSpeech']),
               'sourceType':choice.get('sourceType','corpus'),
               'sourceKey':choice.get('sense','corpus:'+digest(body))}
        source=(props['sourceType'],props['sourceKey'])
        if props['sourceType']=='JMdict' and source in stored:continue
        stored.add(source)
        m=t.create('Meaning','meaning:'+digest(packed(props)),**props)
        t.link(word['id'],'HAS_MEANING',m['id'])

def family(t,token,choice):
    if latin_word(token['surface']):raise ValueError('Latin text is not vocabulary')
    if choice.get('baseId'):
        base=t.get(choice['baseId'])
        if base.get('family')!=base['id']:base=t.get(base['family'])
        if not latin_word(base['surface']):return base
        choice={k:v for k,v in choice.items() if k!='baseId'}
        choice=choice|{'base':token['surface'],'baseReading':token['reading']}
    elif latin_word(choice['base']):
        choice=choice|{'base':token['surface'],'baseReading':token['reading']}
    key='word:'+digest(choice['base'])
    base=t.find(key)
    if not base:
        id=t.new_id(key) if hasattr(t,'new_id') else uid()
        base=t.create('Word',key,id=id,surface=choice['base'],reading=choice.get('baseReading',token['baseReading']),partOfSpeech=token['partOfSpeech'],family=id)
        t.link(id,'BASE_FORM',id);create_statuses(t,id)
    add_meanings(t,base,[choice])
    return t.get(base['family']) if base['family']!=base['id'] else base

def word_form(t,base,token):
    if latin_word(token['surface']):raise ValueError('Latin text is not vocabulary')
    if base['surface']==token['surface']:return base
    key='word:'+digest(token['surface']);word=t.find(key)
    if not word:
        word=t.create('Word',key,surface=token['surface'],reading=token['reading'],partOfSpeech=token['partOfSpeech'],family=base['id'])
        t.link(word['id'],'BASE_FORM',base['id'])
    return word

def add_source(t,text,payload):
    folder=payload.get('folder','').strip()
    if folder:
        f=t.create('Folder','folder:'+folder.casefold(),name=folder);t.link(f['id'],'CONTAINS',text['id'])
    url=payload.get('sourceUrl','').strip()
    if url:
        s=t.create('Source','source:'+url,url=url,sourceType='youtube' if 'youtu' in url else 'article')
        p=t.create('Provenance','provenance:'+digest(text['id']+url+payload['title']),details=packed({'originalTitle':payload['title'],'importedAt':now()}))
        t.link(text['id'],'PROVENANCE',p['id']);t.link(p['id'],'SOURCE',s['id'])

def create_job(t,kind,payload,key=None):
    return t.create('Job',key or 'job:'+uid(),kind=kind,payload=packed(payload),result='{}',error='',jobState='pending',lease='',attempts=0)

def prepare_import(t,payload):
    body=payload['body'].replace('\r\n','\n').replace('\r','\n')
    if not body.strip():raise ValueError('Paste some Japanese text first.')
    existing=t.find('text:'+digest(body))
    if existing:
        add_source(t,existing,payload);return {'textId':existing['id'],'duplicate':True}
    payload=payload|{'body':body}
    j=create_job(t,'import',payload,'import:'+digest(body))
    if j['jobState']=='failed':j=t.update(j['id'],jobState='pending',error='')
    return {'jobId':j['id'],'duplicate':False}

def finalize_import(t,payload,result,report=None):
    body=payload['body'];existing=t.find('text:'+digest(body))
    if existing:add_source(t,existing,payload);return {'textId':existing['id'],'duplicate':True}
    text=t.create('Text','text:'+digest(body),title=payload['title'],body=body,textState='new',cursor=0,archived=False)
    add_source(t,text,payload)
    if payload.get('previousId'):t.link(text['id'],'PREVIOUS',payload['previousId'])
    imported_words={}
    for i,s in enumerate(result['sentences']):
        sentence=t.create('Sentence','sentence:'+digest(s['body']),body=s['body'])
        place=t.create('SentenceOccurrence',f'placement:{text["id"]}:{i}',ordinal=i,start=s['start'],end=s['end'])
        t.link(text['id'],'PLACEMENT',place['id']);t.link(place['id'],'SENTENCE',sentence['id'])
        for k,token in enumerate(eligible_tokens(s['body'],s['tokens'])):
            choice=token['selected'];key=(token['surface'],packed(choice),packed(token.get('meanings',[])))
            word=imported_words.get(key)
            if word is None:
                base=family(t,token,choice);word=word_form(t,base,token)
                add_meanings(t,base,token.get('meanings',[]))
                if word['id']!=base['id']:add_meanings(t,word,token.get('meanings',[]))
                imported_words[key]=word
            occurrence=t.create('WordOccurrence',f'occurrence:{place["id"]}:{k}',ordinal=k,start=token['start'],end=token['end'],reading=token['reading'])
            t.link(place['id'],'TOKEN',occurrence['id']);t.link(occurrence['id'],'WORD',word['id'])
        if report:report('saving',i+1,len(result['sentences']))
    if report:report('validating',len(result['sentences']),len(result['sentences']))
    return {'textId':text['id'],'duplicate':False}

def text_detail(t,id):
    text=t.get(id)
    if text['type']!='Text':raise Missing('Text not found')
    rows=t.run('''MATCH (t:Text {id:$id})-[:PLACEMENT]->(p)-[:SENTENCE]->(s)
    OPTIONAL MATCH (p)-[:TOKEN]->(o)-[:WORD]->(w)-[:BASE_FORM]->(b)
    OPTIONAL MATCH (b)-[:STATUS]->(st)
    RETURN properties(p) AS p, properties(s) AS s, properties(o) AS o,properties(w) AS w,properties(b) AS b,collect(properties(st)) AS states
    ORDER BY p.ordinal,o.ordinal''',id=id)
    groups={}
    for r in rows:
        p=r['p']; group=groups.setdefault(p['id'],p|{'sentenceId':r['s']['id'],'body':r['s']['body'],'tokens':[]})
        if r['o']:
            group['tokens'].append(r['o']|{'wordId':r['w']['id'],'surface':r['w']['surface'],'baseId':r['b']['id'],'base':r['b']['surface'],'meaning':'','states':{s['area']:s['state'] for s in r['states']},'statusRevisions':{s['area']:s['revision'] for s in r['states']}})
    sources=t.run('MATCH (t:Text {id:$id})-[:PROVENANCE]->(p)-[:SOURCE]->(s) RETURN properties(s) AS source',id=id)
    phrases=t.run('MATCH (t:Text {id:$id})-[:PHRASE]->(p) OPTIONAL MATCH (p)-[:STATUS]->(s) RETURN properties(p) AS phrase, collect(properties(s)) AS states',id=id)
    return text|{'sentences':list(groups.values()),'sources':[x['source'] for x in sources],'phrases':phrases}

def library(t):
    rows=t.run('''MATCH (t:Text) OPTIONAL MATCH (f:Folder)-[:CONTAINS]->(t)
    RETURN properties(t) AS text,collect(properties(f)) AS folders ORDER BY text.updatedAt DESC''')
    return [r['text']|{'folders':r['folders'],'bodyLength':len(r['text']['body']),'excerpt':r['text']['body'][:100]} for r in rows]

def word_meanings(t,id):
    meanings=t.run('''MATCH (w:Word {id:$id})-[:BASE_FORM]->(b) WITH [w,b] AS owners
    UNWIND owners AS owner MATCH (owner)-[:HAS_MEANING]->(m:Meaning)
    RETURN DISTINCT properties(m) AS m ORDER BY '''+MEANING_ORDER,id=id)
    return [x['m'] for x in meanings]

def word_detail(t,id):
    w=t.get(id)
    if w['type']!='Word':raise Missing('Word not found')
    base=t.get(w['family'])
    forms=t.run('MATCH (w:Word)-[:BASE_FORM]->(b:Word {id:$id}) RETURN properties(w) AS w ORDER BY w.surface',id=base['id'])
    examples=t.run('''MATCH (t:Text)-[:PLACEMENT]->(p)-[:TOKEN]->(o)-[:WORD]->(w:Word)-[:BASE_FORM]->(b:Word {id:$id})
    MATCH (p)-[:SENTENCE]->(s) RETURN DISTINCT t.id AS textId,t.title AS title,t.textState AS textState,s.id AS sentenceId,p.id AS occurrenceId,s.body AS body,p.start AS start,p.end<=t.cursor AS seen ORDER BY title,start LIMIT 50''',id=base['id'])
    meanings=word_meanings(t,id)
    return w|{'meaning':'; '.join(m['body'] for m in meanings),'meanings':meanings,'base':base,'statuses':status_nodes(t,base['id']),'forms':[x['w'] for x in forms],'examples':examples}

def set_status(t,id,area,state,revision=None,only_if_new=False):
    if area not in AREAS or state not in STATES:raise ValueError('Invalid learning status')
    w=t.get(id);owner=w['family'] if w['type']=='Word' else id
    statuses=status_nodes(t,owner)
    if area not in statuses:raise ValueError('This entity has no word learning status')
    s=statuses[area]
    if only_if_new and s['state']!='new':return {'baseId':owner,'area':area,'state':s['state'],'revision':s['revision']}
    updated=t.update(s['id'],expected=revision,state=state)
    return {'baseId':owner,'area':area,'state':state,'revision':updated['revision']}

def learn_word(t,id):
    word=t.get(id)
    if word['type']!='Word':raise Missing('Word not found')
    statuses=status_nodes(t,word['family'])
    if set(statuses)!=set(AREAS):raise InvalidGraph('Word family must have both learning statuses')
    result={}
    for area in ('listening','reading'):
        status=statuses[area]
        if status['state']=='new':status=t.update(status['id'],state='learning')
        result[area]={'state':status['state'],'revision':status['revision']}
    return {'baseId':word['family'],'statuses':result}

def text_state(t,id,state,revision=None):
    if state not in ('new','completed'):raise ValueError('Invalid text status')
    text=t.get(id)
    if text['type']!='Text':raise Missing('Text not found')
    updated=t.update(id,expected=revision,textState=state,cursor=len(text['body']) if state=='completed' else text['cursor'])
    return updated

def progress(t,id,cursor):
    text=t.get(id)
    if text['type']!='Text':raise Missing('Text not found')
    cursor=max(text['cursor'],min(len(text['body']),max(0,cursor)))
    if cursor>text['cursor']:
        reached=t.run('''MATCH (t:Text {id:$id})-[:PLACEMENT]->(p)-[:TOKEN]->(o)
        WHERE p.start+o.end>$old AND p.start+o.end<=$cursor
            AND NOT EXISTS { MATCH (:Encounter {area:'reading'})-[:OCCURRED_IN]->(o) }
            RETURN o.id AS id''',id=id,old=text['cursor'],cursor=cursor)
        for r in reached:
            e=t.create('Encounter','encounter:reading:'+r['id'],area='reading',evidence='reader-progress');t.link(e['id'],'OCCURRED_IN',r['id'])
        day=datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat()
        t.create('Activity','activity:'+uid(),day=day,kind='reading',amount=len(reached),details=packed({'textId':id}))
        return t.update(id,cursor=cursor)
    return text

def explore(t,query='',area='reading',minimum=0,seen='all',word_id=None,offset=0,limit=100):
    if area not in AREAS or seen not in ('all','seen','unseen') or not 0<=minimum<=1:raise ValueError('Invalid exploration filter')
    start="MATCH (t:Text)-[:PLACEMENT]->(p)-[:SENTENCE]->(s)" if word_id is None else "MATCH (selected:Word {id:$word})<-[:BASE_FORM*0..1]-(w:Word)<-[:WORD]-()<-[:TOKEN]-(p)<-[:PLACEMENT]-(t:Text) MATCH (p)-[:SENTENCE]->(s)"
    rows=t.run(start+''' WHERE t.archived=false AND ($seen='all' OR (p.end<=t.cursor)=($seen='seen'))
      AND ($q='' OR toLower(s.body+' '+t.title) CONTAINS $q OR EXISTS {
        MATCH (p)-[:TOKEN]->()-[:WORD]->(w)-[:BASE_FORM]->(b)
        WHERE toLower(b.surface) CONTAINS $q OR EXISTS { MATCH (w)-[:HAS_MEANING]->(m) WHERE toLower(m.body) CONTAINS $q }
        OR EXISTS { MATCH (b)-[:HAS_MEANING]->(m) WHERE toLower(m.body) CONTAINS $q }
      })
      WITH DISTINCT t,p,s,size([(p)-[:TOKEN]->(o) | o]) AS tokenCount
      WHERE tokenCount>0 AND ($minimum=0 OR size([(p)-[:TOKEN]->()-[:WORD]->()-[:BASE_FORM]->()-[:STATUS]->(st {area:$area}) WHERE st.state='known' | st])*1.0/CASE tokenCount WHEN 0 THEN 1 ELSE tokenCount END >= $minimum)
      WITH t,p,s ORDER BY t.updatedAt DESC,p.ordinal SKIP $offset LIMIT $limit
      MATCH (p)-[:TOKEN]->(o)-[:WORD]->(w)-[:BASE_FORM]->(b)-[:STATUS]->(st {area:$area})
      WITH t,p,s,o,w,b,st,reduce(unique=[],m IN [(b)-[:HAS_MEANING]->(m) | m.body]+[(w)-[:HAS_MEANING]->(m) | m.body] | CASE WHEN m IN unique THEN unique ELSE unique+[m] END) AS meanings ORDER BY o.ordinal
      WITH t,p,s,collect({surface:w.surface,reading:o.reading,occurrenceId:o.id,base:b.surface,baseReading:b.reading,meaning:coalesce(head(meanings),''),baseId:b.id,state:st.state,wordId:w.id,start:o.start,end:o.end}) AS words,
           sum(CASE st.state WHEN 'known' THEN 1.0 ELSE 0.0 END)/count(*) AS coverage
      RETURN t.id AS textId,t.title AS title,t.textState AS textState,p.id AS occurrenceId,s.id AS sentenceId,s.body AS body,p.start AS start,p.end<=t.cursor AS seen,words,coverage
      ORDER BY t.updatedAt DESC,p.ordinal''',area=area,seen=seen,word=word_id,q=query.casefold(),minimum=minimum,offset=max(0,offset),limit=max(1,min(500,limit)))
    return [r|{'counts':dict(Counter(w['state'] for w in r['words']))} for r in rows]

def correct_meaning(t,occurrence_id,payload):
    occurrence=t.get(occurrence_id)
    if occurrence['type']!='WordOccurrence':raise ValueError('Select a word occurrence')
    rows=t.run('MATCH (o:WordOccurrence {id:$id})-[:WORD]->(w) RETURN properties(w) AS w',id=occurrence_id)
    word=rows[0]['w']
    if payload.get('baseForm'):word=t.get(word['family'])
    if not payload.get('meaning','').strip():raise ValueError('Enter a meaning')
    add_meanings(t,word,[{'meaning':payload['meaning'],'baseReading':payload.get('reading',word['reading']),'sourceType':'user'}])
    t.update(word['id'])
    return {'wordId':word['id'],'baseId':word['family']}

def create_phrase(t,text_id,occurrence_ids,meaning):
    text=text_detail(t,text_id);selected=[]
    for sentence in text['sentences']:
        indices=[i for i,w in enumerate(sentence['tokens']) if w['id'] in occurrence_ids]
        if indices:
            if len(indices)!=len(occurrence_ids) or indices!=list(range(min(indices),max(indices)+1)):raise ValueError('Choose contiguous words in one sentence')
            selected=sentence['tokens'][min(indices):max(indices)+1];surface=sentence['body'][selected[0]['start']:selected[-1]['end']];break
    if len(selected)<2:raise ValueError('Select at least two words')
    members=[w['wordId'] for w in selected]
    existing=t.run('MATCH (p:Phrase {meaning:$meaning})-[:PHRASE_MEMBER]->(m)-[:MEMBER_WORD]->(w) WITH p,m,w ORDER BY m.ordinal WITH p,collect(w.id) AS members WHERE members=$members RETURN p.id AS id',meaning=meaning,members=members)
    if existing:p=t.get(existing[0]['id'])
    else:
        p=t.create('Phrase','phrase:'+digest(packed(members)+meaning),surface=surface,meaning=meaning)
        create_statuses(t,p['id'],{'reading':'learning','listening':'new'})
        for ordinal,word in enumerate(members):
            member=t.create('PhraseMember',f'phrase-member:{p["id"]}:{ordinal}',ordinal=ordinal);t.link(p['id'],'PHRASE_MEMBER',member['id']);t.link(member['id'],'MEMBER_WORD',word)
    t.link(text_id,'PHRASE',p['id']);return p
