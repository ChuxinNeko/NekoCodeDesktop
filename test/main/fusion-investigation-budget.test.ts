import { describe, test, expect } from "bun:test";
import { FusionInvestigationBudget } from "../../src/main/fusion-investigation-budget";
describe("inline investigation evidence tracking", () => {
 test("duplicate requests are refused but different decisive ranges remain available", () => {
  const budget = new FusionInvestigationBudget();
  expect(budget.before("read", { path: "a.ts", offset: 1 })).toBeUndefined();
  expect(budget.before("read", { path: "a.ts", offset: 1 })).toContain("already attempted");
  expect(budget.before("read", { path: "a.ts", offset: 40 })).toBeUndefined();
  expect(budget.before("fusion_review", {})).toBeUndefined();
 });
 test("productive investigation continues beyond former call and turn limits with restorable bounded tracking", () => {
  const budget = new FusionInvestigationBudget();
  for (let i=0;i<160;i++) {
   expect(budget.before("read", { path: `a${i}.ts` })).toBeUndefined();
   budget.finish();
  }
  expect(budget.snapshot().seen.length).toBe(128);
  const restored = new FusionInvestigationBudget(); expect(restored.restore(budget.snapshot())).toBe(true);
  expect(restored.before("read", {path:"extra.ts"})).toBeUndefined();
  expect(restored.before("read", {path:"a159.ts"})).toContain("already attempted");
  restored.reset(); expect(restored.before("read", {path:"a159.ts"})).toBeUndefined();
  expect(restored.restore({ attempts: -1, turns: 0, seen: [] })).toBe(false);
 });
});
