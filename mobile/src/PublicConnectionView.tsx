import { useEffect, useState } from "react";
import type { RelayDeviceSummary } from "../../src/shared/relay";
import { Button } from "../../src/renderer/src/components/ui/button";
import { Spinner } from "../../src/renderer/src/components/ui/spinner";
import { account } from "./account-client";
import { AccountView } from "./AccountView";
import { relay } from "./relay-client";

export function PublicConnectionView({ busy, activeDesktopId, onConnect, onSignedOut }: {
	busy: boolean;
	activeDesktopId?: string;
	onConnect: (device: RelayDeviceSummary) => Promise<void>;
	onSignedOut?: () => void;
}) {
	const [signedIn, setSignedIn] = useState<boolean | null>(null);
	const [devices, setDevices] = useState<RelayDeviceSummary[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [leaving, setLeaving] = useState(false);

	const load = async () => {
		if (loading) return;
		setLoading(true);
		setError(null);
		try {
			setDevices(await relay.listDevices());
		} catch (cause) {
			setDevices(null);
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void account.restore().then((ok) => {
			setSignedIn(ok);
			if (ok) void load();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const logout = async () => {
		if (leaving) return;
		setLeaving(true);
		setError(null);
		try {
			await relay.disconnect();
			await account.logout();
			setSignedIn(false);
			setDevices(null);
			onSignedOut?.();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLeaving(false);
		}
	};

	if (signedIn === null) {
		return <div className="flex items-center justify-center py-10"><Spinner /></div>;
	}
	if (!signedIn) {
		return <AccountView onSignedIn={() => { setSignedIn(true); void load(); }} />;
	}
	return <section className="flex flex-col gap-5">
		<div className="rounded-xl border border-border px-5 py-4">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm text-muted-foreground">已登录</p>
					<p className="mt-1 break-all text-base">{account.email}</p>
				</div>
				<Button variant="subtle" size="sm" disabled={loading || leaving} onClick={() => void load()}>{loading ? "刷新中…" : "刷新"}</Button>
			</div>
		</div>
		<div className="flex flex-col gap-2">
			<h2 className="text-sm font-medium">选择要连接的电脑</h2>
			{devices === null ? (
				<p className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">{loading ? "正在获取设备列表…" : "暂时无法获取设备列表"}</p>
			) : devices.length === 0 ? (
				<p className="rounded-lg bg-muted p-4 text-sm leading-relaxed text-muted-foreground">
					还没有可连接的电脑。请先在电脑「设置 → 连接 → 连接至APP」里用同一个 NekoCode 账号登录公网连接。
				</p>
			) : devices.map((device) => (
				<div key={device.id} className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
					<span className={`size-2 shrink-0 rounded-full ${device.online ? "bg-success" : "bg-muted-foreground/40"}`} />
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm font-medium">{device.name}</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{device.online ? "在线" : "离线"} · 最近在线 {new Date(device.lastSeenAt).toLocaleString()}
							{device.id === activeDesktopId ? " · 当前连接" : ""}
						</p>
					</div>
					<Button size="sm" disabled={!device.online || busy} onClick={() => { setError(null); void onConnect(device).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }}>
						连接
					</Button>
				</div>
			))}
		</div>
		{error && <p role="alert" className="text-sm leading-relaxed text-destructive">{error}</p>}
		<p className="text-xs leading-relaxed text-muted-foreground">
			公网连接与局域网配对相互独立，不要求两台设备在同一网络。消息使用端到端加密，服务器正常情况下只转发密文；但设备公钥由账号服务分发，若服务器主动替换公钥仍可能发起中间人攻击。
		</p>
		<Button variant="subtle" className="h-11" disabled={leaving || busy} onClick={() => void logout()}>
			{leaving ? "正在退出…" : "退出登录"}
		</Button>
	</section>;
}
