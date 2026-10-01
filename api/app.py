from __future__ import annotations
import asyncio,base64,json,os,re,secrets,time
from contextlib import asynccontextmanager,suppress
from datetime import datetime,timedelta,timezone
from pathlib import Path
from typing import Literal,Any
from fastapi import FastAPI,HTTPException,Header,Request,Query as QueryParam
from fastapi.responses import FileResponse,JSONResponse,RedirectResponse,Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel,ConfigDict,Field
from neo4j.exceptions import ServiceUnavailable
from api.graph import Graph,Tx,Conflict,Missing,packed,digest,uid,now
from api.schema import SCHEMA,InvalidGraph,validate_graph
from api import domain,jobs as job_info,word_meanings
from api.media_config import ENGINE
from api.ephemeral import PhraseJobs,Capacity

class Strict(BaseModel):model_config=ConfigDict(extra='forbid')
class VocabularyCleanup(Strict):
    dryRun:bool=True
    expectedFingerprint:str|None=Field(default=None,min_length=64,max_length=64,pattern='^[0-9a-f]+$')
class RetokenizeApply(Strict):
    jobId:str
    expectedFingerprint:str=Field(min_length=64,max_length=64,pattern='^[0-9a-f]+$')
class RetokenizePlan(Strict):
    familyRepairs:list[str]=Field(default_factory=list,max_length=100)
class Import(Strict):
    title:str=Field(min_length=1,max_length=200)
    body:str=Field(min_length=1,max_length=50000)
    # Older clients send this field. Ingestion no longer assigns folders.
    folder:str=Field(default='',deprecated=True,description='Ignored. Assign folder membership separately through a graph transaction.')
    sourceUrl:str=''
    previousId:str|None=None
class ImportResult(Strict):
    textId:str|None=None
    jobId:str|None=None
    duplicate:bool
class ProgressView(Strict):
    stage:str
    completed:int
    total:int
    startedAt:str
    updatedAt:str
    percent:int
    elapsedSeconds:float
    estimatedRemainingSeconds:int|None
    secondsSinceProgress:float
    stalled:bool
    leaseExpiresAt:str
class JobView(Strict):
    id:str
    kind:str
    title:str
    state:Literal['pending','running','ready','failed']
    error:str
    attempts:int
    result:dict[str,Any]
    progress:ProgressView
class Status(Strict):
    area:Literal['reading','listening']|None=Field(default=None,deprecated=True,description='Ignored. Learning status is unified.')
    state:Literal['new','learning','familiar','known']
    revision:int|None=None
    onlyIfNew:bool=False
class LearningState(Strict):
    state:Literal['new','learning','familiar','known']
    revision:int
class LearningAreas(Strict):
    listening:LearningState
    reading:LearningState
class LearnResult(Strict):
    baseId:str
    status:LearningState
    statuses:LearningAreas=Field(deprecated=True,description="Compatibility aliases of the single status.")
class TextStatus(Strict):
    state:Literal['new','completed']
    revision:int|None=None
    completionFingerprint:str|None=Field(default=None,min_length=64,max_length=64,pattern='^[0-9a-f]+$')
class Cursor(Strict):cursor:int=Field(ge=0)
class Metadata(Strict):
    title:str|None=Field(default=None,min_length=1,max_length=200)
    archived:bool|None=None
    revision:int|None=None
class Query(Strict):
    query:str=Field(max_length=20000)
    params:dict[str,Any]={}
class Transaction(Strict):
    statements:list[Query]
    dryRun:bool=False
    expectedRevisions:dict[str,int]={}
class SpeechRequest(Strict):
    text:str|None=Field(default=None,max_length=1500)
    occurrenceId:str|None=None
    voice:str='jf_alpha'
    speed:float=Field(default=0.9,ge=0.5,le=1.5)
class Translate(Strict):
    text:str=Field(min_length=1,max_length=2000)
    context:str=Field(default='',max_length=5000)
class PhraseSpeechRequest(Strict):
    text:str=Field(min_length=1,max_length=1500)
class SubmittedJob(Strict):
    jobId:str
class WordMeaningsResult(Strict):
    wordId:str
    state:Literal['pending','running','ready','failed']
    meanings:list[dict[str,Any]]
    cached:bool
    jobId:str|None=None
    error:str=''
class Correction(Strict):
    reading:str|None=None
    meaning:str|None=None
    baseForm:bool=False
class PhraseRequest(Strict):
    occurrenceIds:list[str]=Field(min_length=2,max_length=100)
    meaning:str=Field(min_length=1,max_length=2000)
class JobProgress(Strict):
    attempt:int
    stage:Literal['dictionary','saving']
    completed:int=Field(ge=0)
    total:int=Field(ge=0)
