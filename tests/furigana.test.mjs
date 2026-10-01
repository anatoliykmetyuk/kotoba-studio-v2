import assert from 'node:assert/strict';
import {after,test} from 'node:test';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

const root=fileURLToPath(new URL('..',import.meta.url));
await mkdir(path.join(root,'.runtime'),{recursive:true});
const output=await mkdtemp(path.join(root,'.runtime/furigana-tests-'));
for(const [name,extension] of [['furigana','ts'],['furigana-text','tsx']]){
 const source=await readFile(path.join(root,'web/src',name+'.'+extension),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText.replace("from './furigana'","from './furigana.mjs'");
 await writeFile(path.join(output,name+'.mjs'),compiled);
}
const {furiganaParts}=await import(pathToFileURL(path.join(output,'furigana.mjs')));
const {FuriganaText}=await import(pathToFileURL(path.join(output,'furigana-text.mjs')));
after(()=>rm(output,{recursive:true,force:true}));

const examples=[
 ['不足しており','ふそくしており',[['不足','ふそく'],['しており']]],
 ['求めています','もとめています',[['求','もと'],['めています']]],
 ['見込み','みこみ',[['見込','みこ'],['み']]],
 ['取り扱い','とりあつかい',[['取','と'],['り'],['扱','あつか'],['い']]],
 ['お祝い','おいわい',[['お'],['祝','いわ'],['い']]],
 ['お取り寄せ','おとりよせ',[['お'],['取','と'],['り'],['寄','よ'],['せ']]],
 ['ゼレンスキー大統領','ぜれんすきーだいとうりょう',[['ゼレンスキー'],['大統領','だいとうりょう']]],
 ['ｶﾞｯｺｳ前','がっこうまえ',[['ｶﾞｯｺｳ'],['前','まえ']]],
 ['時々','ときどき',[['時々','ときどき']]],
 ['𠮷野家','よしのや',[['𠮷野家','よしのや']]],
 ['神','かみ',[['神','かみ']]],
 ['社会','しゃかい',[['社会','しゃかい']]],
 ['福岡','ふくおか',[['福岡','ふくおか']]],
 ['\u{2F800}','れい',[['\u{2F800}','れい']]],
 ['神に','かみに',[['神','かみ'],['に']]],
 ['辻\u{E0100}に','つじに',[['辻\u{E0100}','つじ'],['に']]],
 ['学校','ガッコウ',[['学校','がっこう']]],
 ['学校','ｶﾞｯｺｳ',[['学校','がっこう']]],
 ['読み終えた','よみおえた',[['読','よ'],['み'],['終','お'],['えた']]],
];
for(const [surface,reading,expected] of examples)test(`ruby only annotates kanji in ${surface}`,()=>{
 const parts=furiganaParts(surface,reading);
 assert.deepEqual(parts,expected.map(([text,reading])=>reading?{text,reading}:{text}));
 assert.equal(parts.map(part=>part.text).join(''),surface);
 for(const part of parts.filter(part=>part.reading))assert.match(part.text,/^(?:[\p{Unified_Ideograph}\uF900-\uFAFF\u{2F800}-\u{2FA1F}々〇]\p{Variation_Selector}*)+$/u);
});

for(const [surface,reading] of [
 ['しかし','しかし'],['ウクライナ','うくらいな'],['ｶﾞｯｺｳ','がっこう'],
 ['2026','にせんにじゅうろく'],['2026 年','にせんにじゅうろくねん'],
 ['270億','にひゃくななじゅうおく'],['食べた','たべる'],
 ['甲か乙','あかかい'],['猫',''],['猫','<script>'],['ABX48','えーびーえっくす'],
])test(`unneeded or unresolvable ruby stays plain for ${surface}/${reading}`,()=>{
 assert.deepEqual(furiganaParts(surface,reading),[{text:surface}]);
});

test('the component emits independent ruby followed by unchanged kana',()=>{
 assert.equal(renderToStaticMarkup(createElement(FuriganaText,{text:'不足しており',reading:'ふそくしており'})),
  '<ruby>不足<rt>ふそく</rt></ruby>しており');
 assert.equal(renderToStaticMarkup(createElement(FuriganaText,{text:'取り扱い',reading:'とりあつかい'})),
  '<ruby>取<rt>と</rt></ruby>り<ruby>扱<rt>あつか</rt></ruby>い');
});

test('disabled furigana emits source text without a ruby element',()=>{
 assert.equal(renderToStaticMarkup(createElement(FuriganaText,{text:'不足しており',reading:''})),'不足しており');
});

test('source and reading are rendered as escaped text',()=>{
 assert.equal(renderToStaticMarkup(createElement(FuriganaText,{text:'<猫>',reading:'<script>'})),'&lt;猫&gt;');
});
