import {expect} from '@playwright/test';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
const execute=promisify(execFile);

export async function pauseAcceptanceWorker(){
 const root=resolve('.'),pid=Number((await readFile(resolve(root,'.runtime/acceptance/worker.pid'),'utf8')).trim());
 expect(Number.isInteger(pid)&&pid>1).toBe(true);
 const productionPid=await readFile(resolve(root,'.runtime/production/worker.pid'),'utf8').catch(()=>null);
 expect(String(pid)).not.toBe(productionPid?.trim());
 expect((await execute('ps',['-p',String(pid),'-o','command='])).stdout).toContain('-m worker.main');
 expect((await execute('lsof',['-a','-p',String(pid),'-d','cwd','-Fn'])).stdout).toContain('\nn'+root+'\n');
 process.kill(pid,'SIGSTOP');
 let paused=true;
 return ()=>{if(paused){process.kill(pid,'SIGCONT');paused=false}};
}