class JobResult(Strict):
    attempt:int
    result:dict[str,Any]={}
    error:str=''
class Merge(Strict):
    sourceBaseId:str
    targetBaseId:str
class BatchStatuses(Strict):
    ids:list[str]=Field(max_length=1000)
    area:Literal['reading','listening']|None=Field(default=None,deprecated=True,description='Ignored. Learning status is unified.')
    state:Literal['new','learning','familiar','known']
class SettingsPatch(Strict):
    theme:Literal['light','dark','system']|None=None
    fontSize:int|None=Field(default=None,ge=16,le=32)
    lineHeight:float|None=Field(default=None,ge=1.4,le=2.4)
    readerLayout:Literal['book']|None=None
    furigana:bool|None=None
    area:Literal['reading','listening']|None=None

class PracticeAnswer(Strict):
    textId:str=Field(min_length=1)
    kind:Literal['matching','sentence']
    targetId:str
    answer:str
    eventId:str

@asynccontextmanager
async def lifespan(app):
    app.state.graph=Graph();app.state.graph.initialize();app.state.worker_seen=0
    app.state.phrase_jobs=PhraseJobs()
    app.state.media=Path(os.getenv('KOTOBA_MEDIA_DIR',str(Path(__file__).resolve().parents[1]/'data/media')))
    app.state.media.mkdir(parents=True,exist_ok=True)
    async def expire_phrase_requests():
        while True:
            await asyncio.sleep(30)
            app.state.phrase_jobs.cleanup()
    cleanup=asyncio.create_task(expire_phrase_requests())
    try:yield
    finally:
        cleanup.cancel()
        with suppress(asyncio.CancelledError):await cleanup
        app.state.graph.close()
app=FastAPI(title='Kotoba Studio v2',version='1.0.0',lifespan=lifespan,openapi_url='/api/v1/openapi.json',docs_url='/api/v1/docs',redoc_url=None)
def graph():return app.state.graph

@app.exception_handler(ValueError)
async def errors(request,exc):
    code=429 if isinstance(exc,Capacity) else 409 if isinstance(exc,Conflict) else 404 if isinstance(exc,Missing) else 422
    return JSONResponse(status_code=code,content={'error':type(exc).__name__,'message':str(exc)},headers={'Retry-After':'30'} if code==429 else None)
@app.exception_handler(ServiceUnavailable)
async def database_unavailable(request,exc):return JSONResponse(status_code=503,content={'error':'Unavailable','message':'The database is unavailable. Your unsaved input is still here. Retry when it reconnects.'})

def require_worker(auth):
    token=os.getenv('KOTOBA_WORKER_TOKEN','')
    if not token or not secrets.compare_digest(auth or '','Bearer '+token):raise HTTPException(401,'Worker authentication required')
    app.state.worker_seen=time.time()

@app.get('/api/v1/health')
def health():
    graph().read(lambda t:t.run('RETURN 1 AS ready'))
    return {'ready':True,'workerReady':time.time()-app.state.worker_seen<90,'schema':SCHEMA['digest']}
@app.get('/api/v1/schema')
def schema():return SCHEMA
@app.post('/api/v1/maintenance/retokenize/plan',status_code=202,response_model=SubmittedJob)
def retokenize_plan(p:RetokenizePlan|None=None):
    from api.retokenize import sentences
    from api.vocabulary_cleanup import fingerprint
    def prepare(t):
        snapshot=t.snapshot();key=fingerprint(snapshot);repairs=sorted(set(p.familyRepairs if p else []))
        payload={'fingerprint':key,'sentences':sentences(snapshot),'familyRepairs':repairs}
        job=domain.create_job(t,'retokenize',payload,'retokenize:ichiran:'+key+':'+digest(packed(repairs)))
        return {'jobId':job['id']}
    return graph().write('retokenize.plan',prepare,actor='agent')
@app.post('/api/v1/maintenance/retokenize/apply')
def retokenize_apply(p:RetokenizeApply):
    from api.retokenize import apply
    def mutate(t):
        j=t.get(p.jobId)
        if j['type']!='Job' or j['kind']!='retokenize' or j['jobState']!='ready':raise Conflict('A completed retokenization plan is required')
        result=json.loads(j['result'])
        if result['plan']['fingerprint']!=p.expectedFingerprint:raise Conflict('Fingerprint does not match the reviewed plan')
        return apply(t,result['sentences'],p.expectedFingerprint,json.loads(j['payload']).get('familyRepairs',[]))
    return graph().write('retokenize.apply',mutate,actor='agent')

