import {test,expect} from './fixtures';
import {penTap} from './input';
import {muteTestOutput} from './audio-output';

test('shared activation supports pen across navigation, Settings, forms and lesson actions',async({page,browserName},info)=>{
 await muteTestOutput(page);
 await page.goto('/');
 const settingsButton=page.getByRole('button',{name:'Settings',exact:true});
 await penTap(page,settingsButton,browserName);
 const settings=page.getByRole('dialog',{name:'Settings',exact:true});await expect(settings).toBeVisible();
 const checkbox=settings.getByRole('checkbox');const initial=await checkbox.isChecked();
 const label=checkbox.locator('..');
 await penTap(page,label,browserName);await expect(checkbox).toBeChecked({checked:!initial});
 // The normal compatibility click arriving later must not toggle a second time.
 const point=await label.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}});
 if(browserName!=='chromium')await label.dispatchEvent('click',{detail:1,clientX:point.x,clientY:point.y});
 await expect(checkbox).toBeChecked({checked:!initial});
 await penTap(page,label,browserName);await expect(checkbox).toBeChecked({checked:initial});
 await penTap(page,settings.getByRole('button',{name:'Close',exact:true}),browserName);await expect(settings).toHaveCount(0);
 await penTap(page,settingsButton,browserName);await expect(settings).toBeVisible();
 await penTap(page,settings,browserName,{x:2,y:2});await expect(settings).toHaveCount(0);
 // Import uses the same shared dialog and native form submission.
 await penTap(page,page.getByRole('button',{name:'Import text',exact:true}),browserName);
 const form=page.getByRole('dialog',{name:'Import text',exact:true});await expect(form).toBeVisible();
 const submit=form.getByRole('button',{name:'Import & read',exact:true});await expect(submit).toBeDisabled();
 const title=form.getByRole('textbox',{name:'Title',exact:true});
 if(browserName==='chromium'){
  await penTap(page,title,browserName);await expect(title).toBeFocused();
  const chooser=page.waitForEvent('filechooser');await penTap(page,form.locator('.file-button'),browserName);
  await (await chooser).setFiles({name:'pen-input.txt',mimeType:'text/plain',buffer:Buffer.from('猫は窓のそばで眠っています。私は温かいお茶を飲みました。')});
 }else await form.getByRole('textbox',{name:'Japanese text',exact:true}).fill('猫は窓のそばで眠っています。私は温かいお茶を飲みました。');
 await title.fill('Unified input acceptance');
 const imported=page.waitForResponse(r=>r.url().endsWith('/api/v1/imports')&&r.request().method()==='POST');
 await penTap(page,submit,browserName);expect((await imported).ok()).toBe(true);
 await expect(page.locator('.book-body')).toBeVisible();await expect(form).toHaveCount(0);
 await penTap(page,page.getByRole('button',{name:'Reading options',exact:true}),browserName);await expect(settings).toBeVisible();
 await penTap(page,settings.getByRole('button',{name:'Close',exact:true}),browserName);await expect(settings).toHaveCount(0);
 await penTap(page,page.locator('.token').first(),browserName);
 const word=page.getByRole('dialog',{name:'Word details',exact:true});await expect(word).toBeVisible();
 await penTap(page,word.getByRole('button',{name:'Close word details',exact:true}),browserName);await expect(word).toHaveCount(0);
 await penTap(page,page.getByRole('button',{name:'Practice',exact:true}),browserName);await expect(page.getByRole('heading',{name:'Practice',exact:true})).toBeVisible();
 await penTap(page,page.getByRole('button',{name:'Back to lesson',exact:true}),browserName);await expect(page.locator('.book-body')).toBeVisible();
 // The completion confirmation is another native dialog using the same input path.
 const finish=page.getByRole('button',{name:'Complete text',exact:true});
 if(await finish.count()){
  await penTap(page,finish,browserName);const confirmation=page.getByRole('dialog',{name:'Complete lesson',exact:true});await expect(confirmation).toBeVisible();
  await penTap(page,confirmation.getByRole('button',{name:'Cancel',exact:true}),browserName);await expect(confirmation).toHaveCount(0);
 }
 await penTap(page,page.getByRole('button',{name:'Library',exact:true}).filter({has:page.locator('svg')}).last(),browserName);
 await expect(page.getByRole('heading',{name:'Library',exact:true})).toBeVisible();
 const explore=page.getByRole('button',{name:'Explore',exact:true});await penTap(page,explore,browserName);
 await expect(page.getByRole('heading',{name:'Explore',exact:true})).toBeVisible();
 await penTap(page,page.getByRole('checkbox',{name:'At least 80% known'}),browserName);await expect(page.getByRole('checkbox',{name:'At least 80% known'})).toBeChecked();
 await page.screenshot({path:info.outputPath('unified-pen-navigation.png')});
});
