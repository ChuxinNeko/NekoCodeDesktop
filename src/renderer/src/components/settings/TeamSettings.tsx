import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";
import type { CodeIntelModelOption } from "../../../../shared/code-intel";
import type { ThinkingLevel } from "../../../../shared/agent";
import { DEFAULT_TEAM, isTeamSettings, TEAM_AVATAR_COLORS, TEAM_AVATAR_SHAPES, TEAM_NAME_PATTERN, teamAvatarOf, type TeamMember, type TeamSettings as Team } from "../../../../shared/team";
import { api, errorMessage } from "../../api";
import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { PencilIcon, PlusIcon, RotateCcwIcon, TrashCanIcon, UploadIcon } from "../../lib/icons";
import { fileToAvatarImage, TeamAvatarImageError } from "../../lib/teamAvatarImage";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "../chat/composerPickerStyles";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { TEAM_AVATAR_FILL, TeamAvatar, TeamAvatarGlyph } from "../team/TeamAvatar";
import { SettingsRow } from "./SettingsRow";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FOLLOW = "__follow__";
const MAX_MEMBERS = 12;

/** A member the dialog is editing, and whether saving should append or replace it. */
interface MemberEdit {
	member: TeamMember;
	isNew: boolean;
}

/**
 * Settings → Team: the AI team picked as "Team" in the model menu. Adapted from
 * DS Bot (https://github.com/Fei2411/DeepSeek-Bot, Apache-2.0): each member has a
 * name, role, own instructions and model; one admin coordinates the rest.
 * Edits are kept as a draft and saved only when the whole roster is valid.
 *
 * The page is a roster, not a form: a row per member (who they are, which model
 * they run on) with edit and delete behind their own buttons. Everything a
 * member is — role, instructions, model, avatar — is filled in once in the dialog
 * and then read as status here.
 */