@app.get('/api/v1/texts')
def texts():return graph().read(domain.library)
@app.post('/api/v1/imports',status_code=202,response_model=ImportResult,response_model_exclude_none=True)
def import_text(p:Import,idempotency_key:str|None=Header(default=None)):
    return graph().write('text.import',lambda t:domain.prepare_import(t,p.model_dump(exclude_none=True)),idempotency_key)
@app.get('/api/v1/texts/{id}')
def text(id:str):return graph().read(lambda t:domain.text_detail(t,id))
@app.patch('/api/v1/texts/{id}')
def metadata(id:str,p:Metadata):return graph().write('text.metadata',lambda t:t.update(id,expected=p.revision,**p.model_dump(exclude_none=True,exclude={'revision'})),scalar_only=True)
@app.get('/api/v1/texts/{id}/completion')
def completion_preview(id:str):
    from api.completion import preview
    return graph().read(lambda t:preview(t,id)[0])
@app.put('/api/v1/texts/{id}/status')
def text_status(id:str,p:TextStatus):
    def change(t):
        if p.state=='completed':
            from api.completion import finish
            return finish(t,id,p.revision,p.completionFingerprint)
        return domain.text_state(t,id,p.state,p.revision)
    return graph().write('text.status',change)
@app.put('/api/v1/texts/{id}/progress')
def progress(id:str,p:Cursor):return graph().write('text.progress',lambda t:domain.progress(t,id,p.cursor))
@app.get('/api/v1/words/{id}')
def word(id:str):return graph().read(lambda t:domain.word_detail(t,id))
@app.post('/api/v1/words/{id}/meanings',response_model=WordMeaningsResult,response_model_exclude_none=True)
def request_word_meanings(id:str,response:Response):
    result=graph().read(lambda t:word_meanings.request(t,id))
    if result is None:result=graph().write('word.meanings.request',lambda t:word_meanings.request(t,id,create=True))
    response.status_code=200 if result['state']=='ready' else 202
    return result
@app.put('/api/v1/words/{id}/status')
def word_status(id:str,p:Status):return graph().write('word.status',lambda t:domain.set_status(t,id,p.area,p.state,p.revision,p.onlyIfNew),scalar_only=True)
@app.post('/api/v1/words/{id}/learn',response_model=LearnResult)
def learn_word(id:str):return graph().write('word.learn',lambda t:domain.learn_word(t,id),scalar_only=True)
@app.post('/api/v1/statuses/batch')
def batch_status(p:BatchStatuses):return graph().write('status.batch',lambda t:[domain.set_status(t,id,p.area,p.state) for id in p.ids],scalar_only=True)
@app.post('/api/v1/occurrences/{id}/meaning')
def correction(id:str,p:Correction):
    if not p.meaning:raise ValueError('Enter a meaning')
    return graph().write('meaning.correct',lambda t:domain.correct_meaning(t,id,p.model_dump(exclude_none=True)))
@app.post('/api/v1/families/merge')
def merge_families(p:Merge):
    def apply(t):
        a=t.get(p.sourceBaseId);b=t.get(p.targetBaseId)
        if a['family']!=a['id'] or b['family']!=b['id'] or a['id']==b['id']:raise ValueError('Choose two different canonical bases')
        rows=t.run('MATCH (w:Word)-[:BASE_FORM]->(b:Word {id:$id}) RETURN properties(w) AS w',id=a['id'])
        t.run('MATCH (b:Word {id:$id})-[:STATUS]->(s) DETACH DELETE s',id=a['id'])
        for r in rows:
            word=r['w'];t.unlink(word['id'],'BASE_FORM');t.link(word['id'],'BASE_FORM',b['id']);t.update(word['id'],family=b['id'])
        return {'baseId':b['id'],'states':domain.status_nodes(t,b['id']),'merged':len(rows)}
    return graph().write('family.merge',apply)
@app.get('/api/v1/explore')
def explore(q:str='',area:Literal['reading','listening']|None=None,minimum:float=0,seen:str='all',wordId:str|None=None,offset:int=0,limit:int=100):return graph().read(lambda t:domain.explore(t,q,area,minimum,seen,wordId,offset,limit))
@app.post('/api/v1/texts/{id}/phrases')
def phrase(id:str,p:PhraseRequest):return graph().write('phrase.create',lambda t:domain.create_phrase(t,id,p.occurrenceIds,p.meaning))
@app.put('/api/v1/phrases/{id}/status')
def phrase_status(id:str,p:Status):return graph().write('phrase.status',lambda t:domain.set_status(t,id,p.area,p.state,p.revision,p.onlyIfNew),scalar_only=True)
# In-process saving counters supplement durable worker progress while a single
# atomic import transaction is committing. They never contain corpus content.
LIVE_PROGRESS={}
@app.get('/api/v1/jobs')
def jobs()->list[JobView]:
    rows=graph().read(lambda t:t.run('MATCH (j:Job) RETURN properties(j) AS job ORDER BY j.createdAt DESC LIMIT 100'))
    return [job_info.view(r['job'],LIVE_PROGRESS.get(r['job']['id'])) for r in rows]
