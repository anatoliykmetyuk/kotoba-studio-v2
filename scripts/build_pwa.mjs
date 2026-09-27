import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const assets=(await readdir('dist/assets')).map(name=>'/assets/'+name);
const version=createHash('sha256').update(await readFile('dist/index.html')).digest('hex').slice(0,16);
const files=['/','/index.html','/manifest.webmanifest','/icons/kotoba-192.png','/icons/kotoba-512.png','/icons/kotoba-maskable-512.png','/icons/apple-touch-icon.png',...assets];
const source=await readFile('web/sw.js','utf8');
await writeFile('dist/sw.js',`const VERSION=${JSON.stringify(version)};const PRECACHE=${JSON.stringify(files)};\n`+source);