export function TeamSettings() {
	const { t } = useTranslation();
	const [team, setTeam] = useState<Team | null>(null);
	const [models, setModels] = useState<CodeIntelModelOption[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<MemberEdit | null>(null);
	const [removing, setRemoving] = useState<TeamMember | null>(null);
	const [resetOpen, setResetOpen] = useState(false);
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
	const saveMember = (member: TeamMember, isNew: boolean) => {
		if (!team) return;
		if (isNew) {
			if (team.members.length >= MAX_MEMBERS) return;
			// The first member on an empty roster has to be the admin.
			update({ ...team, members: [...team.members, member], adminId: team.members.length ? team.adminId : member.id });
		} else {
			update({ ...team, members: team.members.map((entry) => (entry.id === member.id ? member : entry)) });
		}
		setEditing(null);
	};
	const newMember = (): TeamMember => {
		const members = team?.members ?? [];
		let n = members.length + 1;
		while (members.some((member) => member.name.toLowerCase() === `member${n}`)) n++;
		return { id: `m-${Date.now().toString(36)}`, name: `Member${n}`, role: "", instructions: "", modelKey: "", thinkingLevel: "low", access: "full" };
	};
	const removeMember = (id: string) => {
		if (!team) return;
		const members = team.members.filter((member) => member.id !== id);
		update({ ...team, members, adminId: team.adminId === id ? members[0]?.id ?? "" : team.adminId });
	};
	/**
	 * Back to the three built-in members. Only the roster is replaced — the
	 * behaviour switches (parallel, peer delegation, hand-off cap) are the user's
	 * own and stay as they are.
	 */
	const resetToDefault = () => {
		if (!team) return;
		setEditing(null);
		setRemoving(null);
		update({
			...team,
			members: DEFAULT_TEAM.members.map((member) => ({ ...member })),
			adminId: DEFAULT_TEAM.adminId,
		});
	};
	const modelLabel = (key: string) => (key ? models.find((model) => model.key === key)?.label ?? `${key} · ${t("team.modelMissing")}` : t("team.followChatModel"));
	const accessLabel = (access: TeamMember["access"]) => (access === "read-only" ? t("team.readOnly") : t("team.fullAccess"));

	if (!team) return error ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span> : null;
	const admin = team.members.find((member) => member.id === team.adminId);
	// Reset only touches the roster, so it is offered exactly while the roster differs.
	const isDefaultRoster =
		JSON.stringify(team.members) === JSON.stringify(DEFAULT_TEAM.members);
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-start justify-between gap-3">
				<p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("team.description")}</p>
				<Button className="shrink-0" size="xs" variant="chrome-outline" disabled={isDefaultRoster} onClick={() => setResetOpen(true)}>
					<RotateCcwIcon className="size-3.5" />
					{t("team.resetDefault")}
				</Button>
			</div>
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
				<Button size="xs" variant="subtle" disabled={team.members.length >= MAX_MEMBERS}
					onClick={() => setEditing({ member: newMember(), isNew: true })}>
					<PlusIcon className="size-3.5" />
					{t("team.addMember")}
				</Button>
			</div>

			<div className="flex flex-col divide-y divide-[color:var(--app-surface-divider)] rounded-xl border border-border">
				{team.members.map((member) => (
					<div key={member.id} className="flex items-center gap-2 px-3 py-2">
						<TeamAvatar member={member} size={28} />
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="flex items-center gap-1.5">
								<span className="truncate text-[length:var(--app-font-size-ui,12px)] font-medium">@{member.name}</span>
								{member.id === team.adminId ? (
									<span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">{t("team.admin")}</span>
								) : null}
							</span>
							<span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
								{member.role ? `${member.role} · ` : ""}{modelLabel(member.modelKey)} · {accessLabel(member.access)}
							</span>
						</div>
						<Button size="icon-xs" variant="chrome-outline" title={t("common.edit")}
							onClick={() => setEditing({ member, isNew: false })}>
							<PencilIcon className="size-3.5" />
						</Button>
						<Button size="icon-xs" variant="ghost" title={t("team.remove")} disabled={team.members.length <= 1}
							onClick={() => { setEditing(null); setRemoving(member); }}>
							<TrashCanIcon className="size-3.5" />
						</Button>
					</div>
				))}
			</div>

			{invalid ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--warning)]">{invalid}</span> : null}
			{error ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{error}</span> : null}
			<p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("team.usageHint")}</p>

			{editing ? (
				<MemberDialog
					key={editing.member.id}
					member={editing.member}
					isNew={editing.isNew}
					models={models}
					// Names are unique across the roster, so the dialog validates against the others.
					otherNames={team.members.filter((entry) => entry.id !== editing.member.id).map((entry) => entry.name.toLowerCase())}
					onClose={() => setEditing(null)}
					onSave={(member) => saveMember(member, editing.isNew)}
				/>
			) : null}

			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => { if (!open) setRemoving(null); }}
				title={t("team.removeTitle", { name: removing ? `@${removing.name}` : "" })}
				description={t("team.removeDescription")}
				footer={
					<>
						<Button onClick={() => setRemoving(null)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button
							onClick={() => {
								if (!removing) return;
								const id = removing.id;
								setRemoving(null);
								removeMember(id);
							}}
							size="sm"
							variant="destructive"
						>
							{t("team.remove")}
						</Button>
					</>
				}
			/>

			<ConfirmDialog
				open={resetOpen}
				onOpenChange={setResetOpen}
				title={t("team.resetTitle")}
				description={t("team.resetDescription")}
				footer={
					<>
						<Button onClick={() => setResetOpen(false)} size="sm" variant="chrome-outline">
							{t("common.cancel")}
						</Button>
						<Button
							onClick={() => {
								setResetOpen(false);
								resetToDefault();
							}}
							size="sm"
							variant="destructive"
						>
							{t("team.resetDefault")}
						</Button>
					</>
				}
			/>
		</section>
	);
}

/**
 * One member's whole configuration, as a modal dialog: name, role, instructions,
 * model, thinking level, access and avatar.
 *
 * A dialog rather than fields stacked under the row: a member is set up once and
 * then read as a line in the roster, so the inline form pushed the rest of the
 * team below the fold. The draft is local and thrown away on dismissal — Cancel
 * and the backdrop are the same as never having opened it.
 */
