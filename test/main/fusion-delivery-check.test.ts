import { test, expect } from "bun:test";
import { fusionDeliveryChecks, canRequestForDelivery } from "../../src/main/fusion-delivery-check";
test("correct files alone do not prove Fusion delivery; Lead must read after report and finish", () => {
 const implementation = {role:"toolResult",toolName:"fusion_implement",isError:false};
 const report = {role:"toolResult",toolName:"fusion_review",isError:false};
 const read = {role:"assistant",model:"lead",stopReason:"toolUse",content:[{type:"toolCall",name:"read"}]};
 const final = {role:"assistant",model:"lead",stopReason:"stop",content:[{type:"text",text:"Reviewed, checks skipped"}]};
 expect(fusionDeliveryChecks([report],"lead",true).leadFinalAnswer).toBe(false);
 expect(fusionDeliveryChecks([read,report,final],"lead",true).leadReviewedSource).toBe(false);
 expect(Object.values(fusionDeliveryChecks([implementation,report,read,final],"lead",true)).every(Boolean)).toBe(true);
 expect(fusionDeliveryChecks([report,read,{...final,stopReason:"error"}],"lead",true).leadFinalAnswer).toBe(false);
});
test("reserved requests allow only Lead acceptance, never Sidekick or a new work loop", () => {
 expect(canRequestForDelivery(31,"side","lead",true,32)).toBe(true);
 expect(canRequestForDelivery(32,"side","lead",true,32)).toBe(false);
 expect(canRequestForDelivery(32,"lead","lead",true,32,6,true)).toBe(true);
 expect(canRequestForDelivery(32,"lead","lead",true,32,6,false)).toBe(false);
 expect(canRequestForDelivery(38,"lead","lead",true,32)).toBe(false);
 expect(canRequestForDelivery(32,"lead","lead",false,32)).toBe(false);
});