@app.get('/api/v1/jobs/{id}')
def job(id:str)->JobView:
    if PhraseJobs.owns(id):return JSONResponse(app.state.phrase_jobs.view(id),headers={'Cache-Control':'no-store'})
    j=graph().read(lambda t:t.get(id))
    if j['type']!='Job':raise Missing('Job not found')
    return job_info.view(j,LIVE_PROGRESS.get(id))
@app.post('/api/v1/jobs/{id}/retry')
def retry(id:str):
    if PhraseJobs.owns(id):raise Conflict('Phrase requests are temporary. Request the phrase tool again.')
    def apply(t):
        j=t.get(id)
        if j['type']!='Job' or not(j['jobState'] in ('failed','pending') or j['jobState']=='running' and j['lease']<now()):raise Conflict('Only failed, pending, or expired jobs can be retried')
        return t.update(id,jobState='pending',error='')
    return graph().write('job.retry',apply,scalar_only=True)
@app.post('/api/v1/phrase-tools/translation',status_code=202,response_model=SubmittedJob)
def phrase_translation(p:Translate,response:Response):
    if not p.text.strip():raise ValueError('Select some Japanese text')
    response.headers['Cache-Control']='no-store'
    return app.state.phrase_jobs.submit('translation',p.model_dump())
@app.post('/api/v1/phrase-tools/speech',status_code=202,response_model=SubmittedJob)
def phrase_speech(p:PhraseSpeechRequest,response:Response):
    if not p.text.strip():raise ValueError('Select some Japanese text')
    response.headers['Cache-Control']='no-store'
    return app.state.phrase_jobs.submit('speech',{'text':p.text,'voice':'jf_alpha','speed':0.9})
@app.get('/api/v1/phrase-tools/speech/play',response_class=RedirectResponse)
async def play_phrase_speech(request:Request,text:str=QueryParam(min_length=1,max_length=1500),request_id:str=QueryParam(alias='request',min_length=1,max_length=128)):
    # A fresh URL per explicit gesture allows native iOS playback activation.
    # The nonce is a browser cache buster, never a server result lookup key.
    if not text.strip():raise ValueError('Select some Japanese text')
    queue=app.state.phrase_jobs
    id=queue.submit('speech',{'text':text,'voice':'jf_alpha','speed':0.9})['jobId']
    deadline=time.monotonic()+180
    while True:
        if await request.is_disconnected():
            queue.cancel(id)
            return JSONResponse({'message':'Playback cancelled'},status_code=499,headers={'Cache-Control':'no-store'})
        current=queue.view(id)
        if current['state']=='failed':raise HTTPException(503,current['error'],headers={'Cache-Control':'no-store'})
        if current['state']=='ready':return RedirectResponse(current['result']['url'],status_code=307,headers={'Cache-Control':'no-store'})
        if time.monotonic()>=deadline:
            queue.cancel(id)
            raise HTTPException(504,'Phrase pronunciation timed out. Request it again.',headers={'Cache-Control':'no-store'})
        await asyncio.sleep(.25)
@app.head('/api/v1/phrase-tools/audio/{id}',include_in_schema=False)
@app.get('/api/v1/phrase-tools/audio/{id}',response_class=Response)
def phrase_audio(id:str,request:Request):
    audio=app.state.phrase_jobs.audio(id);size=len(audio)
    headers={'Cache-Control':'no-store','Accept-Ranges':'bytes','Content-Length':str(size)}
    if request.method=='HEAD':return Response(headers=headers,media_type='audio/wav')
    range_header=request.headers.get('range','')
    # A server may ignore unsupported units and multipart ranges. If-Range
    # cannot match because these temporary responses have no validators.
    if range_header.startswith('bytes=') and ',' not in range_header and not request.headers.get('if-range'):
        match=re.fullmatch(r'bytes=(\d*)-(\d*)',range_header)
        start=end=None
        if match and any(match.groups()):
            first,last=match.groups()
            if first:start=int(first);end=min(int(last),size-1) if last else size-1
            elif int(last)>0:start=max(0,size-int(last));end=size-1
        if start is None or start>=size or end<start:
            return Response(status_code=416,headers={'Cache-Control':'no-store','Accept-Ranges':'bytes','Content-Range':f'bytes */{size}'})
        headers['Content-Range']=f'bytes {start}-{end}/{size}';headers['Content-Length']=str(end-start+1)
        return Response(audio[start:end+1],status_code=206,headers=headers,media_type='audio/wav')
    return Response(audio,headers=headers,media_type='audio/wav')
