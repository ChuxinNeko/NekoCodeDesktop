import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LanService } from '../../src/main/lan-service';
import { SnapshotDeltaCache } from '../../src/shared/agent-delta';
import type { TaskManager } from '../../src/main/task-manager';
import type { AcpService } from '../../src/main/acp/service';
import type { AgentSnapshot } from '../../src/shared/agent';

// Real production HTTP/auth/validation/dedup/delta routes; deterministic Agent
// and ACP adapters avoid spending tokens or launching the user's real agents.
const dir = mkdtempSync(join(tmpdir(), 'nekocode-flutter-integration-'));
const cache = new SnapshotDeltaCache('flutter');
const snapshot = {session:{id:'task-1',title:'Desktop task',cwd:dir,sessionFile:'private'},cells:[{id:'c1',type:'user',text:'初始消息',timestamp:1}],models:[],checkpoints:[{id:'checkpoint-1',cellId:'c1',files:[{path:'lib/main.dart',additions:1,deletions:1}],fileCount:1,additions:1,deletions:1}],workflow:{request:null,todos:[],tasks:[]},mode:'auto',thinkingLevel:'off',streaming:false} as unknown as AgentSnapshot;
const agent = {
  getSnapshot:()=>snapshot,
  listCheckpoints:()=>snapshot.checkpoints,
  checkpointFileDiff:async()=>({path:'lib/main.dart',patch:'--- a/lib/main.dart\n+++ b/lib/main.dart\n@@ -1 +1 @@\n-old\n+new\n',binary:false}),
  send:async ({text}:{text:string})=>{snapshot.cells.push({id:`c${snapshot.cells.length+1}`,type:'user',text,timestamp:Date.now()});return {accepted:true};},
  setMode:(value:string)=>{snapshot.mode=value as AgentSnapshot['mode'];},
  setThinkingLevel:async(value:string)=>{snapshot.thinkingLevel=value as AgentSnapshot['thinkingLevel'];},
  abort:async()=>{snapshot.streaming=false;},
  snapshotDelta:({since}:{since?:string}={})=>cache.next(snapshot,since),
  slashCommands:async()=>[{name:'help'},{name:'terminal'}],
};
const tasks = {list:async()=>[{...snapshot.session,running:false}], defaults:async()=>({mode:'auto',models:[]}),create:async()=>agent,byId:async()=>agent} as unknown as TaskManager;
const acpView = {id:'acp-1',agentId:'codex',cwd:dir,cells:[] as unknown[],permissions:[{id:'permission-1',options:[{optionId:'allow'}]}],status:'ready',configOptions:[]};
const acp = {state:()=>({agents:[{id:'codex',name:'Codex',enabled:true,env:{}}],sessions:[]}), agents:()=>[{id:'codex',enabled:true}],view:()=>acpView,create:()=>acpView,prompt:async({text}:{text:string})=>{acpView.cells.push({id:'a1',type:'user',text});},setConfig:async()=>{},respondPermission:()=>{},cancel:async()=>{}} as unknown as AcpService;
const service = new LanService(dir,tasks); service.setAcpProvider(()=>acp);
try {
  await service.start(0); service.addProject(dir);
  const server = (service as unknown as {server:{address():{port:number}}}).server;
  const sdk = process.env.FLUTTER_SDK ?? join(process.env.HOME!,'.local/share/nekocode/flutter-3.47.7');
  const child = Bun.spawn([join(sdk,'bin/flutter'),'test','test/desktop_integration_test.dart','--no-pub','--reporter','expanded'],{
    cwd:resolve(import.meta.dir,'..'),stdout:'inherit',stderr:'inherit',
    env:{...process.env,FLUTTER_STORAGE_BASE_URL:process.env.FLUTTER_STORAGE_BASE_URL??'https://storage.flutter-io.cn',PUB_HOSTED_URL:process.env.PUB_HOSTED_URL??'https://pub.flutter-io.cn',NEKOCODE_TEST_ENDPOINT:`http://127.0.0.1:${server.address().port}`,NEKOCODE_TEST_CODE:service.status().pairing!.code},
  });
  process.exitCode = await child.exited;
} finally { await service.stop(); rmSync(dir,{recursive:true,force:true}); }
