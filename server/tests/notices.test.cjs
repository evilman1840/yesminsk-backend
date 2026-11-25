const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync,symlinkSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {execFileSync}=require('node:child_process');
const out=mkdtempSync(join(tmpdir(),'gulyai-notice-server-'));
process.on('exit',()=>rmSync(out,{recursive:true,force:true}));
execFileSync(process.execPath,['node_modules/typescript/bin/tsc','src/eventJoin.ts','src/analytics/validation.ts','--outDir',out,'--module','commonjs','--target','es2022','--skipLibCheck','--esModuleInterop','--strict']);
symlinkSync(join(process.cwd(),'node_modules'),join(out,'node_modules'),'dir');
const {cleanClientBatch,cleanProperties}=require(join(out,'analytics/validation.js'));
const id='00000000-0000-4000-8000-000000000001';
const e={id,session_id:id,at:100000,event:'gulyai_notice_seen',properties:{screen:'map',notice_kind:'meetup',notice_placement:'bottom'}};
test('accepts only fixed notice categories; strips texts, IDs and arbitrary attribution',()=>{
 const [clean]=cleanClientBatch([{...e,properties:{...e.properties,title:'secret',eventId:'private-id',entry_point:'bottom_notice'}}],100000);
 assert.deepEqual(clean.properties,{screen:'map',notice_kind:'meetup',notice_placement:'bottom',entry_point:'bottom_notice'});
 assert.deepEqual(cleanProperties({notice_kind:'private-id',notice_placement:'secret',entry_point:'secret'}),{});
 assert.throws(()=>cleanClientBatch([{...e,properties:{screen:'map',notice_kind:'event-123',notice_placement:'bottom'}}],100000));
});
test('clients cannot forge successful signup events',()=>{
 assert.throws(()=>cleanClientBatch([{...e,event:'gulyai_meetup_signup_saved'}],100000));
});
test('notice origin is recorded only after a new successful signup, not errors or repeat joins',async()=>{
 const analytics=require(join(out,'analytics/index.js'));
 const telegram=require(join(out,'utils/telegramNotify.js'));
 const saved=[], originalCapture=analytics.captureAnalytics, originalSend=telegram.sendTelegramMessage;
 analytics.captureAnalytics=(...args)=>saved.push(args);telegram.sendTelegramMessage=async()=>true;
 const {joinEvent}=require(join(out,'eventJoin.js'));
 let writes=0;
 const ev={_id:'000000000000000000000001',creator:{telegramId:999},participants:[],title:'Walk',category:'walk',dateTime:new Date(),locationName:'Park',save:async()=>{writes++}};
 try {
   const tg={id:101,first_name:'A'};
   const opts={guests:0,withKids:false,analyticsEntryPoint:'bottom_notice'};
   const result=await joinEvent(ev,null,tg,opts);
   assert.equal(result.ok,true);assert.equal(writes,1);
   assert.equal(saved[0][1],'gulyai_meetup_signup_saved');assert.deepEqual(saved[0][2],{entry_point:'bottom_notice'});
   await joinEvent(ev,null,tg,opts);assert.equal(saved.length,2);
   const full={...ev,maxParticipants:1,participants:[{telegramId:999}],save:async()=>{throw Error('should not save')}};
   const fail=await joinEvent(full,null,{id:102},opts);assert.equal(fail.ok,false);assert.equal(saved.length,2);
 } finally {analytics.captureAnalytics=originalCapture;telegram.sendTelegramMessage=originalSend;}
});
