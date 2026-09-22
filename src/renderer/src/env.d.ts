/// <reference types="vite/client" />

import type { NekoCodeDesktopApi } from "../../preload/index";
import type { WebUiRuntime } from "../../shared/webui";

declare global {
	interface Window {
		nekocode?: NekoCodeDesktopApi;
		__NEKOCODE_WEBUI__?: WebUiRuntime;
	}
}

// The browser panel hosts pages in a renderer-owned <webview> guest. React has no
// built-in element for it, so declare the subset of the tag's DOM surface we set
// declaratively; everything else goes through the WebviewTag ref.
//
// `allowpopups` must be present for `window.open` / `target=_blank` to reach the
// main process at all; the main-process handler then denies the native window and
// opens the URL as a panel tab instead.
declare module "react" {
	namespace JSX {
		interface IntrinsicElements {
			webview: React.DetailedHTMLProps<
				React.HTMLAttributes<HTMLElement> & {
					src?: string;
					partition?: string;
				},
				HTMLElement
			>;
		}
	}
}

export {};