@app.post('/api/v1/speech',status_code=202)
def speech(p:SpeechRequest):
    if not p.voice.startswith(('jf_','jm_')):raise ValueError('Choose a Japanese voice')
    def pronunciation_for(t):
        if not p.occurrenceId:return p.text
        occurrence=t.get(p.occurrenceId)
        if occurrence['type']!='WordOccurrence':raise ValueError('Choose a word occurrence')
        if occurrence['reading']:return occurrence['reading']
        rows=t.run('MATCH (o:WordOccurrence {id:$id})-[:WORD]->(w) RETURN w.surface AS surface',id=p.occurrenceId)
        return rows[0]['surface'] if rows else None
    # Cached playback is read-only: no writer lock, audit, or full graph scan.
    def cached(t):
        pronunciation=pronunciation_for(t)
        if not pronunciation:raise ValueError('Pronunciation is empty')
        key='speech:'+digest(packed([pronunciation,p.voice,p.speed,ENGINE]))
        asset=t.find(key)
        if asset and asset['jobState']=='ready' and (app.state.media/asset['asset']).is_file():
            return {'speechId':asset['id'],'url':'/api/v1/media/'+asset['asset'],'cached':True}
    ready=graph().read(cached)
    if ready:return ready
    def create(t):
        pronunciation=pronunciation_for(t);owner=p.occurrenceId
        if not pronunciation:raise ValueError('Pronunciation is empty')
        engine=ENGINE;key=digest(packed([pronunciation,p.voice,p.speed,engine]))
        s=t.create('Speech','speech:'+key,pronunciation=pronunciation,voice=p.voice,speed=p.speed,engine=engine,asset='',jobState='pending')
        if owner:t.link(owner,'PRONUNCIATION',s['id'])
        if s['jobState']=='ready' and (app.state.media/s['asset']).is_file():return {'speechId':s['id'],'url':'/api/v1/media/'+s['asset'],'cached':True}
        j=domain.create_job(t,'speech',{'speechId':s['id'],'text':pronunciation,'voice':p.voice,'speed':p.speed},'speech-job:'+key)
        if j['jobState'] in ('failed','ready'):j=t.update(j['id'],jobState='pending',error='')
        return {'speechId':s['id'],'jobId':j['id'],'cached':False}
    return graph().write('speech.request',create)
@app.get('/api/v1/speech/play',response_class=RedirectResponse)
async def play_speech(request:Request,text:str|None=QueryParam(default=None,max_length=1500),occurrenceId:str|None=None,voice:str='jf_alpha',speed:float=QueryParam(default=0.9,ge=0.5,le=1.5)):
    # A media URL lets the browser start play() in the original user gesture,
    # while a cold pronunciation is synthesized and cached on demand.
    result=await run_in_threadpool(speech,SpeechRequest(text=text,occurrenceId=occurrenceId,voice=voice,speed=speed))
    deadline=time.monotonic()+120
    while 'url' not in result:
        if await request.is_disconnected():return JSONResponse({'message':'Playback cancelled'},status_code=499)
        current=await run_in_threadpool(job,result['jobId'])
        if current['state']=='failed':raise HTTPException(503,'Pronunciation generation failed')
        if current['state']=='ready':
            result=current['result'];break
        if time.monotonic()>=deadline:raise HTTPException(504,'Pronunciation is still processing')
        await asyncio.sleep(.25)
    return RedirectResponse(result['url'],status_code=307,headers={'Cache-Control':'no-store'})
@app.get('/api/v1/media/{name}')
def media(name:str):
    if not name.endswith('.wav') or '/' in name or '..' in name:raise Missing('Audio not found')
    path=app.state.media/name
    if not path.is_file():raise Missing('Audio not found')
    return FileResponse(path,media_type='audio/wav',headers={'Cache-Control':'private, max-age=31536000, immutable'})
@app.post('/api/v1/translations',status_code=202)
def translation(p:Translate):
    key='translation:'+digest(packed(p.model_dump()))
    known=graph().read(lambda t:t.find(key))
    if known:return {'translation':known['meaning']}
    def create(t):
        known=t.find(key)
        if known:return {'translation':known['meaning']}
        j=domain.create_job(t,'translation',p.model_dump()|{'key':key},'job:'+key)
        if j['jobState']=='ready':return json.loads(j['result'])
        if j['jobState']=='failed':j=t.update(j['id'],jobState='pending',error='')
        return {'jobId':j['id']}
    return graph().write('translation.request',create)
