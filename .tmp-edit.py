p = "src/main/website-clone-tools.ts"
s = open(p, encoding="utf-8").read()
def swap(old, new):
    global s
    assert s.count(old) == 1, old[:70]
    s = s.replace(old, new)
swap('''				"Set the emulated CSS viewport of the page bound by browser_navigate. Use 1440x900 desktop, 768x900 tablet, 390x844 mobile.",''',
'''				"Set the emulated CSS viewport of the page bound by browser_navigate. Use 1440x900 desktop, 768x900 tablet, 390x844 mobile. The size holds for every later call, across navigations, until changed. Touch input and (hover: none)/(pointer: coarse) media are not emulated; read those rules from the stylesheets instead.",''')
swap('''				viewportOverride = { width, height, deviceScaleFactor: deviceScaleFactor ?? 1 };
				const measured = await withViewport(guest, { signal }, async () => {
					return (await guest.executeJavaScript(
						"({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
						true,
					)) as { width?: number; height?: number; dpr?: number };
				});
				if (measured?.width !== width || measured?.height !== height) {''',
'''				viewportOverride = { width, height, deviceScaleFactor: deviceScaleFactor ?? 1 };
				// Applied up front even at an unchanged size: the scale factor may differ.
				emulate(guest);
				const measured = await onPage(guest, { signal }, async (viewport) => viewport);
				if (measured?.width !== width || measured?.height !== height) {''')
swap('''					{ type: "text", text: `Viewport verified at ${width}x${height} (dpr ${measured.dpr})` },''',
'''					{
						type: "text",
						text: `Viewport verified at ${width}x${height} (dpr ${Number(measured.dpr?.toFixed(3))})`,
					},''')
swap('''				const result = await withViewport(guest, { signal }, () =>
					guest.executeJavaScript(expression, true),
				);''', '''				const result = await onPage(guest, { signal }, () => guest.executeJavaScript(expression, true));''')
swap('''			const captured = await withViewport(''', '''			const captured = await withDebugger(''')
swap('''				return await withViewport(''', '''				return await onPage(''')
open(p, "w", encoding="utf-8", newline="").write(s)
print("ok")
