# Now Playing — Stream Deck + plugin

Turns a Stream Deck + dial into a now playing display: album art, track, artist
and album, with a live progress bar. Press to play or pause, tap for next, hold
for previous, and turn for volume, track skip or scrubbing.

It is **source-agnostic by design**. Rather than integrating with Spotify, TIDAL
and Plex separately, it reads the Windows **System Media Transport Controls**
(SMTC) — the same layer behind the popup you get when pressing a media key. Any
player that reports to SMTC works with no per-app code:

| Source | Works | Notes |
| --- | --- | --- |
| TIDAL (desktop) | Yes | Verified, including artwork |
| Spotify (desktop) | Yes | |
| Plexamp (desktop) | Yes | Electron app, reports to SMTC |
| Plex / TIDAL / Spotify in a browser | Yes | Edge, Chrome and Firefox all publish sessions |
| Apple Music, Media Player, foobar2000, MusicBee, VLC | Yes | |
| Plex HTPC (the Qt/mpv desktop app) | Unconfirmed | Does not reliably publish an SMTC session |
| Anything cast to another device | **No** | See below |

### The one real limitation

SMTC only describes audio playing **on this PC**. If you cast from Plex or
Plexamp to a speaker, a phone or another machine, nothing is playing locally, so
there is nothing for the dial to show. Covering that would need per-service
network APIs (the Plex API, Spotify Connect, and so on), which is a different
and much larger piece of work.

## Layout

```
┌──────────────┬───────────────────────┐
│              │ Making A Killing      │
│  album art   │ Phantom Planet        │
│    88×88     │ Phantom Planet        │
│              │ ▬▬▬▬▬▬▭▭▭▭            │
│              │ ▌▌ 1:35        2:40   │
└──────────────┴───────────────────────┘
        200 × 100 encoder panel
```

Lines that do not fit scroll back and forth rather than being truncated, because
truncation tends to remove exactly the part that distinguishes one version of a
track from another.

## Architecture

```
Stream Deck  ──ws──  plugin.js (Node)  ──stdio JSON──  SmtcBridge.exe (.NET)
                                                            │
                                                     SMTC + Core Audio
```

The Windows work lives in a **separate executable**, not in the Node process.
Two reasons:

1. The plugin runs on the Node runtime Stream Deck ships and controls. A native
   in-process addon would be pinned to that runtime's ABI.
2. The available npm SMTC binding is **read-only** — it can report what is
   playing but cannot play, pause or skip. Transport control needs WinRT
   directly, and per-app volume needs Core Audio, neither of which it exposes.

The bridge pushes whole state snapshots as newline-delimited JSON, and accepts
commands on stdin. Artwork is sent only when it changes and cached by hash on
the plugin side, since covers run 40–200 KB and would otherwise dominate the
pipe.

### Position extrapolation

SMTC republishes the timeline only on discrete events, so the raw position sits
still for seconds while audio plays. Every snapshot carries a `positionAt`
timestamp, and the plugin advances the position from it. Without this the
progress bar moves in visible jumps.

## Building

```powershell
npm install
npm run all        # bridge (dotnet publish) + icons + rollup bundle
npm run validate   # Elgato schema check
npm test           # unit tests
npm run smoke      # drives the real sidecar, asserts transport + art
node tools/harness.mjs   # full end-to-end: fake Stream Deck, real plugin
```

`npm run smoke` and `tools/harness.mjs` briefly start playback and nudge system
volume, restoring both afterwards.

To install for development:

```powershell
streamdeck link com.dswett.nowplaying.sdPlugin
streamdeck restart com.dswett.nowplaying
```

### Two build settings that are not optional

`bridge/SmtcBridge.csproj` sets `BuiltInComInteropSupport` and pins a
`RuntimeHostConfigurationOption`. Trimming otherwise disables built-in COM, and
Core Audio then fails **silently** — volume reads a flat zero and per-app volume
disappears, with no error. Trimming takes the sidecar from 94 MB to 14 MB, so it
is worth keeping, but not without that switch.

`bridge/NuGet.config` scopes the feed to the Microsoft package proxy. The
machine-level config points at an Azure DevOps feed that returns 401, and
`api.nuget.org` is blocked by Defender network protection.

## Testing

`tools/harness.mjs` impersonates Stream Deck over the plugin websocket protocol:
it registers the plugin, sends `willAppear` for an encoder, and inspects the
`setFeedback` frames that come back. This means the rendering and interaction
paths are verifiable without rearranging a physical profile.