@app.get('/api/v1/settings')
def settings():
    s=graph().read(lambda t:t.find('settings:user'));return json.loads(s['payload']) if s else {'theme':'system','fontSize':20,'lineHeight':1.85,'readerLayout':'book','furigana':True}
@app.put('/api/v1/settings')
def save_settings(p:dict[str,Any]):
    def save(t):
        s=t.find('settings:user')
        return t.update(s['id'],payload=packed(p)) if s else t.create('Settings','settings:user',payload=packed(p))
    return graph().write('settings.save',save,scalar_only=True)
@app.patch('/api/v1/settings')
def patch_settings(p:SettingsPatch):
    def apply(t):
        old=t.find('settings:user');data=json.loads(old['payload']) if old else {}
        payload=packed(data|p.model_dump(exclude_none=True))
        return t.update(old['id'],payload=payload) if old else t.create('Settings','settings:user',payload=payload)
    return graph().write('settings.patch',apply,scalar_only=True)
@app.get('/api/v1/statistics')
def statistics():
    return graph().read(lambda t:t.run('RETURN COUNT { MATCH (w:Word) WHERE w.id=w.family } AS meanings, COUNT { MATCH (s:Sentence) } AS sentences')[0])
@app.get('/api/v1/activity')
def activity():
    return graph().read(lambda t:t.run('MATCH (a:Activity) RETURN a.day AS day,a.kind AS kind,sum(a.amount) AS amount ORDER BY day DESC'))
@app.get('/api/v1/practice')
def practice(textId:str=QueryParam(min_length=1),area:Literal['reading','listening']|None=None,states:str='learning,familiar'):
    allowed=set(states.split(','))
    if not allowed or not allowed<=set(domain.STATES):raise ValueError('Invalid practice statuses')
    def lesson(t):
        if t.get(textId)['type']!='Text':raise Missing('Text not found')
        rows=t.run('''MATCH (t:Text {id:$text})-[:PLACEMENT]->(p)-[:SENTENCE]->(s)
          USING INDEX t:Text(id)
          MATCH (p)-[:TOKEN]->(o)-[:WORD]->(w)-[:BASE_FORM]->(b)-[:STATUS]->(st:LearningStatus)
          CALL (b,w) {
            UNWIND CASE WHEN b=w THEN [b] ELSE [b,w] END AS owner
            MATCH (owner)-[:HAS_MEANING]->(m:Meaning)
            WITH b,owner,m ORDER BY CASE WHEN owner=b THEN 0 ELSE 1 END,'''+domain.MEANING_ORDER+'''
            RETURN head(collect(m.body)) AS meaning
          }
          WITH t,p,s,o,w,b,st,meaning
          ORDER BY p.ordinal,o.ordinal
          WITH t,p,s,collect({surface:w.surface,reading:o.reading,occurrenceId:o.id,base:b.surface,baseReading:b.reading,meaning:coalesce(meaning,''),baseId:b.id,state:st.state,wordId:w.id,start:o.start,end:o.end}) AS words,
               sum(CASE st.state WHEN 'known' THEN 1.0 ELSE 0.0 END)/count(*) AS coverage
          WHERE any(w IN words WHERE w.state IN $states)
          RETURN t.id AS textId,t.title AS title,t.textState AS textState,p.id AS occurrenceId,s.id AS sentenceId,s.body AS body,p.start AS start,p.end<=t.cursor AS seen,words,coverage
          ORDER BY p.ordinal''',text=textId,area=area,states=sorted(allowed))
        return [r|{'counts':{state:sum(w['state']==state for w in r['words']) for state in domain.STATES}} for r in rows]
    examples=graph().read(lesson);pool={}
    for e in examples:
        for w in e['words']:
            if w['state'] in allowed and w['meaning']:pool[w['baseId']]=w
    return {'words':list(pool.values()),'sentences':examples}
