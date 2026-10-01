import {test,expect} from './fixtures';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {muteTestOutput} from './audio-output';
const execute=promisify(execFile);

test('cold word and Explore query failures show retry instead of loading or empty results',async({page,request,context})=>{
 test.skip(process.env.KOTOBA_UI_OUTAGE!=='1','Requires exclusive isolated acceptance API control.');
 await muteTestOutput(page);
 const response=await request.post('/api/v1/imports',{data:{title:'Query errors acceptance',body:'猫は窓のそばで眠っています。私は温かいお茶を飲みました。',folder:'Acceptance'}});
 expect(response.ok()).toBe(true);const imported=await response.json();let id=imported.textId;
 if(!id)await expect.poll(async()=>{const job=await(await request.get('/api/v1/jobs/'+imported.jobId)).json();id=job.result.textId;return job.state}).toBe('ready');
 await page.goto('/#'+id);await expect(page.locator('.token').first()).toBeVisible();
 const search=await context.newPage();await muteTestOutput(search);
 try{
  await execute('.venv/bin/python',['-c',"from cli.main import compose; compose('acceptance',['stop','api'])"]);
  await page.locator('.token').first().click();const word=page.getByRole('dialog',{name:'Word details',exact:true});
  await expect(word.getByRole('alert')).toContainText('Could not load word details');
  await expect(word.getByText('Loading meanings…',{exact:true})).toHaveCount(0);
  await search.goto('/#explore');await expect(search.locator('.query-error')).toContainText('Could not search the corpus');
  await expect(search.getByText('No matching sentences.',{exact:true})).toHaveCount(0);
  await execute('.venv/bin/python',['-c',"from cli.main import compose,wait_ready; compose('acceptance',['start','api']); wait_ready('http://127.0.0.1:3011')"]);
  await word.getByRole('button',{name:'Retry',exact:true}).click();await expect(word.locator('.word-meanings ol')).toBeVisible();
  await search.locator('.query-error').getByRole('button',{name:'Retry',exact:true}).click();await expect(search.locator('.query-error')).toHaveCount(0);await expect(search.locator('.explore-card').first()).toBeVisible();
 }finally{
  await execute('.venv/bin/python',['-c',"from cli.main import compose,wait_ready; compose('acceptance',['start','api']); wait_ready('http://127.0.0.1:3011')"]);await search.close();
 }
});
