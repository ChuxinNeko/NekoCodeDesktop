import { shortenPath } from "../../../../shared/paths";
import { api } from "../../api";
import { useTranslation } from "../../i18n";
import { ChevronDownIcon, FolderOpenIcon } from "../../lib/icons";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ProjectPicker({ cwd, disabled, onPickProject }: {
	cwd: string | null;
	disabled?: boolean;
	onPickProject: () => void;
}) {
	const { t } = useTranslation();
	return (
		<Tooltip>
			<TooltipTrigger render={
				<Button
					aria-label={t("welcome.chooseWorkingDir")}
					className="min-w-0 max-w-full shrink gap-1.5"
					disabled={disabled}
					onClick={onPickProject}
					size="xs"
					variant="chrome-outline"
				/>
			}>
				<FolderOpenIcon className="size-3.5" />
				<span className="truncate">{cwd ? shortenPath(cwd, api?.homeDir ?? "") : t("welcome.chooseFolder")}</span>
				<ChevronDownIcon className="size-3 opacity-60" />
			</TooltipTrigger>
			<TooltipPopup side="bottom">
				{cwd ? t("welcome.workingIn", { cwd }) : t("welcome.chooseWorkingDir")}
			</TooltipPopup>
		</Tooltip>
	);
}