@app.post('/api/v1/practice/answer')
def practice_answer(p:PracticeAnswer):
    def check(t):
        if t.get(p.textId)['type']!='Text':raise Missing('Text not found')
        item=t.get(p.targetId)
        if p.kind=='matching':
            if item['type']!='Word':raise ValueError('Choose a Word')
            rows=t.run('''MATCH (t:Text {id:$text})-[:PLACEMENT]->()-[:TOKEN]->()-[:WORD]->(w)-[:BASE_FORM]->(b:Word {id:$id})
              WITH collect(DISTINCT w)+collect(DISTINCT b) AS owners
              UNWIND owners AS owner OPTIONAL MATCH (owner)-[:HAS_MEANING]->(m)
              RETURN DISTINCT m.body AS body''',text=p.textId,id=item['id'])
            if not rows:raise Missing('Word is not in this lesson')
            return any(m['body'] and p.answer.strip()==m['body'].strip() for m in rows)
        if item['type']!='Sentence':raise ValueError('Choose a Sentence')
        if not t.run('MATCH (:Text {id:$text})-[:PLACEMENT]->()-[:SENTENCE]->(:Sentence {id:$id}) RETURN 1 AS present LIMIT 1',text=p.textId,id=item['id']):raise Missing('Sentence is not in this lesson')
        return p.answer.strip()==item['body'].strip()
    if not graph().read(check):return {'correct':False}
    def record(t):
        from zoneinfo import ZoneInfo
        if not check(t):return {'correct':False}
        day=datetime.now(ZoneInfo('Asia/Tokyo')).date().isoformat()
        t.create('Activity','practice:'+p.textId+':'+p.eventId,day=day,kind=p.kind,amount=1,details=packed({'textId':p.textId,'targetId':p.targetId}))
        return {'correct':True}
    return graph().write('practice.answer',record,'practice:'+p.textId+':'+p.eventId,scalar_only=True)
@app.post('/api/v1/graph/query')
def query(p:Query):return graph().query(p.query,p.params)
@app.post('/api/v1/graph/transaction')
def transaction(p:Transaction):return graph().raw_write([s.model_dump() for s in p.statements],p.dryRun,p.expectedRevisions)
@app.get('/api/v1/graph/export')
def export():return graph().read(lambda t:t.snapshot())
@app.get('/api/v1/graph/audit')
def audit():return graph().read(lambda t:validate_graph(t.snapshot()))
@app.post('/api/v1/maintenance/exclude-latin-vocabulary')
def exclude_latin_vocabulary(p:VocabularyCleanup):
    from api.vocabulary_cleanup import apply
    if not p.dryRun and not p.expectedFingerprint:raise ValueError('Apply requires the fingerprint from a reviewed dry run and backup')
    return graph().write('vocabulary.exclude-latin',lambda t:apply(t,p.expectedFingerprint),actor='agent',dry_run=p.dryRun)|{'dryRun':p.dryRun}
@app.post('/api/v1/graph/restore')
def restore(snapshot:dict[str,Any]):
    validate_graph(snapshot)
    return graph().write('graph.restore',lambda t:restore_into(t,snapshot),actor='agent')

def restore_into(t,snapshot):
    t.run('MATCH (n) WHERE NOT n:Schema DETACH DELETE n')
    from collections import defaultdict
    nodes=defaultdict(list);edges=defaultdict(list)
    for n in snapshot['nodes']:
        kind=next(k for k in n['labels'] if k!='Entity')
        if kind!='Schema':nodes[kind].append(n['properties'])
    for kind,items in nodes.items():t.run(f'UNWIND $items AS props CREATE (n:Entity:{kind}) SET n=props',items=items)
    for e in snapshot['edges']:edges[e['type']].append(e)
    for rel,items in edges.items():t.run(f'UNWIND $items AS e MATCH (a:Entity {{id:e.from}}),(b:Entity {{id:e.to}}) CREATE (a)-[:{rel}]->(b)',items=items)
    return {'restored':len(snapshot['nodes'])}

@app.post('/api/v1/migration/apply')
def migration_apply(snapshot:dict[str,Any]):
    validate_graph(snapshot)
    report=next((n['properties'] for n in snapshot['nodes'] if n['properties']['identityKey']=='legacy:report'),None)
    if not report:raise ValueError('Migration report is required')
    incoming=json.loads(report['payload'])
    def apply(t):
        old=t.find('legacy:report')
        if old:
            if json.loads(old['payload'])['sourceSha256']!=incoming['sourceSha256']:raise Conflict('A different snapshot has already been migrated')
            return {'alreadyMigrated':True,'sourceSha256':incoming['sourceSha256']}
        if t.run('MATCH (n) WHERE NOT n:Schema RETURN n.id AS id LIMIT 1'):raise Conflict('Migration requires an empty graph, including vocabulary and settings')
        return restore_into(t,snapshot)
    return graph().write('migration.apply',apply,actor='migration')

