import { describe, expect, it } from "vitest";

import type { Session, State } from "../src/smtc/bridge";
import { formatTime, pick, positionOf, sources } from "../src/smtc/store";

function session(overrides: Partial<Session> & { id: string }): Session {
	return {
		app: overrides.id,
		title: "Track",
		artist: "Artist",
		album: "Album",
		albumArtist: "",
		trackNumber: 0,
		status: "paused",
		canPlayPause: true,
		canNext: true,
		canPrev: true,
		canSeek: true,
		positionAt: 0,
		rate: 1,
		...overrides
	} as Session;
}

function state(sessions: Session[], current?: string): State {
	return { current, volume: 0.5, muted: false, sessions };
}

describe("pick", () => {
	it("returns nothing when there are no sessions", () => {
		expect(pick(state([]))).toBeUndefined();
	});

	it("prefers the session that is actually playing over Windows' current one", () => {
		// The headline behaviour: Windows keeps pointing at the last app to
		// take transport focus, which is routinely a player paused hours ago.
		const chosen = pick(
			state([session({ id: "paused-app" }), session({ id: "playing-app", status: "playing" })], "paused-app")
		);
		expect(chosen?.id).toBe("playing-app");
	});

	it("defers to Windows when several are playing", () => {
		const chosen = pick(
			state(
				[session({ id: "a", status: "playing" }), session({ id: "b", status: "playing" })],
				"b"
			)
		);
		expect(chosen?.id).toBe("b");
	});

	it("falls back to the most recent when several play and none is current", () => {
		const chosen = pick(
			state([
				session({ id: "old", status: "playing", positionAt: 100 }),
				session({ id: "new", status: "playing", positionAt: 900 })
			])
		);
		expect(chosen?.id).toBe("new");
	});

	it("uses the current session when nothing is playing", () => {
		const chosen = pick(state([session({ id: "a" }), session({ id: "b" })], "b"));
		expect(chosen?.id).toBe("b");
	});

	it("honours a pinned source", () => {
		const chosen = pick(state([session({ id: "a", status: "playing" }), session({ id: "b" })]), "b");
		expect(chosen?.id).toBe("b");
	});

	it("shows nothing rather than hijacking another player when the pin is absent", () => {
		// Silently falling through to a different app would mean a dial pinned
		// to Plexamp starts controlling Spotify, which is worse than blank.
		expect(pick(state([session({ id: "a", status: "playing" })]), "missing")).toBeUndefined();
	});
});

describe("positionOf", () => {
	it("is undefined without a position", () => {
		expect(positionOf(session({ id: "a" }))).toBeUndefined();
	});

	it("holds still while paused", () => {
		const s = session({ id: "a", status: "paused", positionMs: 5_000, positionAt: 0 });
		expect(positionOf(s, 60_000)).toBe(5_000);
	});

	it("advances with wall clock while playing", () => {
		// SMTC republishes the timeline only on discrete events, so without
		// this the progress bar would sit frozen for seconds at a time.
		const s = session({ id: "a", status: "playing", positionMs: 5_000, positionAt: 1_000 });
		expect(positionOf(s, 4_000)).toBe(8_000);
	});

	it("respects playback rate", () => {
		const s = session({ id: "a", status: "playing", positionMs: 0, positionAt: 0, rate: 2 });
		expect(positionOf(s, 1_000)).toBe(2_000);
	});

	it("never runs past the end of the track", () => {
		const s = session({ id: "a", status: "playing", positionMs: 9_000, positionAt: 0, durationMs: 10_000 });
		expect(positionOf(s, 600_000)).toBe(10_000);
	});

	it("ignores a timestamp in the future", () => {
		const s = session({ id: "a", status: "playing", positionMs: 5_000, positionAt: 10_000 });
		expect(positionOf(s, 0)).toBe(5_000);
	});
});

describe("sources", () => {
	it("lists each app once", () => {
		const list = sources(state([session({ id: "a", app: "TIDAL" }), session({ id: "b", app: "Spotify" })]));
		expect(list).toEqual([
			{ id: "a", app: "TIDAL" },
			{ id: "b", app: "Spotify" }
		]);
	});
});

describe("formatTime", () => {
	it("formats minutes and seconds with padding", () => {
		expect(formatTime(0)).toBe("0:00");
		expect(formatTime(9_000)).toBe("0:09");
		expect(formatTime(95_000)).toBe("1:35");
		expect(formatTime(160_906)).toBe("2:40");
	});

	it("includes hours for long items", () => {
		expect(formatTime(3_725_000)).toBe("1:02:05");
	});

	it("degrades for unknown or nonsense values", () => {
		expect(formatTime(undefined)).toBe("--:--");
		expect(formatTime(-1)).toBe("--:--");
		expect(formatTime(Number.NaN)).toBe("--:--");
	});
});
