export const files: Record<string, string> = {
 "types.ts": `export type Item = { sku: string; price: number; quantity: number; discount?: number };
export type Coupon = { kind: 'fixed' | 'percent'; value: number; minimum?: number };
export type Options = { coupon?: Coupon; taxRate?: number; shipping?: number; freeShippingAt?: number };
export type Quote = { subtotal: number; discount: number; taxable: number; tax: number; shipping: number; total: number };
`,
 "money.ts": `export function cents(value: number): number { return Math.floor(value * 100); }
export function amount(value: number): number { return value / 100; }
`,
 "items.ts": `import type { Item } from './types';
export function validate(items: Item[]): void { }
export function subtotal(items: Item[]): number { return items.reduce((s, i) => s + i.price * i.quantity, 0); }
`,
 "coupon.ts": `import type { Coupon } from './types';
export function discount(subtotal: number, coupon?: Coupon): number { if (!coupon) return 0; return coupon.value; }
`,
 "shipping.ts": `export function shipping(subtotal: number, base = 0, freeAt?: number): number { return base; }
`,
 "quote.ts": `import type { Item, Options, Quote } from './types';
import { validate, subtotal } from './items';
import { discount } from './coupon';
import { shipping } from './shipping';
export function quote(items: Item[], options: Options = {}): Quote {
 validate(items); const sub = subtotal(items), off = discount(sub, options.coupon);
 const taxable = sub + off, tax = taxable * (options.taxRate ?? 0), ship = shipping(sub, options.shipping, options.freeShippingAt);
 return {subtotal: sub, discount: off, taxable, tax, shipping: ship, total: taxable + tax - ship};
}
`,
 "batch.ts": `import type { Item, Options, Quote } from './types';
import { quote } from './quote';
export function quotes(orders: {items: Item[]; options?: Options}[]): ({ok: true; quote: Quote} | {ok: false; error: string})[] {
 return orders.map(order => ({ok: true as const, quote: quote(order.items, order.options)}));
}
`,
 "index.ts": `export { quote } from './quote'; export { quotes } from './batch'; export type { Item, Options, Quote, Coupon } from './types';\n`,
};
export const task = `实际修复此8模块TypeScript订单报价库，不只是建议。先调查真实代码，决定方案再实施，最终核对文件。不得使用子代理、shell、测试、构建、浏览器、外部依赖，不提交；检查设为skip。只修改这些ts文件，保留所有已有导出和函数签名。
规则：所有金额运算用整数分，cents为Math.round(value*100)，输出转回元。商品price必须有限且>=0，quantity必须非负整数，discount缺省0且有限范围[0,1]，sku为非空字符串，非法均抛Error。每行金额四舍五入到分再相加。coupon.minimum以折后商品subtotal判定；未达门槛不优惠，fixed按元、percent为0..1比例，优惠四舍五入到分且不得超subtotal。非法coupon金额/比例/minimum抛Error。taxable=subtotal-discount，tax按taxable*taxRate四舍五入到分，taxRate须有限[0,1]。shipping是非负有限元；freeShippingAt是非负有限元，以优惠前subtotal>=门槛免运费（含相等）；空订单运费为0。total=taxable+tax+shipping。缺省options各值为0。batch逐项隔离错误，结果保持顺序，错误项ok:false,error非空，正常项ok:true,quote。不修改输入对象/数组。一次汇总相关修改，不反复交接。
验收场景：100*2带25%商品折扣，fixed20，税10%，运费10→subtotal150,discount20,taxable130,tax13,shipping10,total153；percent20%且minimum200时subtotal150不优惠；subtotal150且freeShippingAt150免运费；0.1*3加0.2*1=0.5；空订单total0；无效商品/选项抛错；batch有效、无效、有效三个订单仅中间失败。`;
export async function verify(cwd: string): Promise<Record<string, boolean>> {
 const { quote, quotes } = await import(cwd + '/index.ts'); const { cents } = await import(cwd + '/money.ts');
 const item = {sku:'a',price:100,quantity:2,discount:0.25}; const input = [item]; const original = JSON.stringify(input);
 const a=quote(input,{coupon:{kind:'fixed',value:20},taxRate:0.1,shipping:10});
 const throws=(fn:()=>unknown)=>{try{fn();return false;}catch{return true;}};
 const invalid=[{...item,price:-1},{...item,price:NaN},{...item,quantity:1.5},{...item,discount:1.1},{...item,sku:''}];
 const badOptions=[{taxRate:-1},{taxRate:Infinity},{shipping:-1},{freeShippingAt:-1},{coupon:{kind:'percent',value:1.2}},{coupon:{kind:'fixed',value:-1}},{coupon:{kind:'fixed',value:1,minimum:-1}}];
 const batch=quotes([{items:input},{items:[{...item,price:-1}]},{items:[]}]);
 return { cents:cents(1.235)===124, fullQuote:JSON.stringify(a)===JSON.stringify({subtotal:150,discount:20,taxable:130,tax:13,shipping:10,total:153}),
 threshold:quote(input,{coupon:{kind:'percent',value:0.2,minimum:200}}).discount===0,
 percentage:quote(input,{coupon:{kind:'percent',value:0.2}}).discount===30,
 cap:quote(input,{coupon:{kind:'fixed',value:999}}).total===0,
 freeShipping:quote(input,{shipping:10,freeShippingAt:150}).shipping===0,
 decimals:quote([{sku:'b',price:0.1,quantity:3},{sku:'c',price:0.2,quantity:1}]).total===0.5,
 empty:quote([],{shipping:10}).total===0, invalidItems:invalid.every(i=>throws(()=>quote([i]))),
 invalidOptions:badOptions.every(o=>throws(()=>quote(input,o))),
 batch:batch.length===3&&batch[0].ok===true&&batch[1].ok===false&&!!batch[1].error&&batch[2].ok===true,
 immutable:JSON.stringify(input)===original };
}
