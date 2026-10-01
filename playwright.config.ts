import {defineConfig,devices} from '@playwright/test';
export default defineConfig({testDir:'tests/browser',timeout:120_000,expect:{timeout:15_000},workers:1,retries:0,reporter:[['list'],['html',{open:'never'}]],use:{baseURL:process.env.KOTOBA_TEST_BASE_URL??'http://127.0.0.1:3011',trace:'retain-on-failure',screenshot:'only-on-failure'},projects:[
 {name:'phone-chromium-portrait',use:{...devices['Pixel 7'],browserName:'chromium',launchOptions:{args:['--mute-audio']}}},
 {name:'phone-chromium-landscape',use:{...devices['Pixel 7 landscape'],browserName:'chromium',launchOptions:{args:['--mute-audio']}}},
 {name:'phone-webkit-portrait',use:{...devices['iPhone 13'],browserName:'webkit'}},
 {name:'phone-webkit-landscape',use:{...devices['iPhone 13 landscape'],browserName:'webkit'}},
 {name:'ipad-webkit-portrait',use:{...devices['iPad (gen 7)'],browserName:'webkit'}},
 {name:'ipad-webkit-landscape',use:{...devices['iPad (gen 7) landscape'],browserName:'webkit'}},
 {name:'desktop-chromium',testMatch:['word-overlay.spec.ts','selection-modes.spec.ts','pwa-update.spec.ts','unified-input.spec.ts','sentence-reorder.spec.ts'],use:{browserName:'chromium',launchOptions:{args:['--mute-audio']},viewport:{width:1440,height:900}}},
 {name:'desktop-webkit',testMatch:['word-overlay.spec.ts','selection-modes.spec.ts','pwa-update.spec.ts','unified-input.spec.ts','sentence-reorder.spec.ts'],use:{browserName:'webkit',viewport:{width:1440,height:900}}}]});
