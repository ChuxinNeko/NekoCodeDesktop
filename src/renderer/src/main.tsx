import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./i18n";
import "./index.css";
import "./hooks/useTheme";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

createRoot(container).render(
	<StrictMode>
		<I18nProvider>
			<App />
		</I18nProvider>
	</StrictMode>,
);
