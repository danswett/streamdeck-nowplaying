import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import url from "node:url";

import streamDeck from "@elgato/streamdeck";

const logger = streamDeck.logger.createScope("bridge");

export type PlaybackStatus = "playing" | "paused" | "stopped" | "changing" | "opened" | "closed" | "unknown";

export type Session = {
	readonly id: string;
	readonly app: string;
	readonly title: string;
	readonly artist: string;
	readonly album: string;
	readonly albumArtist: string;
	readonly trackNumber: number;
	readonly status: PlaybackStatus;
	readonly canPlayPause: boolean;
	readonly canNext: boolean;
	readonly canPrev: boolean;
	readonly canSeek: boolean;
	readonly positionMs?: number;
	readonly durationMs?: number;
	readonly positionAt: number;
	readonly rate: number;
	readonly artId?: string;
	/** Resolved from the cache; the wire only carries it when it changes. */
	art?: string;
	/** Level of the app's Windows mixer entry, absent when it has none. */
	readonly appVolume?: number;
	readonly appMuted?: boolean;
};

export type State = {
	readonly current?: string;
	readonly volume: number;
	readonly muted: boolean;
	readonly sessions: Session[];
};

export type Command = {
	cmd: "toggle" | "play" | "pause" | "next" | "prev" | "seek" | "volume" | "setVolume" | "mute" | "refresh" | "ping";
	/** Session to act on; the current session when absent. */
	target?: string;
	value?: number;
	delta?: number;
	positionMs?: number;
};

const EMPTY: State = { volume: 0, muted: false, sessions: [] };

/**
 * Owns the SMTC sidecar process.
 *
 * All Windows media access lives in a separate executable, so this class is
 * responsible for keeping exactly one copy alive, translating its newline JSON
 * into state, and making its death survivable.
 */
export class Bridge {
	#child: ChildProcessWithoutNullStreams | undefined;
	#state: State = EMPTY;
	#stopped = false;
	#backoffMs = 500;
	#restartTimer: NodeJS.Timeout | undefined;

	/**
	 * Artwork by id.
	 *
	 * The sidecar sends image bytes only when the art changes, so the plugin
	 * has to hold them: a frame that merely reports a new position still needs
	 * the current art to repaint the LCD.
	 */
	readonly #art = new Map<string, string>();

	readonly #listeners = new Set<(state: State) => void>();

	get state(): State {
		return this.#state;
	}

	get running(): boolean {
		return this.#child !== undefined && this.#child.exitCode === null;
	}

	watch(listener: (state: State) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	start(): void {
		this.#stopped = false;
		this.#spawn();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#restartTimer) clearTimeout(this.#restartTimer);
		this.#restartTimer = undefined;
		// Closing stdin is the sidecar's shutdown signal; kill is the fallback
		// for a process that is already wedged.
		try {
			this.#child?.stdin.end();
		} catch {
			/* already gone */
		}
		this.#child?.kill();
		this.#child = undefined;
	}

	send(command: Command): void {
		const child = this.#child;
		if (!child || child.exitCode !== null) {
			logger.warn(`dropping ${command.cmd}: bridge not running`);
			return;
		}
		try {
			child.stdin.write(`${JSON.stringify(command)}\n`);
		} catch (err) {
			logger.warn(`write failed: ${String(err)}`);
		}
	}

	#executable(): string {
		// Resolved from the bundle rather than cwd: Stream Deck's working
		// directory for a plugin is not contractual, but plugin.js always sits
		// next to the bridge folder.
		const here = path.dirname(url.fileURLToPath(import.meta.url));
		return path.join(here, "bridge", "SmtcBridge.exe");
	}

	#spawn(): void {
		if (this.#stopped) return;

		const exe = this.#executable();
		logger.info(`starting bridge: ${exe}`);

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(exe, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		} catch (err) {
			logger.error(`spawn failed: ${String(err)}`);
			this.#scheduleRestart();
			return;
		}

		this.#child = child;

		createInterface({ input: child.stdout }).on("line", (line) => this.#consume(line));

		child.stderr.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text) logger.warn(`bridge: ${text}`);
		});

		child.on("error", (err) => logger.error(`bridge error: ${err.message}`));

		child.on("exit", (code, signal) => {
			logger.warn(`bridge exited (code=${code}, signal=${signal})`);
			if (this.#child === child) this.#child = undefined;
			this.#publish(EMPTY);
			this.#scheduleRestart();
		});

		// A restarted sidecar has no idea what art this side already holds.
		this.send({ cmd: "refresh" });
	}

	#scheduleRestart(): void {
		if (this.#stopped || this.#restartTimer) return;
		const delay = this.#backoffMs;
		this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
		logger.info(`restarting bridge in ${delay}ms`);
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = undefined;
			this.#spawn();
		}, delay);
	}

	#consume(line: string): void {
		if (!line.trim()) return;

		let message: { type?: string; [key: string]: unknown };
		try {
			message = JSON.parse(line);
		} catch {
			logger.warn(`unparseable frame: ${line.slice(0, 120)}`);
			return;
		}

		switch (message.type) {
			case "state": {
				// A frame arriving means the process is healthy, so the backoff
				// earned by earlier crashes is no longer warranted.
				this.#backoffMs = 500;
				this.#publish(this.#hydrate(message as unknown as State));
				break;
			}
			case "log": {
				const { level, message: text } = message as { level?: string; message?: string };
				if (level === "error") logger.error(`bridge: ${text}`);
				else if (level === "warn") logger.warn(`bridge: ${text}`);
				else logger.info(`bridge: ${text}`);
				break;
			}
			case "ack": {
				const ack = message as { ok?: boolean; error?: string; id?: number };
				if (!ack.ok) logger.warn(`command ${ack.id} failed: ${ack.error ?? "no reason given"}`);
				break;
			}
			default:
				break;
		}
	}

	/** Fills in artwork the sidecar omitted because it was unchanged. */
	#hydrate(state: State): State {
		for (const session of state.sessions) {
			if (!session.artId) continue;
			if (session.art) {
				this.#art.set(session.artId, session.art);
			} else {
				session.art = this.#art.get(session.artId);
			}
		}

		// Keep only art still referenced, so a long session does not accumulate
		// every cover played that day.
		if (this.#art.size > 24) {
			const live = new Set(state.sessions.map((s) => s.artId).filter(Boolean) as string[]);
			for (const id of this.#art.keys()) {
				if (!live.has(id)) this.#art.delete(id);
			}
		}

		return state;
	}

	#publish(state: State): void {
		this.#state = state;
		for (const listener of this.#listeners) {
			try {
				listener(state);
			} catch (err) {
				logger.warn(`listener threw: ${String(err)}`);
			}
		}
	}
}

export const bridge = new Bridge();
