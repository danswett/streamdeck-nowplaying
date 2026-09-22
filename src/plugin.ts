import streamDeck from "@elgato/streamdeck";

import { NowPlayingAction } from "./actions/nowplaying";
import { bridge } from "./smtc/bridge";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new NowPlayingAction());

await streamDeck.connect();

/**
 * The sidecar is a child process, so it dies with the plugin under normal
 * shutdown. These handlers cover the abrupt paths, where an orphan would keep
 * a COM subscription to every media session alive until the user logs out.
 */
const shutdown = (): void => {
	bridge.stop();
	process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => bridge.stop());
