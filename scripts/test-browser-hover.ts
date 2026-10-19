// Run with: bun scripts/test-browser-hover.ts
// Uses real Electron input against CSS-only menus; no display interaction is required.
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "nekocode-hover-test-"));
const entry = join(directory, "probe.cjs");
const inputPath = resolve(import.meta.dir, "../src/main/browser-input.ts");
try {
	await build({
		stdin: { contents: `
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { performBrowserInput } from ${JSON.stringify(inputPath)};
mkdirSync(join(process.argv[2], "profile"), { recursive: true });
app.setPath("userData", join(process.argv[2], "profile"));
app.whenReady().then(async () => {
 const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { offscreen: true } });
 const page = win.webContents;
 const cases = [
  { name: "wide submenu via selector", wide: true },
  { name: "wide submenu via coordinates", wide: true, coordinates: true },
  { name: "hover submenu item then click", wide: true, hoverItem: true },
  { name: "small CSS menu gap", gap: 6 },
  { name: "visible menu must not scroll", top: 480 },
  { name: "offscreen trigger scrolls only as needed", top: 1100 },
  { name: "menu inside a nested scroll container", top: 480, nested: true },
  { name: "emulated mobile viewport", wide: true, mobile: true },
 ];
 try {
  for (const scenario of cases) {

   await win.loadURL("data:text/html," + encodeURIComponent(
    '<!doctype html><style>body{margin:0;height:3000px}.scroller{height:280px;overflow:auto}.menu{position:relative;margin-left:24px;margin-top:' + (scenario.top ?? 80) + 'px;width:120px}.trigger{width:120px;height:48px}.items{display:none;position:absolute;left:0;top:calc(100% + ' + (scenario.gap ?? 0) + 'px);width:320px;background:skyblue}.menu:hover .items{display:block}.items button{width:120px;height:48px;margin-left:' + (scenario.wide ? 180 : 0) + 'px}</style>' + (scenario.nested ? '<div class="scroller">' : '') + '<div class="menu"><button class="trigger">Menu</button><div class="items"><button id="docs">开发文档</button></div></div>' + (scenario.nested ? '</div>' : '') + '<script>window.clicks=0;window.trusted=false;window.leaves=0;document.querySelector(".menu").addEventListener("mouseleave",()=>leaves++);docs.addEventListener("click",e=>{clicks++;trusted=e.isTrusted})</script>'
   ));
   if (scenario.mobile) {
    page.enableDeviceEmulation({ screenPosition: "desktop", screenSize: { width: 390, height: 844 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 2, scale: 1 });
    for (let i = 0; i < 20; i++) {
     if (await page.executeJavaScript("innerWidth") === 390) break;
     await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await page.executeJavaScript("innerWidth"), 390);
   }
   const run = action => performBrowserInput(page, action, { signal: new AbortController().signal, onPointer: () => {} });
   await run({ action: "hover", selector: ".trigger" });
   assert.equal(await page.executeJavaScript('getComputedStyle(document.querySelector(".items")).display'), "block", scenario.name);
   const before = await page.executeJavaScript("({ leaves, y: scrollY })");
   if (scenario.hoverItem) await run({ action: "hover", selector: "#docs" });
   if (scenario.coordinates) {
    const point = await page.executeJavaScript("(()=>{const r=docs.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await run({ action: "click", ...point });
   } else await run({ action: "click", selector: "#docs" });
   const result = await page.executeJavaScript("({ clicks, trusted, leaves, y: scrollY })");
   assert.equal(result.clicks, 1, scenario.name + ": click must actually reach menu item");
   assert.equal(result.trusted, true, scenario.name + ": native event required");
   assert.equal(result.leaves, before.leaves, scenario.name + ": pointer must stay inside menu");
   if ((scenario.top ?? 80) < 1000) assert.equal(result.y, before.y, scenario.name + ": no unnecessary scroll");
   console.log("PASS " + scenario.name);
  }
  win.destroy(); app.exit(0);
 } catch (error) { console.error(error); win.destroy(); app.exit(1); }
});`, resolveDir: import.meta.dir, loader: "ts" },
		bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: entry,
	});
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const executable = require("electron") as string;
	await new Promise<void>((resolve, reject) => {
		// Keep the Electron launcher on the same Node runtime used by desktop tooling.
		const launcher = `const {spawnSync}=require('node:child_process');
const result=spawnSync(process.argv[1],process.argv.slice(2),{env:process.env,windowsHide:true,encoding:'utf8',timeout:25000});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');
if(result.error)console.error(result.error.message);process.exit(result.status??1);`;
		const child = spawn("node", ["-e", launcher, executable, entry, directory], { env, windowsHide: true, stdio: "inherit" });
		const timer = setTimeout(() => { child.kill(); reject(new Error("Electron hover test timed out")); }, 30_000);
		child.on("error", error => { clearTimeout(timer); reject(error); });
		child.on("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Electron hover test exited ${code}`)); });
	});
} finally {
	const path = relative(tmpdir(), directory);
	if (!path.startsWith("..") && !isAbsolute(path)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}


