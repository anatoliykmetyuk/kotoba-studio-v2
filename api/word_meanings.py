"""Lazy dictionary-first word meanings, persisted through validated graph writes."""
from api import domain
from api.graph import Missing


def request(t,id,create=False):
    word=t.get(id)
    if word['type']!='Word':raise Missing('Word not found')
    base=t.get(word['family'])
    meanings=domain.word_meanings(t,id)
    if meanings:return {'wordId':base['id'],'state':'ready','meanings':meanings,'cached':True}
    key='word-meaning:'+base['id']
    job=t.find(key)
    if job and job['jobState']!='ready':
        return {'wordId':base['id'],'state':job['jobState'],'meanings':[],
                'jobId':job['id'],'error':job['error'],'cached':False}
    if not create:return None
    # Re-read under the graph writer lock before creating the sole family job.
    # A completed job with manually removed meanings can be requested again.
    if job:job=t.update(job['id'],jobState='pending',error='',result='{}',lease='')
    else:
        job=domain.create_job(t,'word-meaning',{'wordId':base['id'],'text':base['surface'],
                                             'reading':base['reading'],'partOfSpeech':base['partOfSpeech']},key)
    return {'wordId':base['id'],'state':job['jobState'],'meanings':[],
            'jobId':job['id'],'error':job['error'],'cached':False}


def complete(t,payload,result):
    word=t.get(payload['wordId'])
    if word['type']!='Word':raise Missing('Word not found')
    meanings=domain.word_meanings(t,word['id'])
    # A dictionary import or user edit may have supplied meanings while queued.
    if not meanings:
        choices=result.get('meanings')
        if not isinstance(choices,list) or not choices:raise ValueError('Worker did not return word meanings')
        for choice in choices:
            if not isinstance(choice,dict):raise ValueError('Invalid word meaning')
            body=choice.get('meaning')
            if not isinstance(body,str) or not 1<=len(body.strip())<=2000:raise ValueError('Invalid word meaning')
            if choice.get('sourceType') not in ('JMdict','local-model'):raise ValueError('Invalid word meaning source')
            if not isinstance(choice.get('sense'),str) or not choice['sense']:raise ValueError('Missing word meaning provenance')
        # These choices came from a lookup of this exact stored spelling. A
        # retained legacy family can differ from Ichiran's current lemma; attach
        # its dictionary analysis without rewiring that family's learning status.
        domain.add_meanings(t,word,choices,direct_lookup=True)
        meanings=domain.word_meanings(t,word['id'])
        if not meanings:raise ValueError('Word meanings were not persisted')
    return {'wordId':word['id'],'state':'ready','meanings':meanings,'cached':False}
