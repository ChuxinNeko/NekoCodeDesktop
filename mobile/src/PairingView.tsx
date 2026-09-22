import { useState } from "react";
import type { RelayDeviceSummary } from "../../src/shared/relay";
import { Button } from "../../src/renderer/src/components/ui/button";
import { Input } from "../../src/renderer/src/components/ui/input";
import { CameraIcon } from "../../src/renderer/src/lib/icons";
import { PublicConnectionView } from "./PublicConnectionView";
import { scanPairingCode } from "./pairing-scanner";

const MODES = [
	{ id: "scan", label: "扫码配对" },
	{ id: "manual", label: "手动配置" },
	{ id: "account", label: "公网连接" },
] as const;

export function PairingView({ initialEndpoint, busy, error, onPair, onPublicConnect, onError }: {
	initialEndpoint: string;
	busy: boolean;
	error: string | null;
	onPair: (endpoint: string, code: string, name: string) => Promise<void>;
	onPublicConnect: (device: RelayDeviceSummary) => Promise<void>;
	onError: (error: string | null) => void;
}) {
	const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("scan");
	const [endpoint, setEndpoint] = useState(initialEndpoint);
	const [code, setCode] = useState("");
	const [name, setName] = useState("我的手机");
	const [scanning, setScanning] = useState(false);
	const disabled = busy || scanning;
	const scan = async () => {
		if (disabled) return;
		setScanning(true); onError(null);
		try {
			const pairing = await scanPairingCode();
			if (!pairing) return;
			setEndpoint(pairing.endpoint); setCode(pairing.code);
			await onPair(pairing.endpoint, pairing.code, name.trim() || "我的手机");
		} catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setScanning(false); }
	};
	return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-8">
		<div className="mb-10"><h1 className="text-xl font-semibold">NekoCode</h1><p className="mt-2 text-sm text-muted-foreground">连接桌面，继续你的任务</p></div>
		<div className="flex w-full max-w-md flex-col gap-5 self-center">
			<div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="配对方式">
				{MODES.map((entry) => <button key={entry.id} role="tab" id={`pair-${entry.id}-tab`} aria-selected={mode === entry.id} aria-controls={`pair-${entry.id}-panel`} disabled={disabled} onClick={() => { setMode(entry.id); onError(null); }} className={`min-h-10 flex-1 rounded-md px-2 text-sm transition-colors ${mode === entry.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>{entry.label}</button>)}
			</div>
			{mode === "account" ? <section id="pair-account-panel" role="tabpanel" aria-labelledby="pair-account-tab">
				<PublicConnectionView busy={busy} onConnect={onPublicConnect} />
			</section> : null}
			{mode === "account" ? null : mode === "scan" ? <section id="pair-scan-panel" role="tabpanel" aria-labelledby="pair-scan-tab" className="flex flex-col gap-5">
				<div className="flex flex-col items-center gap-4 rounded-xl border border-border px-5 py-8 text-center">
					<div className="flex size-20 items-center justify-center rounded-2xl bg-muted"><CameraIcon className="size-9 text-foreground/80" /></div>
					<div><h2 className="text-base font-medium">扫描电脑二维码</h2><p className="mt-2 text-sm leading-relaxed text-muted-foreground">在电脑「设置 → 手机连接」开启访问，<br />扫描二维码即可自动配置并绑定。</p></div>
				</div>
				<Button disabled={disabled} className="h-12 gap-2" onClick={() => { void scan(); }}><CameraIcon className="size-4" />{busy ? "正在绑定…" : scanning ? "正在扫码…" : "扫一扫，连接电脑"}</Button>
			</section> : <form id="pair-manual-panel" role="tabpanel" aria-labelledby="pair-manual-tab" className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); if (!disabled) void onPair(endpoint.trim(), code.trim(), name.trim() || "我的手机"); }}>
				<label className="flex flex-col gap-2 text-sm">电脑地址<Input className="h-11 text-base" autoCapitalize="none" autoCorrect="off" placeholder="192.168.1.8:47832" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} disabled={disabled} required /></label>
				<label className="flex flex-col gap-2 text-sm">配对码<Input className="h-11 font-mono text-base tracking-widest" autoCapitalize="characters" autoCorrect="off" maxLength={10} placeholder="电脑显示的 10 位配对码" value={code} onChange={(e) => setCode(e.target.value)} disabled={disabled} required /></label>
				<Button type="submit" disabled={disabled} className="h-11">{busy ? "正在连接…" : "绑定电脑"}</Button>
			</form>}
			{/* The phone's name, the LAN error and the LAN hint all belong to the
			    two pairing tabs; the account tab has its own errors and its own
			    story, and showing "两台设备需在同一局域网" under a sign-in form
			    would be describing something else entirely. */}
			{mode === "account" ? null : <>
				<label className="flex flex-col gap-2 text-sm">手机名称<Input className="h-11 text-base" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} /></label>
				{error && <p role="alert" className="text-sm leading-relaxed text-destructive">{error}</p>}
				<p className="text-xs leading-relaxed text-muted-foreground">手机和电脑需要连接同一局域网。二维码 5 分钟内有效，使用一次即失效。也可以切换到手动配置，输入电脑地址和配对码。</p>
			</>}
		</div>
	</div>;
}
