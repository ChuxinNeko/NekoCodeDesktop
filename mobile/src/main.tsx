import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/renderer/src/i18n";
import "../../src/renderer/src/index.css";
import "../../src/renderer/src/hooks/useTheme";
import "./mobile.css";
import { MobileApp } from "./MobileApp";

document.documentElement.classList.add("mobile-app");
createRoot(document.getElementById("root")!).render(<StrictMode><I18nProvider><MobileApp /></I18nProvider></StrictMode>);
