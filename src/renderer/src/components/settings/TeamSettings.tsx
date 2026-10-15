import { useEffect, useRef, useState } from "react";
import type { CodeIntelModelOption } from "../../../../shared/code-intel";
import type { ThinkingLevel } from "../../../../shared/agent";
import { isTeamSettings, TEAM_AVATAR_COLORS, TEAM_AVATAR_SHAPES, TEAM_NAME_PATTERN, teamAvatarOf, type TeamMember, type TeamSettings as Team } from "../../../../shared/team";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { TEAM_AVATAR_FILL, TeamAvatar, TeamAvatarGlyph } from "../team/TeamAvatar";
import { SettingsRow } from "./SettingsRow";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FOLLOW = "__follow__";
const MAX_MEMBERS = 12;

/**
 * Settings → Team: the AI team picked as "Team" in the model menu. Adapted from
 * DS Bot (https://github.com/Fei2411/DeepSeek-Bot, Apache-2.0): each member has a
 * name, role, own instructions and model; one admin coordinates the rest.
 * Edits are kept as a draft and saved only when the whole roster is valid.
 */
export function TeamSettings() {
	const { t } = useTranslation();
	const [team, setTeam] = useState<Team | null>(null);
	const [models, setModels] = useState<CodeIntelModelOption[]>([]);
	const [error, setError] = useState<string | null>(null);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pending = useRef<Team | null>(null);

	useEffect(() => {
		api.preferencesGet().then((preferences) => setTeam(preferences.team)).catch((cause: unknown) => setError(errorMessage(cause)));
		Promise.resolve().then(() => api.codeIntelModels()).then((result) => setModels(result.chat)).catch(() => setModels([]));
		// Leaving the page must not drop the last debounced edit.
		return () => { clearTimeout(saveTimer.current); if (pending.current) void api.preferencesUpdate({ team: pending.current }).catch(() => undefined); };
	}, []);

	const problem = (value: Team): string | null => {
		const names = new Set<string>();
		for (const member of value.members) {
			if (!TEAM_NAME_PATTERN.test(member.name)) return t("team.error.name", { name: member.name || "…" });
			if (member.name.toLowerCase() === "all") return t("team.error.reserved");
			if (names.has(member.name.toLowerCase())) return t("team.error.duplicate", { name: member.name });
			names.add(member.name.toLowerCase());
		}
		return isTeamSettings(value) ? null : t("team.error.invalid");
	};
	const invalid = team ? problem(team) : null;

	const update = (next: Team) => {
		setTeam(next);
		clearTimeout(saveTimer.current);
		pending.current = null;
		if (problem(next)) return;
		pending.current = next;
		// Debounced: typing instructions should not write the file per keystroke.
		saveTimer.current = setTimeout(() => {
			pending.current = null;
			api.preferencesUpdate({ team: next }).then(() => setError(null)).catch((cause: unknown) => setError(errorMessage(cause)));
		}, 400);
	};
	const patchMember = (id: string, patch: Partial<TeamMember>) => {
		if (team) update({ ...team, members: team.members.map((member) => (member.id === id ? { ...member, ...patch } : member)) });
	};
	const addMember = () => {
		if (!team || team.members.length >= MAX_MEMBERS) return;
		let n = team.members.length + 1;
		while (team.members.some((member) => member.name.toLowerCase() === `member${n}`)) n++;
		const member: TeamMember = { id: `m-${Date.now().toString(36)}`, name: `Member${n}`, role: "", instructions: "",
			modelKey: "", thinkingLevel: "low", access: "full" };
		update({ ...team, members: [...team.members, member], adminId: team.members.length ? team.adminId : member.id });
	};
	const removeMember = (id: string) => {
		if (!team) return;
		const members = team.members.filter((member) => member.id !== id);
		update({ ...team, members, adminId: team.adminId === id ? members[0]?.id ?? "" : team.adminId });
	};
	const modelLabel = (key: string) => (key ? models.find((model) => model.key === key)?.label ?? `${key} · ${t("team.modelMissing")}` : t("team.followChatModel"));

	if (!team) return error ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span> : null;
	const admin = team.members.find((member) => member.id === team.adminId);
	return (
		<section className="flex flex-col gap-3">
			<p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("team.description")}</p>
			<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)]">
				<SettingsRow label={t("team.adminLabel")} hint={t("team.adminHint")}>
					<Select value={team.adminId} onValueChange={(adminId) => { if (adminId) update({ ...team, adminId }); }}>
						<SelectTrigger size="sm" className="w-52"><SelectValue>{admin ? `@${admin.name}` : "—"}</SelectValue></SelectTrigger>
						<SelectPopup surface="settings">
							{team.members.map((member) => <SelectItem key={member.id} value={member.id}>@{member.name}</SelectItem>)}
						</SelectPopup>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("team.parallel")} hint={t("team.parallelHint")}>
					<Switch checked={team.parallel} onCheckedChange={(parallel: boolean) => update({ ...team, parallel })} />
				</SettingsRow>
				<SettingsRow label={t("team.peerDelegation")} hint={t("team.peerDelegationHint")}>
					<Switch checked={team.peerDelegation} onCheckedChange={(peerDelegation: boolean) => update({ ...team, peerDelegation })} />
				</SettingsRow>
				<SettingsRow label={t("team.maxAssignments")} hint={t("team.maxAssignmentsHint")}>
					<Input className="w-20" type="number" min={1} max={50} value={team.maxAssignments}
						onChange={(event) => {
							const value = Math.round(Number(event.target.value));
							if (Number.isFinite(value)) update({ ...team, maxAssignments: Math.min(50, Math.max(1, value)) });
						}} />
				</SettingsRow>
			</div>

			<div className="flex items-center justify-between">
				<span className="text-[length:var(--app-font-size-ui,12px)] font-medium">{t("team.members", { count: team.members.length })}</span>
				<Button size="xs" variant="outline" disabled={team.members.length >= MAX_MEMBERS} onClick={addMember}>{t("team.addMember")}</Button>
			</div>
			{team.members.map((member) => (
				<div key={member.id} className="flex flex-col gap-2 rounded-lg border border-[color:var(--app-surface-divider)] p-3">
					<div className="flex items-center gap-2">
						<TeamAvatar member={member} size={28} />
						<span className="text-muted-foreground">@</span>
						<Input className="w-36" aria-label={t("team.name")} placeholder={t("team.name")} value={member.name}
							onChange={(event) => patchMember(member.id, { name: event.target.value.trim() })} />
						<Input className="min-w-0 flex-1" aria-label={t("team.role")} placeholder={t("team.rolePlaceholder")} value={member.role} maxLength={60}
							onChange={(event) => patchMember(member.id, { role: event.target.value })} />
						{member.id === team.adminId ? <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("team.admin")}</span> : null}
						<Button size="xs" variant="ghost" disabled={team.members.length <= 1} onClick={() => removeMember(member.id)}>{t("team.remove")}</Button>
					</div>
					<Textarea size="sm" aria-label={t("team.instructions")} placeholder={t("team.instructionsPlaceholder")} value={member.instructions} maxLength={8000}
						onChange={(event) => patchMember(member.id, { instructions: event.target.value })} />
					<div className="flex flex-wrap items-center gap-2">
						<Select value={member.modelKey || FOLLOW} onValueChange={(key) => { if (key) patchMember(member.id, { modelKey: key === FOLLOW ? "" : key }); }}>
							<SelectTrigger size="sm" className="w-60 min-w-0" aria-label={t("team.model")}><SelectValue>{modelLabel(member.modelKey)}</SelectValue></SelectTrigger>
							<SelectPopup surface="settings">
								<SelectItem value={FOLLOW}>{t("team.followChatModel")}</SelectItem>
								{models.map((model) => <SelectItem key={model.key} value={model.key}>{model.label}</SelectItem>)}
							</SelectPopup>
						</Select>
						<Select value={member.thinkingLevel} onValueChange={(level) => { if (level) patchMember(member.id, { thinkingLevel: level as ThinkingLevel }); }}>
							<SelectTrigger size="sm" className="w-28" aria-label={t("picker.thinking")}><SelectValue /></SelectTrigger>
							<SelectPopup surface="settings">{LEVELS.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectPopup>
						</Select>
						<Select value={member.access} onValueChange={(access) => { if (access) patchMember(member.id, { access: access as TeamMember["access"] }); }}>
							<SelectTrigger size="sm" className="w-32" aria-label={t("team.access")}>
								<SelectValue>{member.access === "read-only" ? t("team.readOnly") : t("team.fullAccess")}</SelectValue>
							</SelectTrigger>
							<SelectPopup surface="settings">
								<SelectItem value="full">{t("team.fullAccess")}</SelectItem>
								<SelectItem value="read-only">{t("team.readOnly")}</SelectItem>
							</SelectPopup>
						</Select>
					</div>
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
						<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("team.avatar")}</span>
						<div className="flex items-center gap-1.5" role="radiogroup" aria-label={t("team.avatarShape")}>
							{TEAM_AVATAR_SHAPES.map((shape) => {
								const current = teamAvatarOf(member);
								const selected = current.shape === shape;
								return (
									<button key={shape} type="button" role="radio" aria-checked={selected} title={shape}
										className={selected ? "rounded-md ring-2 ring-foreground/60 ring-offset-1 ring-offset-background" : "rounded-md opacity-45 hover:opacity-90"}
										onClick={() => patchMember(member.id, { avatar: { ...current, shape } })}>
										<TeamAvatarGlyph avatar={{ ...current, shape }} size={20} blink={false} />
									</button>
								);
							})}
						</div>
						<div className="flex items-center gap-1.5" role="radiogroup" aria-label={t("team.avatarColor")}>
							{TEAM_AVATAR_COLORS.map((color) => {
								const current = teamAvatarOf(member);
								const selected = current.color === color;
								return (
									<button key={color} type="button" role="radio" aria-checked={selected} title={color}
										className={selected ? "size-4 rounded-full ring-2 ring-foreground/60 ring-offset-1 ring-offset-background" : "size-4 rounded-full opacity-60 hover:opacity-100"}
										style={{ background: TEAM_AVATAR_FILL[color] }}
										onClick={() => patchMember(member.id, { avatar: { ...current, color } })} />
								);
							})}
						</div>
					</div>
				</div>
			))}
			{invalid ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--warning)]">{invalid}</span> : null}
			{error ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span> : null}
			<p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("team.usageHint")}</p>
		</section>
	);
}
