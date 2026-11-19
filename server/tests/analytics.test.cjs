const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFileSync}=require('node:child_process');
const out=mkdtempSync(join(tmpdir(),'gulyai-analytics-test-'));
process.on('exit',()=>rmSync(out,{recursive:true,force:true}));

execFileSync(process.execPath,['node_modules/typescript/bin/tsc','src/analytics/index.ts','src/analytics/validation.ts','src/analytics/transport.ts','--outDir',out,'--module','commonjs','--target','es2022','--skipLibCheck','--esModuleInterop']);
require('node:fs').symlinkSync(join(process.cwd(),'node_modules'),join(out,'node_modules'),'dir');
const {cleanClientBatch,cleanProperties,analyticsAllowed}=require(join(out,'analytics/validation.js'));
const {AnalyticsTransport}=require(join(out,'analytics/transport.js'));
const event={id:'00000000-0000-4000-8000-000000000001',session_id:'00000000-0000-4000-8000-000000000002',event:'gulyai_screen_viewed',at:100000,properties:{screen:'map'}};
test('requires current consent, configuration, and non-excluded active account',()=>{const u={hasAgreedToRules:true,legalVersion:'2026-11-19'};assert.equal(analyticsAllowed(true,u,false),true);for(const args of [[false,u,false],[true,u,true],[true,{...u,isBanned:true},false],[true,{...u,legalVersion:'2026-10-29'},false],[true,null,false]])assert.equal(analyticsAllowed(...args),false);});
test('strips private text, IDs, URLs and injected identity',()=>{const [clean]=cleanClientBatch([{...event,distinct_id:'telegram-id',properties:{...event.properties,telegramId:123,bio:'secret',url:'secret',answers:['secret'],$ip:'1.2.3.4',active_ms:2000}}],100000);assert.deepEqual(clean.properties,{screen:'map',active_ms:2000});assert.equal('distinct_id' in clean,false);});
test('rejects server-success spoofing, invalid duration, oversized batches and timestamps',()=>{for(const batch of [[{...event,event:'gulyai_meetup_created'}],[{...event,event:'gulyai_screen_active',properties:{screen:'map',active_ms:Infinity}}],Array(41).fill(event),[{...event,at:-4000000}],[{...event,id:'telegram-id'}]])assert.throws(()=>cleanClientBatch(batch,100000));assert.equal(cleanClientBatch([event,event],100000).length,1);assert.deepEqual(cleanProperties({screen:'private text',element:'unknown',answered_count:9}),{});});
const ph={uuid:event.id,event:event.event,distinct_id:event.session_id,timestamp:new Date().toISOString(),properties:{}};
test('transport retries transient errors with the same UUID and private endpoint',async()=>{const calls=[];let n=0;const t=new AnalyticsTransport('test-token','https://eu.i.posthog.com',async(url,opts)=>{calls.push([url,JSON.parse(opts.body)]);return {ok:++n>1,status:n>1?200:503}});t.enqueue(ph);await t.flush();await t.flush();assert.equal(calls.length,2);assert.equal(calls[0][0],'https://eu.i.posthog.com/batch/');assert.equal(calls[0][1].batch[0].uuid,calls[1][1].batch[0].uuid);});
test('transport drops permanent errors and forgets deleted identities',async()=>{let n=0;const t=new AnalyticsTransport('test','https://eu.i.posthog.com',async()=>{n++;return {ok:false,status:400}});t.enqueue(ph);await t.flush();await t.flush();assert.equal(n,1);t.enqueue(ph);t.forget(ph.distinct_id);await t.flush();assert.equal(n,1);});

test('server boundary uses random identity, suppresses excluded/no-consent accounts, and deduplicates retries',async()=>{
 process.env.POSTHOG_ENABLED='1';process.env.POSTHOG_PROJECT_TOKEN='phc_test';process.env.POSTHOG_HOST='https://eu.i.posthog.com';process.env.ADMIN_TELEGRAM_IDS='999';
 const {User}=require(join(out,'models/User.js'));
 const originalFind=User.findOne,originalUpdate=User.findOneAndUpdate,originalFetch=global.fetch;
 const user={telegramId:101,firstName:'Private Name',hasAgreedToRules:true,legalVersion:'2026-11-19'};
 let reads=0;const batches=[];
 User.findOne=()=>({lean:async()=>{reads++;return {...user}}});
 User.findOneAndUpdate=(_filter,update)=>({lean:async()=>{user.analyticsId=update.$set.analyticsId;return {...user}}});
 global.fetch=async(_url,opts)=>{batches.push(JSON.parse(opts.body));return {ok:true,status:200}};
 const analytics=require(join(out,'analytics/index.js'));
 let route;analytics.setupAnalyticsRoutes({post:(_path,...handlers)=>{route=handlers.at(-1)}});
 const status=[];const res={sendStatus:n=>{status.push(n);return res}};
 const send=(id,e={...event,at:Date.now(),properties:{screen:'people',bio:'secret',telegramId:101}})=>route({telegramUser:{id},body:{events:[e]}},res);
 try {
   process.env.POSTHOG_HOST='https://us.i.posthog.com';assert.equal(analytics.analyticsConfigured(),false);process.env.POSTHOG_HOST='https://eu.i.posthog.com';
   await send(999);assert.equal(reads,0);
   user.legalVersion='2026-10-29';await send(101);await analytics.shutdownAnalytics();assert.equal(batches.length,0);
   user.legalVersion='2026-11-19';analytics.invalidateAnalyticsUser(101);await send(101);await send(101);
   await analytics.shutdownAnalytics();assert.equal(batches.length,1);assert.equal(batches[0].batch.length,1);
   const captured=batches[0].batch[0];assert.match(captured.distinct_id,/^[0-9a-f-]{36}$/);assert.notEqual(captured.distinct_id,'101');
   assert.equal(captured.properties.screen_label,'Люди');assert.equal(captured.properties.$geoip_disable,true);assert.equal(captured.properties.$process_person_profile,false);assert.equal(captured.properties.$ip,null);
   assert.equal(JSON.stringify(captured).includes('secret'),false);assert.equal(JSON.stringify(captured).includes('Private Name'),false);assert.equal('telegramId' in captured.properties,false);
   assert.ok(status.every(n=>n===204));
 } finally {User.findOne=originalFind;User.findOneAndUpdate=originalUpdate;global.fetch=originalFetch;await analytics.shutdownAnalytics();}
});
