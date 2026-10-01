import {test as base} from '@playwright/test';
import {muteBrowserContext} from './audio-output';

// Every page in every test context, including additional tabs, is silent.
// Native decoding, playback time and ended events remain available to tests.
export const test=base.extend({context:async({context},use)=>{
 await muteBrowserContext(context);await use(context);
}});
export {expect,chromium} from '@playwright/test';
export type {APIRequestContext,Page,Locator,Request} from '@playwright/test';
