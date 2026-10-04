import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sigmadesk-product-'));
const repo=path.join(tmp,'repo');fs.mkdirSync(repo);execFileSync('git',['init','-q','-b','main',repo]);fs.writeFileSync(path.join(repo,'README.md'),'Fixture repository');execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','fixture']);
process.env.SIGMADESK_WORKSPACES=path.join(tmp,'workspaces');
process.env.SIGMADESK_CONFIG=path.join(tmp,'config.json');fs.writeFileSync(process.env.SIGMADESK_CONFIG,JSON.stringify({project:{repoPath:repo},github:{sync:false},pm:{enabled:false}}));
let store,review,team,settings,dispatch,sched;
before(async()=>{
  const {config}=await import('../src/config.js');config.root=tmp;
  store=await import('../src/db.js');store.openDb(':memory:');review=await import('../src/product-review.js');team=await import('../src/team.js');settings=await import('../src/team-settings.js');dispatch=await import('../src/dispatch.js');sched=await import('../src/scheduler.js');
});
after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const report=(verdict='support')=>({verdict,recommendation:'Add a small read-only preview.',users:['Desk operator'],benefits:['Faster context'],drawbacks:['Additional screen space'],alternatives:['Keep the current view'],evidence:['Supplied acceptance criteria'],conditions:verdict==='support'?[]:['Verify the missing user scenario'],architecture:'Reuse the existing dashboard component.',rollout:'Preview with fixtures, then limited rollout; revert if errors rise.',success_metric:'Task completion without errors.'});
const ticket=()=>store.createTicket({title:'Trading dashboard proposal',description:'Improve mobile risk visibility.',area:'frontend',type:'feature',status:'todo'});
const finish=(r,agent,verdict='support')=>review.complete(r.ticket_key,r.phase,r.revision,agent,{report:report(verdict),run_id:1,model:'codex:fixture'});

test('independent roles precede manager synthesis and every required perspective must support',()=>{
 const t=ticket(),r=review.start(t.key);
 assert.deepEqual(review.reviewersFor(t),['pm','principal-fe','product-design','trading-advisor']);
 assert.ok(!review.pending().some(x=>x.r.ticket_key===t.key&&x.m.agent_id==='manager'));
 for(const m of r.members.filter(m=>m.stage==='review'))finish(r,m.agent_id,m.agent_id==='trading-advisor'?'concern':'support');
 assert.ok(review.pending().some(x=>x.r.ticket_key===t.key&&x.m.stage==='challenge'));
 assert.ok(!review.pending().some(x=>x.r.ticket_key===t.key&&x.m.agent_id==='manager'));
 finish(r,'trading-advisor','concern');
 assert.ok(review.pending().some(x=>x.r.ticket_key===t.key&&x.m.agent_id==='manager'));
 finish(r,'manager');assert.equal(review.current(t.key).status,'changes');assert.equal(review.blocks(t),true);
 assert.throws(()=>review.decide(t.key,{revision:r.revision,action:'approve'}),/Choose/);
});

test('approval is invalidated by scope changes, not progress; feedback is pinned to SHA',()=>{
 const t=ticket(),r=review.start(t.key);
 for(const m of r.members)finish(r,m.agent_id);
 assert.equal(review.blocks(t),false);
 store.updateTicket(t.key,{progress:50});assert.equal(review.current(t.key).stale,false);
 store.updateTicket(t.key,{description:'A materially different plan'});assert.equal(review.current(t.key).stale,true);assert.equal(review.blocks(store.getTicket(t.key)),true);
 const f=review.start(t.key,{phase:'feedback'});for(const m of f.members)finish(f,m.agent_id);
 store.updateTicket(t.key,{head_sha:'a'.repeat(40)});assert.equal(review.current(t.key,'feedback').stale,true);
});

test('reports require evidence, balanced assessment, and no unresolved conditions for support',()=>{
 assert.deepEqual(review.parseReport(JSON.stringify(report())),report());
 assert.throws(()=>review.parseReport(JSON.stringify({...report(),conditions:['Missing evidence']})),/support cannot/);
 assert.throws(()=>review.parseReport(JSON.stringify({...report(),evidence:[]})),/Review needs/);
 assert.ok(review.reviewersFor({...ticket(),title:'Backtest a predictive signal'}).includes('quant-research'));
});