function MemberDialog({
	member,
	isNew,
	models,
	otherNames,
	onClose,
	onSave,
}: {
	member: TeamMember;
	isNew: boolean;
	models: CodeIntelModelOption[];
	otherNames: string[];
	onClose: () => void;
	onSave: (member: TeamMember) => void;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState<TeamMember>(member);
	const [imageBusy, setImageBusy] = useState(false);
	const [imageError, setImageError] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	const name = draft.name.trim();
	const nameError = !TEAM_NAME_PATTERN.test(name)
		? t("team.error.name", { name: draft.name.trim() || "…" })
		: name.toLowerCase() === "all"
			? t("team.error.reserved")
			: otherNames.includes(name.toLowerCase())
				? t("team.error.duplicate", { name })
				: null;
	const avatar = teamAvatarOf(draft);
	const patch = (next: Partial<TeamMember>) => setDraft((current) => ({ ...current, ...next }));
	const modelLabel = draft.modelKey ? models.find((model) => model.key === draft.modelKey)?.label ?? `${draft.modelKey} · ${t("team.modelMissing")}` : t("team.followChatModel");
	const chooseImage = async (file: File | undefined) => {
		if (!file) return;
		setImageError(null);
		setImageBusy(true);
		try {
			patch({ avatar: { ...avatar, image: await fileToAvatarImage(file) } });
		} catch (cause) {
			const code = cause instanceof TeamAvatarImageError ? cause.code : "invalid";
			setImageError(t(`team.avatarError.${code}`));
		} finally {
			setImageBusy(false);
		}
	};

	return (
		<Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
			<Dialog.Portal>
				<Dialog.Backdrop
					className={cn(
						"fixed inset-0 z-50 min-h-dvh bg-black/35 backdrop-blur-[1px]",
						"transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
					)}
				/>
				<Dialog.Popup
					data-settings-surface="dialog"
					className={cn(
						"fixed left-1/2 top-1/2 z-50 flex max-h-[min(34rem,calc(100dvh-4rem))] -translate-x-1/2 -translate-y-1/2",
						"flex-col gap-3 overflow-hidden rounded-2xl border p-4",
						RAISED_SURFACE_BORDER_CLASS_NAME,
						"bg-popover text-popover-foreground shadow-2xl outline-none",
						"w-[32rem] max-w-[calc(100vw-3rem)]",
						"transition-[scale,opacity] duration-100 ease-out",
						"data-ending-style:scale-[0.98] data-ending-style:opacity-0",
						"data-starting-style:scale-[0.98] data-starting-style:opacity-0",
					)}
				>
					<div className="flex shrink-0 items-center gap-2">
						<TeamAvatar member={draft} size={28} />
						<Dialog.Title className="text-[length:var(--app-font-size-ui-lg,13px)] font-semibold">
							{t(isNew ? "team.addTitle" : "team.editTitle")}
						</Dialog.Title>
					</div>

					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
						<div className="flex gap-2">
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<Label>{t("team.name")}</Label>
								<Input autoFocus value={draft.name} maxLength={32} aria-invalid={nameError !== null}
									onChange={(event) => patch({ name: event.target.value })} />
								{nameError ? (
									<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{nameError}</span>
								) : null}
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<Label>{t("team.role")}</Label>
								<Input placeholder={t("team.rolePlaceholder")} value={draft.role} maxLength={60}
									onChange={(event) => patch({ role: event.target.value })} />
							</div>
						</div>

						<div className="flex flex-col gap-1">
							<Label>{t("team.instructions")}</Label>
							<Textarea size="sm" placeholder={t("team.instructionsPlaceholder")} value={draft.instructions} maxLength={8000}
								onChange={(event) => patch({ instructions: event.target.value })} />
						</div>

						<div className="flex flex-col gap-1">
							<Label>{t("team.model")}</Label>
							<Select value={draft.modelKey || FOLLOW} onValueChange={(key) => { if (key) patch({ modelKey: key === FOLLOW ? "" : key }); }}>
								<SelectTrigger size="sm"><SelectValue>{modelLabel}</SelectValue></SelectTrigger>
								<SelectPopup surface="settings">
									<SelectItem value={FOLLOW}>{t("team.followChatModel")}</SelectItem>
									{models.map((model) => <SelectItem key={model.key} value={model.key}>{model.label}</SelectItem>)}
								</SelectPopup>
							</Select>
						</div>

						<div className="flex gap-2">
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<Label>{t("picker.thinking")}</Label>
								<Select value={draft.thinkingLevel} onValueChange={(level) => { if (level) patch({ thinkingLevel: level as ThinkingLevel }); }}>
									<SelectTrigger size="sm"><SelectValue /></SelectTrigger>
									<SelectPopup surface="settings">{LEVELS.map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectPopup>
								</Select>
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<Label>{t("team.access")}</Label>
								<Select value={draft.access} onValueChange={(access) => { if (access) patch({ access: access as TeamMember["access"] }); }}>
									<SelectTrigger size="sm">
										<SelectValue>{draft.access === "read-only" ? t("team.readOnly") : t("team.fullAccess")}</SelectValue>
									</SelectTrigger>
									<SelectPopup surface="settings">
										<SelectItem value="full">{t("team.fullAccess")}</SelectItem>
										<SelectItem value="read-only">{t("team.readOnly")}</SelectItem>
									</SelectPopup>
								</Select>
							</div>
						</div>

						<div className="flex flex-col gap-2">
							<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
								<span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">{t("team.avatar")}</span>
								<div className="flex items-center gap-1.5" role="radiogroup" aria-label={t("team.avatarShape")}>
									{TEAM_AVATAR_SHAPES.map((shape) => {
										// Picking a shape clears an uploaded picture, so the choice is not hidden behind it.
										const selected = avatar.shape === shape && !avatar.image;
										return (
											<button key={shape} type="button" role="radio" aria-checked={selected} title={shape}
												className={selected ? "rounded-md ring-2 ring-foreground/60 ring-offset-1 ring-offset-background" : "rounded-md opacity-45 hover:opacity-90"}
												onClick={() => patch({ avatar: { shape, color: avatar.color } })}>
												<TeamAvatarGlyph avatar={{ ...avatar, shape, image: undefined }} size={20} blink={false} />
											</button>
										);
									})}
								</div>
								<div className="flex items-center gap-1.5" role="radiogroup" aria-label={t("team.avatarColor")}>
									{TEAM_AVATAR_COLORS.map((color) => {
										const selected = avatar.color === color;
										return (
											<button data-settings-glass-exempt key={color} type="button" role="radio" aria-checked={selected} title={color}
												className={selected ? "size-4 rounded-full ring-2 ring-foreground/60 ring-offset-1 ring-offset-background" : "size-4 rounded-full opacity-60 hover:opacity-100"}
												style={{ background: TEAM_AVATAR_FILL[color] }}
												onClick={() => patch({ avatar: { ...avatar, color } })} />
										);
									})}
								</div>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								<input
									accept="image/*"
									className="hidden"
									onChange={(event) => {
										void chooseImage(event.currentTarget.files?.[0]);
										event.currentTarget.value = "";
									}}
									ref={fileInput}
									type="file"
								/>
								<Button disabled={imageBusy} onClick={() => fileInput.current?.click()} size="xs" variant="chrome-outline">
									<UploadIcon className="size-3.5" />
									{t(avatar.image ? "team.avatarReplaceImage" : "team.avatarUploadImage")}
								</Button>
								{avatar.image ? (
									<Button onClick={() => patch({ avatar: { shape: avatar.shape, color: avatar.color } })} size="xs" variant="ghost">
										{t("team.avatarRemoveImage")}
									</Button>
								) : null}
								<span className="text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground">{t("team.avatarImageHint")}</span>
							</div>
							{imageError ? <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">{imageError}</span> : null}
						</div>
					</div>

					<div className="flex shrink-0 items-center justify-end gap-2">
						<Button onClick={onClose} size="sm" variant="ghost">{t("common.cancel")}</Button>
						<Button
							disabled={nameError !== null}
							onClick={() => { if (nameError === null) onSave({ ...draft, name }); }}
							size="sm"
							variant="subtle"
						>
							{t("common.save")}
						</Button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