@app.post('/api/v1/worker/claim')
def claim(authorization:str|None=Header(default=None)):
    require_worker(authorization)
    def candidates(t):return t.run('MATCH (j:Job) WHERE j.jobState="pending" OR (j.jobState="running" AND j.lease<$now) RETURN j.id AS id,j.createdAt AS createdAt ORDER BY j.createdAt LIMIT 1',now=now())
    pending=graph().read(candidates)
    temporary=app.state.phrase_jobs.claim(pending[0]['createdAt'] if pending else None)
    if temporary:return {'job':temporary}
    if not pending:return {'job':None}
    def take(t):
        rows=candidates(t)
        if not rows:return {'job':None}
        j=t.get(rows[0]['id']);until=(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat()
        j=t.update(j['id'],jobState='running',lease=until,attempts=j['attempts']+1,result=packed({'_progress':job_info.progress('starting',0,0,now())}))
        return {'job':j|{'payload':json.loads(j['payload'])}}
    return graph().write('job.claim',take,actor='worker',scalar_only=True)
@app.post('/api/v1/worker/{id}/progress')
def worker_progress(id:str,p:JobProgress,authorization:str|None=Header(default=None)):
    require_worker(authorization)
    if p.completed>p.total:raise ValueError('Completed count exceeds total')
    def update(t):
        j=t.get(id)
        if j['kind'] not in ('import','retokenize') or j['jobState']!='running' or j['attempts']!=p.attempt:raise Conflict('Job lease changed')
        result=json.loads(j['result']);old=result.get('_progress',{})
        result['_progress']=job_info.progress(p.stage,p.completed if p.stage=='dictionary' else 0,p.total,old.get('startedAt',now()))
        t.update(id,result=packed(result),lease=(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat())
        return {'progress':result['_progress']}
    return graph().write('job.progress',update,actor='worker',scalar_only=True)
@app.post('/api/v1/worker/{id}/heartbeat')
def heartbeat(id:str,p:JobResult,authorization:str|None=Header(default=None)):
    require_worker(authorization)
    if PhraseJobs.owns(id):return app.state.phrase_jobs.heartbeat(id,p.attempt)
    def renew(t):
        j=t.get(id)
        if j['jobState']!='running' or j['attempts']!=p.attempt:raise Conflict('Job lease changed')
        return t.update(id,lease=(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat())
    return graph().write('job.heartbeat',renew,actor='worker',scalar_only=True)
@app.post('/api/v1/worker/{id}/complete')
def complete(id:str,p:JobResult,authorization:str|None=Header(default=None)):
    require_worker(authorization)
    if PhraseJobs.owns(id):return app.state.phrase_jobs.complete(id,p.attempt,p.result,p.error)
    def apply(t):
        j=t.get(id)
        if j['jobState']!='running' or j['attempts']!=p.attempt:raise Conflict('Job lease changed')
        if p.error:
            t.update(id,jobState='failed',error=p.error[:2000],lease='');return {'state':'failed'}
        payload=json.loads(j['payload']);result=p.result
        if j['kind']=='import':
            started=json.loads(j['result']).get('_progress',{}).get('startedAt',now())
            def report(stage,completed,total):LIVE_PROGRESS[id]=job_info.progress(stage,completed,total,started)
            result=domain.finalize_import(t,payload,result,report)
            result['_progress']=LIVE_PROGRESS.get(id,job_info.progress('ready',0,0,started))
        elif j['kind']=='speech':
            audio=base64.b64decode(result['audio'],validate=True)
            if not audio.startswith(b'RIFF') or audio[8:12]!=b'WAVE':raise ValueError('Worker did not return WAV audio')
            name=digest(audio.hex())+'.wav';path=app.state.media/name;tmp=path.with_suffix('.tmp')
            tmp.write_bytes(audio);tmp.replace(path)
            t.update(payload['speechId'],asset=name,jobState='ready')
            result={'url':'/api/v1/media/'+name}
        elif j['kind']=='translation':
            same=t.run('MATCH (tr:Translation {body:$body,meaning:$meaning}) RETURN tr.id AS id LIMIT 1',body=payload['text'],meaning=result['translation'])
            tr=t.get(same[0]['id']) if same else t.create('Translation',payload['key'],body=payload['text'],meaning=result['translation']);result={'translation':tr['meaning']}
        elif j['kind']=='word-meaning':result=word_meanings.complete(t,payload,result)
        elif j['kind']=='retokenize':
            from api.retokenize import plan
            _,report=plan(t.snapshot(),result['sentences'],payload.get('familyRepairs',[]))
            result={'sentences':result['sentences'],'plan':report,'_progress':json.loads(j['result']).get('_progress',{})}
        else:raise ValueError('Unknown job kind')
        t.update(id,jobState='ready',result=packed(result),error='',lease='')
        return result
    try:return graph().write('job.complete',apply,actor='worker')
    finally:LIVE_PROGRESS.pop(id,None)

@app.get('/api/v1/lexicon')
def lexicon():
    return graph().read(lambda t:t.run('MATCH (w:Word)-[:BASE_FORM]->(b) WITH b,collect(w.surface) AS forms RETURN b.id AS id,b.surface AS surface,b.reading AS reading,b.partOfSpeech AS partOfSpeech,[(b)-[:HAS_MEANING]->(m) | m.body] AS meanings,forms'))
