import type { Session, State } from "./bridge";

/** How the dial decides which session to display and drive. */
export type SourceMode = "auto" | string;

/**
 * Picks the session a dial should show.
 *
 * Windows' own "current session" is not a good enough answer on its own: it
 * tracks the last app to take the transport focus, which regularly leaves it
 * pointing at a player that was paused hours ago while something else is
 * actually making sound. Preferring a playing session keeps the dial showing
 * what the room can hear.
 */
export function pick(state: State, source: SourceMode = "auto"): Session | undefined {
	const { sessions } = state;
	if (sessions.length === 0) return undefined;

	if (source !== "auto") {
		// A pinned source that is not running shows nothing, rather than
		// silently driving a different app's playback.
		return sessions.find((s) => s.id === source);
	}

	const playing = sessions.filter((s) => s.status === "playing");
	if (playing.length === 1) return playing[0];
	if (playing.length > 1) {
		// More than one is genuinely ambiguous; defer to Windows, then to
		// whichever reported a position most recently.
		const current = playing.find((s) => s.id === state.current);
		if (current) return current;
		return [...playing].sort((a, b) => b.positionAt - a.positionAt)[0];
	}

	const current = sessions.find((s) => s.id === state.current);
	if (current) return current;

	const resumable = sessions.find((s) => s.status === "paused");
	return resumable ?? sessions[0];
}

/**
 * Current playback position, advanced to now.
 *
 * SMTC republishes the timeline only on discrete events - a track change, a
 * seek, a pause - so the raw position can sit still for many seconds while
 * audio plays. Extrapolating from the sample's timestamp is what makes the
 * progress bar move smoothly.
 */
export function positionOf(session: Session, now = Date.now()): number | undefined {
	if (session.positionMs === undefined) return undefined;
	if (session.status !== "playing") return session.positionMs;

	const elapsed = Math.max(0, now - session.positionAt) * (session.rate || 1);
	const position = session.positionMs + elapsed;
	return session.durationMs !== undefined ? Math.min(position, session.durationMs) : position;
}

/** Distinct apps currently publishing a session, for the property inspector. */
export function sources(state: State): { id: string; app: string }[] {
	const seen = new Map<string, string>();
	for (const session of state.sessions) {
		if (!seen.has(session.id)) seen.set(session.id, session.app);
	}
	return [...seen].map(([id, app]) => ({ id, app }));
}

/**
 * A readable name for a source id, for use when that source is not running.
 *
 * A pinned player that is closed publishes nothing, so there is no friendly
 * name to read off a session and the id has to be cut down instead. Good
 * enough for the common shapes - Spotify.exe and com.squirrel.TIDAL.TIDAL both
 * reduce to the product name.
 */
export function labelFor(id: string): string {
	let trimmed = id.replace(/\.exe$/i, "");

	const bang = trimmed.indexOf("!");
	if (bang > 0) trimmed = trimmed.slice(0, bang);
	const underscore = trimmed.indexOf("_");
	if (underscore > 0) trimmed = trimmed.slice(0, underscore);

	const parts = trimmed.split(".").filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

export function formatTime(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "--:--";
	const total = Math.floor(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
