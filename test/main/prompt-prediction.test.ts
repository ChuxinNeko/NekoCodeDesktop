import { describe, expect, test } from 'bun:test';
import { PromptPredictionService, cleanPrediction } from '../../src/main/prompt-prediction';
import type { ModelCallRuntime } from '../../src/main/model-call';
const request={id:'r',userText:'帮我了解项目',answerText:'项目是一个 API 服务，入口 server.mjs。',language:'zh-CN' as const};
function setup(answer: (prompt:string,signal?:AbortSignal)=>Promise<string>) {
 let settings={enabled:true,modelKey:'p/fast' as string|null};
 const calls:string[]=[];
 const runtime={getModel:()=>({provider:'p',id:'fast',maxTokens:4096}),getAvailable:async()=>[],completeSimple:async (_m:unknown,c:{messages:{content:string}[]},o:{signal?:AbortSignal})=>{calls.push(c.messages[0].content);return {content:[{type:'text',text:await answer(c.messages[0].content,o.signal)}],stopReason:'stop'};}} as unknown as ModelCallRuntime;
 const service=new PromptPredictionService({settings:()=>settings,getRuntime:async()=>runtime});
 return {service,calls,set:(next:typeof settings)=>{settings=next;}};
}
describe('prompt prediction',()=>{
 test('uses a bounded exchange and produces only a suggestion',async()=>{
  const {service,calls}=setup(async()=> '“帮我梳理请求处理流程”');
  expect(await service.predict(request)).toEqual({text:'帮我梳理请求处理流程'});
  expect(JSON.parse(calls[0])).toEqual({language:'zh-CN',user:request.userText,assistant:request.answerText});
 });
 test('does not call a model when disabled, unconfigured, or without a final answer',async()=>{
  const {service,calls,set}=setup(async()=> 'anything');
  set({enabled:false,modelKey:'p/fast'});expect((await service.predict(request)).text).toBe('');
  set({enabled:true,modelKey:null});expect((await service.predict(request)).text).toBe('');
  set({enabled:true,modelKey:'p/fast'});expect((await service.predict({...request,answerText:''})).text).toBe('');
  expect(calls).toHaveLength(0);
 });
 test('clips context and rejects multiline, fenced or oversized replies',async()=>{
  const {service,calls}=setup(async()=> '第一条\n第二条');
  expect((await service.predict({...request,userText:'u'.repeat(9000),answerText:'a'.repeat(20000)})).text).toBe('');
  const prompt=JSON.parse(calls[0]);expect(prompt.user.length).toBe(3000);expect(prompt.assistant.length).toBe(8000);
  expect(cleanPrediction('```text\nhello\n```')).toBe('');expect(cleanPrediction('a'.repeat(241))).toBe('');
 });
 test('a cancelled request cannot publish a stale suggestion',async()=>{
  let release!:(value:string)=>void;let started!:()=>void;
  const ready=new Promise<void>(r=>{started=r;});
  const {service}=setup(async()=>{started();return new Promise<string>(r=>{release=r;});});
  const pending=service.predict(request);await ready;service.cancel(request.id);release('继续分析');
  expect(await pending).toEqual({text:''});
 });
 test('settings changes suppress an in-flight result and failures stay quiet',async()=>{
  const {service,set}=setup(async()=>{set({enabled:false,modelKey:'p/fast'});return '继续';});
  expect((await service.predict(request)).text).toBe('');
  expect((await setup(async()=>{throw new Error('offline');}).service.predict(request)).text).toBe('');
 });
});
