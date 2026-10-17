import { describe, expect, test } from 'bun:test';
import type { AgentCell } from '../../../src/shared/agent';
import { predictionTurn,canAcceptPrediction } from '../../../src/renderer/src/lib/promptPrediction';
const user:AgentCell={id:'u',type:'user',text:'介绍项目',timestamp:1};
const answer:Extract<AgentCell,{type:'assistant'}>={id:'a',type:'assistant',text:'这是服务端项目',thinking:'private reasoning',streaming:false,timestamp:2};
describe('next user input prediction',()=>{
 test('extracts only the latest final user and answer pair',()=>{
  expect(predictionTurn({sessionId:'s',cells:[user,answer]})).toEqual({key:JSON.stringify(['s','u','a']),userText:user.text,answerText:answer.text});
  expect(predictionTurn({sessionId:'s',cells:[user,{...answer,streaming:true}]})).toBeNull();
  expect(predictionTurn({sessionId:'s',cells:[user,{...answer,text:''}]})).toBeNull();
  expect(predictionTurn({sessionId:'s',cells:[user,{...answer,error:'aborted'}]})).toBeNull();
  expect(predictionTurn({sessionId:'s',cells:[user,answer,{...user,id:'new'}]})).toBeNull();
 });
 test('session identity scopes suggestions',()=>{
  expect(predictionTurn({sessionId:'one',cells:[user,answer]})?.key).not.toBe(predictionTurn({sessionId:'two',cells:[user,answer]})?.key);
 });
 test('only unmodified Tab outside IME composition accepts a prediction',()=>{
  expect(canAcceptPrediction('Tab',false,false,false,false,false)).toBe(true);
  for(const flags of [[true,false,false,false,false],[false,true,false,false,false],[false,false,true,false,false],[false,false,false,true,false],[false,false,false,false,true]]) expect(canAcceptPrediction('Tab',...flags as [boolean,boolean,boolean,boolean,boolean])).toBe(false);
  expect(canAcceptPrediction('Enter',false,false,false,false,false)).toBe(false);
 });
});
