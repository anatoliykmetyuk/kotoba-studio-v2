"""Run with the v1 Python interpreter; imports only its tokenizer libraries, never its app."""
import json,re,sys
import fugashi,jaconv
analyzer=fugashi.Tagger()
result=[]
for body in json.load(sys.stdin):
 tokens=[];cursor=0
 for piece in re.split(r'(\s+)',body):
  if not piece:continue
  if piece.isspace():cursor+=len(piece);continue
  for n in analyzer(piece):
   start=body.find(n.surface,cursor);cursor=start+len(n.surface);f=n.feature
   if f.pos1 in ('補助記号','空白'):continue
   base=f.lemma or n.surface
   if base.endswith('-代名詞'):base=base.split('-')[0]
   tokens.append({'surface':n.surface,'base':base,'reading':jaconv.kata2hira(f.kana or ''),'baseReading':jaconv.kata2hira(f.lForm or f.kana or ''),'partOfSpeech':f.pos1,'start':start,'end':cursor})
 result.append(tokens)
json.dump(result,sys.stdout,ensure_ascii=False)
