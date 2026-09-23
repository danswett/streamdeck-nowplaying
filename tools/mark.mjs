/**
 * The product mark, in one place.
 *
 * The same artwork has to appear on the key, in the Stream Deck action list,
 * on the plugin icon and in the Marketplace listing. When each of those was
 * drawn from its own copy of the geometry they drifted, and the store showed a
 * different product from the preferences pane. Both builders import from here
 * so that cannot happen again.
 *
 * `accent`, `frame` and `ink` are parameters rather than literals precisely so
 * the action-list variant can pass white for all three, which is what Elgato
 * require: a monochrome white glyph on a transparent background.
 *
 * https://docs.elgato.com/guidelines/stream-deck/plugins#icons
 */

export const TILE = "#121215";
export const ACCENT = "#1db954";
export const FRAME = "#2e2e35";
export const INK = "#f4f4f5";
export const DISC = "#1c1c21";
export const WHITE = "#ffffff";

/** A framed record with the play head beside it, on the 72px key canvas. */
export function dial(accent, frame, ink) {
	return (
		`<rect x="14" y="14" width="44" height="44" rx="6" fill="none" stroke="${frame}" stroke-width="3"/>` +
		`<circle cx="36" cy="36" r="7.5" fill="none" stroke="${accent}" stroke-width="3"/>` +
		`<circle cx="36" cy="36" r="2" fill="${ink}"/>` +
		`<path d="M 44 26 L 44 20 L 52 22 L 52 28 Z" fill="${accent}"/>`
	);
}

/** The product mark: a record under a play head, on the 288px canvas. */
export function mark(accent, frame, ink, disc) {
	return (
		`<circle cx="144" cy="144" r="86" fill="${disc}" stroke="${frame}" stroke-width="8"/>` +
		`<circle cx="144" cy="144" r="52" fill="none" stroke="${accent}" stroke-width="10"/>` +
		`<circle cx="144" cy="144" r="16" fill="${ink}"/>` +
		`<path d="M 186 104 L 186 68 L 232 78 L 232 114 Z" fill="${accent}"/>`
	);
}
