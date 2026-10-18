import { useLayoutMode } from "../../hooks/useLayoutMode";
import { useTranslation } from "../../i18n";
import { LayoutModeSwitch } from "../LayoutModeSwitch";
import { SettingsRow } from "./SettingsRow";

export function LayoutSettings() {
	const { t } = useTranslation();
	const { available, layoutMode, setLayoutMode } = useLayoutMode();
	if (!available) return null;
	return (
		<SettingsRow label={t("layout.switch")} hint={t("layout.hint")}>
			<LayoutModeSwitch value={layoutMode} onChange={setLayoutMode} />
		</SettingsRow>
	);
}