test('review restart/retry retains completed judgments and revision checks reject stale actions',()=>{
 const t=ticket(),r=review.start(t.key);finish(r,'pm');
 const raw=review.current(t.key);raw.members[1].status='running';store.kvSet(`product-review:${t.key}:plan`,JSON.stringify(raw));
 review.recover();assert.equal(review.current(t.key).status,'failed');
 const retry=review.decide(t.key,{revision:r.revision,action:'retry'});assert.equal(retry.members[0].status,'complete');assert.equal(retry.members[1].status,'pending');
 assert.throws(()=>review.decide(t.key,{revision:99,action:'reject'}),/changed/);
 const before=review.promptFor(r,r.members[0]);assert.ok(!before.includes('<reviews>'));
 const after=review.promptFor(review.current(t.key),r.members.at(-1));assert.ok(after.includes('<reviews>'));
});

test('reviewers cannot groom, trade, publish, or mutate tickets through desk commands',async()=>{
 const t=ticket();for(const cmd of ['groom','create-task','submit','accept','comment','show'])await assert.rejects(sched.deskAction({kind:'product_review',agent_id:'pm',ticket_key:t.key},cmd,{}),/read-only/);
 const runner=await import('../src/runner.js');
 const codex=runner.buildCommand({...team.agentById.pm,engine:'codex'},'product_review',repo);
 assert.ok(codex.args.includes('default_permissions="sigmadesk_review"'));assert.equal(codex.mailbox,false);
 const claude=runner.buildCommand({...team.agentById.pm,engine:'claude'},'product_review',repo);
 const sandbox=JSON.parse(claude.args[claude.args.indexOf('--settings')+1]).sandbox;
 assert.deepEqual(sandbox.filesystem.allowWrite,[]);assert.ok(sandbox.filesystem.denyWrite.includes(repo));
 assert.equal(sandbox.autoAllowBashIfSandboxed,false);
 assert.ok(!claude.args[claude.args.indexOf('--append-system-prompt')+1].includes('desk propose'));
});

test('model settings validate capability, effort, fallback uniqueness and preserve enabled state',()=>{
 const p=settings.normalizeSeat('senior-be',{engine:'codex',model:'',effort:'medium',fallbacks:[{engine:'claude',model:'sonnet',effort:'high'}]});
 assert.equal(p.fallbacks[0].engine,'claude');
 assert.throws(()=>settings.normalizeSeat('qa',{engine:'perplexity',model:'pplx_asi_kimi_k3'}),/cannot perform/);
 assert.throws(()=>settings.normalizeSeat('pm',{engine:'codex',model:'made-up-model'}),/catalog/);
 assert.throws(()=>settings.normalizeSeat('pm',{engine:'codex',model:'',effort:'made-up-effort'}),/effort/);
 assert.throws(()=>settings.normalizeSeat('pm',{engine:'codex',model:'',fallbacks:[{engine:'codex',model:'',effort:'high'}]}),/distinct/);
 assert.equal(settings.normalizeSeat('pm',{model:'opus'},{...team.agentById.pm,enabled:false}).enabled,false);
 assert.equal(settings.normalizeSeat('senior-be',{fallback_mode:'automatic'},{...p,fallbacks:p.fallbacks}).fallbacks,undefined);
});

test('fallback follows saved order, preserves preference and waits if all providers are held',()=>{
 dispatch.setAvailability([{id:'claude',available:true},{id:'codex',available:true,defaultModel:'fixture'},{id:'perplexity',available:true}]);store.setSetting('auto_fallback','true');
 team.applyTeamOverrides({pm:{engine:'claude',model:'opus',effort:'high',fallbacks:[{engine:'codex',model:'custom-backup',effort:'medium'}]}});
 store.kvSet('provider-hold:claude',JSON.stringify({until:new Date(Date.now()+60000).toISOString(),reason:'Test hold'}));
 assert.equal(dispatch.selectionFor('pm').seat.model,'custom-backup');assert.equal(team.agentById.pm.engine,'claude');
 store.kvSet('provider-hold:codex',JSON.stringify({until:new Date(Date.now()+60000).toISOString(),reason:'Test hold'}));assert.equal(dispatch.selectionFor('pm').seat,null);
 team.applyTeamOverrides({pm:{engine:'perplexity',model:'pplx_asi_kimi_k3',fallbacks:[]}});assert.equal(dispatch.selectionFor('pm').seat,null,'Perplexity cannot bypass an unavailable local Claude relay');
 store.kvSet('provider-hold:claude','null');store.kvSet('provider-hold:codex','null');team.applyTeamOverrides({});
});


