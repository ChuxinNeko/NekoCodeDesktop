import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { HostDirectoryPickerProvider } from "./components/HostDirectoryPicker";
import { I18nProvider } from "./i18n";
import "./index.css";
import "./hooks/useTheme";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

/**
 * Fade out the boot splash from index.html. Run from an effect, so it happens
 * after the first commit, and a frame later still, so the app has painted
 * underneath before the splash starts to go.
 */
function dismissBootSplash(): void {
	const splash = document.getElementById("boot-splash");
	if (!splash || splash.dataset.state === "leaving") return;
	requestAnimationFrame(() => {
		splash.dataset.state = "leaving";
		const remove = () => splash.remove();
		splash.addEventListener("transitionend", remove, { once: true });
		// transitionend never fires when the transition does not run.
		setTimeout(remove, 400);
	});
}

function BootSplashDismisser() {
	useEffect(dismissBootSplash, []);
	return null;
}

createRoot(container).render(
	<StrictMode>
		<I18nProvider>
			<HostDirectoryPickerProvider>
				<App />
			</HostDirectoryPickerProvider>
		</I18nProvider>
		<BootSplashDismisser />
	</StrictMode>,
);
