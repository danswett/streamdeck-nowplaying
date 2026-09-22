import streamDeck, {
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	type SendToPluginEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	action
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

import {
	type Face,
	ART_SIZE,
	PANEL_W,
	renderArtPlaceholder,
	renderIdle,
	renderPanel,
	overflows,
	toPixmap
} from "../render";
import { type Session, type State, bridge } from "../smtc/bridge";
import { labelFor, pick, positionOf, sources } from "../smtc/store";

const logger = streamDeck.logger.createScope("nowplaying");

const LAYOUT = "layouts/nowplaying.json";

/**
 * Used whenever there is nothing to show.
 *
 * A separate layout, because the playing layout reserves 88px for album art;
 * idle needs the whole canvas for one legible line instead of a blank tile
 * beside cramped text.
 */
const IDLE_LAYOUT = "layouts/idle.json";

/** How long the volume readout replaces the progress row after an adjustment. */
const VOLUME_HOLD_MS = 1500;

/** Rotation is accumulated over this window so one spin is not one COM call per tick. */
const ROTATE_FLUSH_MS = 45;

/** Minimum gap between track skips driven by rotation. */
const SKIP_COOLDOWN_MS = 350;

/** Detents required before a rotation counts as a skip. */
const SKIP_TICKS = 2;

/** Seconds of audio per detent in seek mode. */
const SEEK_SECONDS = 5;

const ANIMATE_MS = 100;
const IDLE_MS = 500;

/**
 * Grace period before the sidecar is stopped after the last dial disappears.
 *
 * Stream Deck sends willDisappear/willAppear around page and profile changes,
 * so stopping immediately means tearing the sidecar down and starting it again
 * moments later - churn that is both wasteful and a source of races.
 */
const LINGER_MS = 5000;

export type NowPlayingSettings = {
	/** "auto", or a specific SMTC source app id to pin to. */
	source?: string;
	rotate?: "volume" | "track" | "seek" | "none";
	/** Percentage points per detent. */
	volumeStep?: number;
	press?: "toggle" | "next" | "prev" | "mute" | "none";
	touch?: "toggle" | "next" | "prev" | "mute" | "none";
	longTouch?: "toggle" | "next" | "prev" | "mute" | "none";
};

type Settings = NowPlayingSettings & JsonObject;

type Instance = {
	readonly dial: DialAction<Settings>;
	settings: NowPlayingSettings;
	/** Layout currently applied, so it is only re-sent when it must change. */
	layout?: string;
	/** Last friendly name seen for a pinned source, for the idle message. */
	sourceLabel?: string;
	/** Last painted frame, so identical repaints are not sent to the device. */
	paintedPanel?: string;
	paintedArt?: string;
	volumeUntil: number;
	pendingTicks: number;
	flushTimer?: NodeJS.Timeout;
	lastSkipAt: number;
	pressedAt?: number;
};

/**
 * A dial that shows whatever Windows is playing and drives it.
 *
 * Deliberately source-agnostic: everything comes through the System Media
 * Transport Controls, so Spotify, TIDAL, Plexamp and browser players all work
 * without the plugin knowing they exist.
 */
@action({ UUID: "com.dswett.nowplaying.dial" })
export class NowPlayingAction extends SingletonAction<Settings> {
	readonly #instances = new Map<string, Instance>();
	#unwatch: (() => void) | undefined;
	#ticker: NodeJS.Timeout | undefined;
	#tickerRate = 0;
	#stopTimer: NodeJS.Timeout | undefined;

	// -- lifecycle ----------------------------------------------------------

	override onWillAppear(ev: WillAppearEvent<Settings>): void {
		if (!ev.action.isDial()) return;

		const instance: Instance = {
			dial: ev.action,
			settings: ev.payload.settings ?? {},
			volumeUntil: 0,
			pendingTicks: 0,
			lastSkipAt: 0
		};
		this.#instances.set(ev.action.id, instance);

		// A dial reappearing during the grace period keeps the existing
		// sidecar rather than restarting one.
		if (this.#stopTimer) {
			clearTimeout(this.#stopTimer);
			this.#stopTimer = undefined;
		}

		if (!this.#unwatch) {
			this.#unwatch = bridge.watch(() => this.#paintAll());
			bridge.start();
		}

		// The layout is applied by the first paint, which knows whether there
		// is anything to show.
		this.#describe(instance);
		this.#paint(instance);
		this.#retune();
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		const instance = this.#instances.get(ev.action.id);
		if (instance?.flushTimer) clearTimeout(instance.flushTimer);
		this.#instances.delete(ev.action.id);

		if (this.#instances.size === 0) {
			this.#unwatch?.();
			this.#unwatch = undefined;
			this.#stopTicker();

			// Nothing is displaying media any more, so the sidecar has no
			// reason to keep polling Windows - but give a page switch time to
			// bring the dial back before tearing it down.
			if (this.#stopTimer) clearTimeout(this.#stopTimer);
			this.#stopTimer = setTimeout(() => {
				this.#stopTimer = undefined;
				bridge.stop();
			}, LINGER_MS);
		} else {
			this.#retune();
		}
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance) return;
		instance.settings = ev.payload.settings ?? {};
		// The pinned source may have changed, so the remembered name for it is
		// no longer trustworthy.
		instance.sourceLabel = undefined;
		instance.paintedPanel = undefined;
		instance.paintedArt = undefined;
		this.#describe(instance);
		this.#paint(instance);
		this.#retune();
	}

	// -- interaction --------------------------------------------------------

	/**
	 * Answers the property inspector's request for a source list.
	 *
	 * The choices are whatever is publishing a session right now, so the list
	 * is built on demand rather than declared in the inspector markup.
	 */
	override onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> | void {
		const payload = ev.payload as { event?: string } | undefined;
		if (payload?.event !== "getSources") return;

		const items = [
			{ label: "Automatic (whatever is playing)", value: "auto" },
			...sources(bridge.state).map(({ id, app }) => ({ label: app, value: id }))
		];

		return streamDeck.ui.sendToPropertyInspector({ event: "getSources", items });
	}

	override onDialRotate(ev: DialRotateEvent<Settings>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance) return;

		const mode = instance.settings.rotate ?? "volume";
		if (mode === "none") return;

		// Detents arrive faster than Windows wants to be asked, so they are
		// pooled and applied as a single adjustment.
		instance.pendingTicks += ev.payload.ticks;
		if (instance.flushTimer) return;
		instance.flushTimer = setTimeout(() => {
			instance.flushTimer = undefined;
			this.#flush(instance);
		}, ROTATE_FLUSH_MS);
	}

	#flush(instance: Instance): void {
		const ticks = instance.pendingTicks;
		instance.pendingTicks = 0;
		if (ticks === 0) return;

		const mode = instance.settings.rotate ?? "volume";
		const session = this.#session(instance);

		if (mode === "volume") {
			// Always the displayed player's own mixer entry. Falling back to
			// the system slider would mean a dial captioned "TIDAL" quietly
			// changing the volume of everything on the machine.
			if (!session) return;
			const step = (Number(instance.settings.volumeStep) || 2) / 100;
			bridge.send({ cmd: "volume", delta: ticks * step, target: session.id });
			instance.volumeUntil = Date.now() + VOLUME_HOLD_MS;
			this.#retune();
			this.#paint(instance);
			return;
		}

		if (mode === "track") {
			// Skipping is discrete and destructive to listening, so it needs a
			// firmer threshold than a continuous parameter.
			const now = Date.now();
			if (Math.abs(ticks) < SKIP_TICKS || now - instance.lastSkipAt < SKIP_COOLDOWN_MS) return;
			instance.lastSkipAt = now;
			bridge.send({ cmd: ticks > 0 ? "next" : "prev", target: session?.id });
			return;
		}

		if (mode === "seek") {
			if (!session?.canSeek || session.durationMs === undefined) return;
			const current = positionOf(session) ?? 0;
			const next = Math.max(0, Math.min(session.durationMs, current + ticks * SEEK_SECONDS * 1000));
			bridge.send({ cmd: "seek", positionMs: Math.round(next), target: session.id });
		}
	}

	override onDialDown(ev: DialDownEvent<Settings>): void {
		const instance = this.#instances.get(ev.action.id);
		if (instance) instance.pressedAt = Date.now();
	}

	override onDialUp(ev: DialUpEvent<Settings>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance) return;
		instance.pressedAt = undefined;
		this.#invoke(instance, instance.settings.press ?? "toggle");
	}

	override onTouchTap(ev: TouchTapEvent<Settings>): void {
		const instance = this.#instances.get(ev.action.id);
		if (!instance) return;

		// The protocol reports a held touch on the same event rather than a
		// separate one, which is what makes prev/next both reachable.
		const held = (ev.payload as { hold?: boolean }).hold === true;
		const mode = held ? (instance.settings.longTouch ?? "prev") : (instance.settings.touch ?? "next");
		this.#invoke(instance, mode);
	}

	#invoke(instance: Instance, mode: NonNullable<NowPlayingSettings["press"]>): void {
		if (mode === "none") return;

		const session = this.#session(instance);
		if (!session) {
			void instance.dial.showAlert();
			return;
		}

		if (mode === "mute") {
			// Sent without a value so the sidecar toggles the app's own mixer
			// entry, rather than acting on a possibly stale local copy.
			bridge.send({ cmd: "mute", target: session.id });
			instance.volumeUntil = Date.now() + VOLUME_HOLD_MS;
			this.#retune();
			this.#paint(instance);
			return;
		}

		bridge.send({ cmd: mode, target: session.id });
	}

	// -- painting -----------------------------------------------------------

	#session(instance: Instance): Session | undefined {
		return pick(bridge.state, instance.settings.source ?? "auto");
	}

	#face(instance: Instance, state: State, now: number): Face {
		const session = this.#session(instance);
		const source = instance.settings.source ?? "auto";
		const pinned = source !== "auto";

		if (!session) {
			// Naming the pinned player is worth the bookkeeping: "Waiting for
			// Plexamp" tells the user it is closed, where a bare "No source"
			// looks like the plugin is broken.
			const label = pinned ? (instance.sourceLabel ?? labelFor(source)) : undefined;
			return {
				title: "",
				artist: "",
				album: "",
				app: "",
				status: "stopped",
				message: label ? `Waiting for ${label}` : "Nothing playing"
			};
		}

		if (pinned) instance.sourceLabel = session.app;

		const showVolume = now < instance.volumeUntil;

		return {
			title: session.title || session.app,
			artist: session.artist,
			album: session.album || session.albumArtist,
			app: session.app,
			status: session.status,
			position: positionOf(session, now),
			duration: session.durationMs,
			volume: showVolume
				? {
						level: session.appVolume,
						muted: session.appMuted ?? false,
						label: session.app,
						exclusive: session.appExclusive === true
					}
				: undefined
		};
	}

	#paintAll(): void {
		for (const instance of this.#instances.values()) this.#paint(instance);
		this.#retune();
	}

	/**
	 * Applies the right layout, then draws into it.
	 *
	 * Switching layouts clears whatever the device is showing, so the painted
	 * cache is dropped at the same time and the frame is redrawn once the
	 * switch is acknowledged.
	 */
	#paint(instance: Instance): void {
		const idle = this.#face(instance, bridge.state, Date.now()).message !== undefined;
		const wanted = idle ? IDLE_LAYOUT : LAYOUT;

		if (instance.layout === wanted) {
			this.#draw(instance);
			return;
		}

		instance.layout = wanted;
		instance.paintedPanel = undefined;
		instance.paintedArt = undefined;

		void instance.dial
			.setFeedbackLayout(wanted)
			.then(() => this.#draw(instance))
			.catch((err) => {
				// Left unset so the next paint retries rather than assuming
				// the device is showing a layout it never applied.
				instance.layout = undefined;
				logger.warn(`setFeedbackLayout failed: ${String(err)}`);
			});
	}

	#draw(instance: Instance): void {
		const now = Date.now();
		const face = this.#face(instance, bridge.state, now);
		const feedback: Record<string, string> = {};

		if (face.message !== undefined) {
			const canvas = renderIdle(face.message, face.detail);
			if (canvas !== instance.paintedPanel) {
				instance.paintedPanel = canvas;
				feedback.canvas = toPixmap(canvas);
			}
		} else {
			const session = this.#session(instance);
			const panel = renderPanel(face, now);
			const art = session?.art ?? toPixmap(renderArtPlaceholder(face.app || face.title || "?"));

			if (panel !== instance.paintedPanel) {
				instance.paintedPanel = panel;
				feedback.panel = toPixmap(panel);
			}
			if (art !== instance.paintedArt) {
				instance.paintedArt = art;
				feedback.art = art;
			}
		}

		// Stream Deck redraws on every setFeedback call, so unchanged frames
		// are dropped here instead of being sent down the wire.
		if (Object.keys(feedback).length === 0) return;

		void instance.dial.setFeedback(feedback).catch((err) => {
			instance.paintedPanel = undefined;
			instance.paintedArt = undefined;
			logger.warn(`setFeedback failed: ${String(err)}`);
		});
	}

	#describe(instance: Instance): void {
		const rotate = instance.settings.rotate ?? "volume";
		const label: Record<string, string> = {
			volume: "Volume",
			track: "Previous / next",
			seek: "Scrub",
			none: "",
			toggle: "Play / pause",
			next: "Next track",
			prev: "Previous track",
			mute: "Mute"
		};

		void instance.dial
			.setTriggerDescription({
				rotate: label[rotate],
				push: label[instance.settings.press ?? "toggle"],
				touch: label[instance.settings.touch ?? "next"],
				longTouch: label[instance.settings.longTouch ?? "prev"]
			})
			.catch((err) => logger.warn(`setTriggerDescription failed: ${String(err)}`));
	}

	// -- animation ----------------------------------------------------------

	/**
	 * Chooses a repaint rate, or stops repainting entirely.
	 *
	 * Three things move without any event to announce them: scrolling text, the
	 * progress bar, and the volume readout timing out. Nothing moves while
	 * playback is stopped and every line fits, and in that state the dial should
	 * cost nothing.
	 */
	#retune(): void {
		let rate = 0;
		const now = Date.now();

		for (const instance of this.#instances.values()) {
			const face = this.#face(instance, bridge.state, now);

			// An idle panel is a single static line; there is nothing to move.
			if (face.message !== undefined) continue;

			const scrolling =
				overflows(face.title, 15, PANEL_W) ||
				overflows(face.artist, 12.5, PANEL_W) ||
				overflows(face.album, 11, PANEL_W);

			if (scrolling || now < instance.volumeUntil) {
				rate = ANIMATE_MS;
				break;
			}
			if (face.status === "playing" && face.duration) rate = Math.max(rate, 0) || IDLE_MS;
		}

		if (rate === this.#tickerRate) return;
		this.#tickerRate = rate;
		this.#stopTicker();
		if (rate > 0) {
			this.#ticker = setInterval(() => {
				for (const instance of this.#instances.values()) this.#paint(instance);
				// Re-evaluate so the rate drops back once motion finishes.
				this.#retune();
			}, rate);
		}
	}

	#stopTicker(): void {
		if (this.#ticker) clearInterval(this.#ticker);
		this.#ticker = undefined;
	}
}

export const ART_PX = ART_SIZE;
