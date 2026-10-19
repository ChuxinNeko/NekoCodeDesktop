import { createContext, useContext } from "react";

/**
 * Settings menus render in portals, outside the page's DOM subtree. Carry the
 * surface scope through React so their glass stays settings-only.
 */
export const SettingsSurfaceContext = createContext(false);

export function useSettingsSurface(): boolean {
	return useContext(SettingsSurfaceContext);
}