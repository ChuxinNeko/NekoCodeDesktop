import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolutionScript } from '../../../src/main/remote-desktop/resolution';
import { RemoteDesktopService } from '../../../src/main/remote-desktop/service';
import { validateDesktopResolution, type DesktopState } from '../../../src/shared/remote-desktop';

const python = Bun.which('python3') ?? Bun.which('python');
function runScript(options: { rdp?: boolean; multiple?: boolean; reject?: boolean; custom?: boolean }, size?: {width:number;height:number}) {
 const mock = `import subprocess,glob,shutil,json,atexit
from types import SimpleNamespace
calls=[]
state=[1024,768]
opts=json.loads(${JSON.stringify(JSON.stringify(options))})
glob.glob=lambda _: []
shutil.which=lambda _: 'cvt'
def run(args,**kwargs):
 assert kwargs['env']['DISPLAY']==':10'
 calls.append(args)
 text='';error='';code=0
 if args[:2]==['xrandr','--current']:
  output='rdp0' if opts.get('rdp') else 'Virtual-1'
  text='Screen 0: minimum 256 x 256, current %d x %d, maximum 8192 x 8192\\n%s connected %dx%d+0+0\\n   1024x768 60.0*\\n' % (state[0],state[1],output,state[0],state[1])
  if not opts.get('custom'): text+='   1280x800 60.0\\n'
  if opts.get('multiple'): text+='Virtual-2 connected 1024x768+1024+0\\n   1024x768 60.0*\\n'
 elif args[0]=='cvt': text='Modeline "1280x800_60" 83.50 1280 1352 1480 1680 800 803 809 831 -hsync +vsync'
 elif '--mode' in args:
  target=args[-1].removeprefix('NEKO_')
  if opts.get('reject') and target!='1024x768': code=1;error='Mode rejected'
  else: state[:]=map(int,target.split('x'))
 return SimpleNamespace(stdout=text,stderr=error,returncode=code)
subprocess.run=run
atexit.register(lambda:print('CALLS='+json.dumps(calls)))
`;
 const result=spawnSync(python!,['-'],{input:mock+'\n'+resolutionScript(':10',size),encoding:'utf8'});
 expect(result.status).toBe(0);
 const lines=result.stdout.split(/\r?\n/);
 return {result:JSON.parse(lines.find(l=>l.startsWith('NEKO_RESOLUTION='))!.slice(16)),calls:JSON.parse(lines.find(l=>l.startsWith('CALLS='))!.slice(6)) as string[][]};
}

describe('remote resolution script',()=>{
 test.skipIf(!python)('reads exact display and existing modes',()=>{
  const {result}=runScript({});expect(result).toEqual({width:1024,height:768,modes:[{width:1024,height:768},{width:1280,height:800}],blockedReason:null});
 });
 test.skipIf(!python)('switches an existing mode without creating a new one',()=>{
  const {result,calls}=runScript({},{width:1280,height:800});expect(result.width).toBe(1280);expect(result.height).toBe(800);expect(calls.some(c=>c.includes('--newmode'))).toBe(false);
 });
 test.skipIf(!python)('creates and attaches a custom mode before applying it',()=>{
  const {result,calls}=runScript({custom:true},{width:1280,height:800});expect(result.error).toBeUndefined();expect(calls.filter(c=>['--newmode','--addmode','--output'].includes(c[1])).map(c=>c[1])).toEqual(['--newmode','--addmode','--output']);
 });
 test.skipIf(!python)('reports a rejected mode and restores the previous mode',()=>{
  const {result,calls}=runScript({reject:true},{width:1280,height:800});expect(result.error).toBe('Mode rejected');expect(calls.at(-1)).toEqual(['xrandr','--output','Virtual-1','--mode','1024x768']);
 });
 test.skipIf(!python)('does not resize an XRDP session or multiple monitors',()=>{
  for(const opts of [{rdp:true},{multiple:true}]){
   const {result,calls}=runScript(opts,{width:1280,height:800});expect(result.error).toBeTruthy();expect(calls).toEqual([['xrandr','--current']]);
  }
 });
});

class FakeDesktop extends RemoteDesktopService {
 current: DesktopState={hostId:'test',hostName:'test',phase:'connected',controller:'user',width:1024,height:768,title:'test',error:null};
 displayValue: string|null=':10';calls=0;fail=false;
 constructor(){super({connect:async()=>{throw Error('unused')},emit:()=>{}});}
 override display(){return this.displayValue;}
 override state(){return this.current;}
 override async run(_host:string,_command:string,input:string){
  this.calls++;
  if(this.fail)return 'NEKO_RESOLUTION={"error":"Mode rejected"}';
  setTimeout(()=>{this.current.width=1280;this.current.height=800;},30);
  return 'NEKO_RESOLUTION='+JSON.stringify({width:1280,height:800,modes:[],blockedReason:null});
 }
}
describe('resolution service',()=>{
 test('validates dimensions before running any SSH command',async()=>{
  const service=new FakeDesktop();for(const value of [NaN,Infinity,255,4097,1280.5]){expect(()=>validateDesktopResolution(value,800)).toThrow();await expect(service.setResolution('test',value,800)).rejects.toThrow();}expect(service.calls).toBe(0);
 });
 test('never guesses a display for an externally configured VNC server',async()=>{
  const service=new FakeDesktop();service.displayValue=null;await expect(service.resolutionInfo('test')).rejects.toThrow('external VNC');expect(service.calls).toBe(0);
 });
 test('surfaces driver rejection without changing the reported desktop size',async()=>{
  const service=new FakeDesktop();service.fail=true;await expect(service.setResolution('test',1280,800)).rejects.toThrow('Mode rejected');expect(service.state().width).toBe(1024);
 });
 test('waits for the VNC resize event and rejects concurrent changes',async()=>{
  const service=new FakeDesktop();const pending=service.setResolution('test',1280,800);await expect(service.setResolution('test',1920,1080)).rejects.toThrow('already in progress');await pending;expect(service.state().width).toBe(1280);
 });
});
