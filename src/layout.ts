/**
 * Which layout a dial uses, kept apart from the action so it can be tested
 * without a Stream Deck connection.
 */
import { PANEL_W, WIDE_TEXT_W } from "./render";

export type ArtSetting = "show" | "hide";

export const LAYOUT = "layouts/nowplaying.json";

/** Full-width text, used when album art is hidden. */
export const TEXT_LAYOUT = "layouts/nowplaying-text.json";

/**
 * Used whenever there is nothing to show.
 *
 * A separate layout, because the playing layout reserves 88px for album art;
 * idle needs the whole canvas for one legible line instead of a blank tile
 * beside cramped text.
 */
export const IDLE_LAYOUT = "layouts/idle.json";

/**
 * Art is hidden only on an explicit "hide". Dials saved before the setting
 * existed carry no value, and they must look the same after an update.
 */
export function showsArt(art: unknown): boolean {
	return art !== "hide";
}

export function layoutFor(idle: boolean, art: unknown): string {
	if (idle) return IDLE_LAYOUT;
	return showsArt(art) ? LAYOUT : TEXT_LAYOUT;
}

/** Width the text rows are drawn at, which is what decides whether a line scrolls. */
export function textWidthFor(art: unknown): number {
	return showsArt(art) ? PANEL_W : WIDE_TEXT_W;
}