test('a real local fixture process produces a durable review with cost and model attribution',async()=>{
 const {ENGINES}=await import('../src/engines/index.js');
 const original=ENGINES.codex.command;
 const fixture=path.join(tmp,'review-cli.mjs');
 fs.writeFileSync(fixture,`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(report()))}}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}));});`);
 ENGINES.codex.command=({cwd})=>({bin:process.execPath,args:[fixture],cwd,env:{}});
 dispatch.setAvailability([{id:'claude',available:false},{id:'codex',available:true,defaultModel:'fixture'}]);
 const t=ticket(),r=review.start(t.key);
 try {
  await review.launch(r,r.members[0],(await import('../src/runner.js')).currentEpoch());
  const actual=review.current(t.key).members[0];
  assert.equal(actual.status,'complete',actual.error);assert.equal(actual.report.verdict,'support');
  assert.equal(actual.model,'codex:fixture');assert.ok(store.getRun(actual.run_id).reserve_usd>0);
  assert.equal(store.getAgentState('pm').status,'idle');
 } finally { ENGINES.codex.command=original; }
});

test('new architecture invalidates a supported plan and schedules a fresh bounded review',()=>{
 const t=ticket(),r=review.start(t.key);for(const m of r.members)finish(r,m.agent_id);
 store.addComment(t.key,'principal-fe','📐 **Design** (Sage)\nA revised architecture with a new data boundary.');
 assert.equal(review.current(t.key).stale,true);
 review.refreshChangedPlans();const fresh=review.current(t.key);
 assert.equal(fresh.revision,r.revision+1);assert.equal(fresh.status,'reviewing');assert.equal(fresh.stale,false);
});

test('a changed queued brief can be revised without waiting for reviewers that cannot launch',()=>{
 const t=ticket(),r=review.start(t.key);
 store.updateTicket(t.key,{description:'Changed while providers were held'});
 review.refreshChangedPlans();assert.equal(review.current(t.key).status,'stale');
 const revised=review.decide(t.key,{revision:r.revision,action:'revise',message:'Review the updated scope'});
 assert.equal(revised.revision,2);assert.equal(revised.stale,false);
});

test('feedback reviewers inspect an isolated clone pinned to the submitted commit',async()=>{
 const runner=await import('../src/runner.js');
 const t=ticket(),worker=runner.workspaceDir(t.key);
 fs.mkdirSync(path.dirname(worker),{recursive:true});execFileSync('git',['clone','-q',repo,worker]);
 fs.writeFileSync(path.join(worker,'submitted.txt'),'Exact submitted feedback evidence');
 execFileSync('git',['-C',worker,'add','.']);execFileSync('git',['-C',worker,'-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','submitted']);
 t.head_sha=execFileSync('git',['-C',worker,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const clone=await runner.ensureProductReviewWorkspace('product-design',t);
 assert.notEqual(clone,worker);assert.notEqual(clone,repo);
 assert.equal(await runner.headSha(clone),t.head_sha);
 assert.equal(fs.readFileSync(path.join(clone,'submitted.txt'),'utf8'),'Exact submitted feedback evidence');
 assert.equal(fs.existsSync(path.join(repo,'submitted.txt')),false);
});

test('an advisory reviewer reports but never blocks: its concern or failure leaves the required verdicts in charge',()=>{
  const t=ticket(); const r=review.start(t.key);
  // Make the trading advisor advisory, as a project's catalog advisors are (the legacy desk keeps it required).
  const raw=JSON.parse(store.kvGet(`product-review:${t.key}:plan`)); raw.members.find(m=>m.agent_id==='trading-advisor').advisory=true; store.kvSet(`product-review:${t.key}:plan`,JSON.stringify(raw));
  for(const m of r.members.filter(m=>m.stage==='review')) finish(r,m.agent_id,m.agent_id==='trading-advisor'?'concern':'support');
  assert.ok(!review.pending().some(x=>x.r.ticket_key===t.key&&x.m.stage==='challenge'),'no challenge round is forced by an advisory concern');
  assert.ok(review.pending().some(x=>x.r.ticket_key===t.key&&x.m.agent_id==='manager'),'synthesis follows');
  finish(r,'manager');
  assert.equal(review.current(t.key).status,'approved');
  assert.match(store.listComments(t.key).map(c=>c.body).join('\n'),/concern/,'the advisory concern is still on the record');
});
