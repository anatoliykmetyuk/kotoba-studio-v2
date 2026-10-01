import {test,expect} from './fixtures';
import type {TextItem} from '../../web/src/api';

test('kanji ruby preserves whole-token interaction and exact source text',async({page,request},info)=>{
 const body='不足しており、求めています。見込みです。しかし、ゼレンスキー大統領は追加支援を求めています。２０２６年と270億ドル。記録 phone-webkit-portrait 1790853448043。';
 const response=await request.post('/api/v1/imports',{data:{title:'Kanji furigana acceptance',body}});
 expect(response.ok()).toBe(true);const submitted=await response.json();let id=submitted.textId;
 if(!id)await expect.poll(async()=>{
  const job=await(await request.get('/api/v1/jobs/'+submitted.jobId)).json();
  if(job.state==='failed')throw new Error(job.error);id=job.result.textId;return job.state;
 },{timeout:60_000}).toBe('ready');
 const text:TextItem=await(await request.get('/api/v1/texts/'+id)).json();
 for(const wordId of new Set(text.sentences.flatMap(sentence=>sentence.tokens.map(token=>token.wordId)))){
  expect((await request.put('/api/v1/words/'+wordId+'/status',{data:{state:'new'}})).ok()).toBe(true);
 }
 expect((await request.patch('/api/v1/settings',{data:{furigana:true,fontSize:20,lineHeight:1.85}})).ok()).toBe(true);
 await page.goto('/#'+id);await expect(page.locator('.book-body')).toBeVisible();
 const annotated=await page.locator('.book-body ruby').evaluateAll(rubies=>rubies.map(ruby=>{
  const rt=ruby.querySelector('rt')!,base=ruby.cloneNode(true) as Element;base.querySelector('rt')!.remove();
  return {base:base.textContent,reading:rt.textContent};
 }));
 expect(annotated).toContainEqual({base:'不足',reading:'ふそく'});
 expect(annotated).toContainEqual({base:'求',reading:'もと'});
 for(const {base} of annotated)expect(base).toMatch(/^(?:[\p{Unified_Ideograph}\uF900-\uFAFF\u{2F800}-\u{2FA1F}々〇]\p{Variation_Selector}*)+$/u);
 for(const sentence of text.sentences){
  expect(await page.locator(`[data-sentence="${sentence.id}"]`).evaluate(element=>{
   const source=element.cloneNode(true) as Element;source.querySelectorAll('rt').forEach(rt=>rt.remove());return source.textContent;
  })).toBe(sentence.body);
  for(const token of sentence.tokens)await expect(page.locator(`[data-token-id="${token.id}"]`)).toHaveAttribute('data-word-end',String(sentence.start+token.end));
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('kanji-furigana.png')});
 await page.getByRole('button',{name:'Reading options',exact:true}).click();
 await page.getByLabel('Furigana for New and Learning words').uncheck();
 await expect(page.locator('.book-body ruby')).toHaveCount(0);
 await page.getByLabel('Furigana for New and Learning words').check();
 await expect(page.locator('.book-body ruby').first()).toBeVisible();
});
