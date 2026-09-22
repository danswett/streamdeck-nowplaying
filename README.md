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

When nothing is playing the dial switches to a **second layout** that gives the
whole 200×100 canvas to one centred line:

```
┌────────────────────────────────────────┐
│                  ♪                     │
│           Nothing playing              │
└────────────────────────────────────────┘
```

Reusing the playing layout here meant an empty 88px art tile sitting beside a
line of small text crammed into the remaining 104px, which reads as a plugin
that has crashed rather than one that is simply idle. The message shrinks
through a set of sizes and truncates only as a last resort, so a pinned player
with a long name still fits. A pinned player that is closed is named — "Waiting
for Plexamp" — rather than reported as a generic error.

## Volume

The dial moves **the displayed player's own slider in the Windows volume mixer**
— the same slider you get under Settings → System → Sound → Volume mixer. It
never touches the system master. A dial captioned "TIDAL" changing the volume of
the whole machine would be actively misleading, so there is deliberately no
fallback: `Audio` exposes no setter for the system endpoint at all, which makes
the behaviour impossible to regress into.

Finding the right mixer entry is the awkward part. SMTC identifies apps by
AppUserModelID, which has no supported mapping back to a process:

| Reported id | Process that owns the audio |
| --- | --- |
| `com.squirrel.TIDAL.TIDAL` | `TIDALPlayer.exe` |
| `308046B0AF4A39CB` | `firefox.exe` |
| `Spotify.exe` | `Spotify.exe` |

`AppIdentity` resolves the known players explicitly and falls back to matching
the id's own segments against running process names, in both prefix directions,
so helper processes still match. Every matching session is adjusted, since
browsers and Electron players commonly hold more than one.

A player that has released its audio stream has no mixer entry — the mixer UI
shows nothing for it either — so the dial reports `NO MIXER` and does nothing,
rather than showing a misleading 0%. Expired sessions are skipped for the same
reason. Inactive ones are kept, which is why a recently paused player is still
adjustable.

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

`npm run smoke` and `tools/harness.mjs` briefly start playback and adjust the
player's mixer volume, restoring both afterwards. Neither touches system volume.

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

If `dotnet restore` fails in `bridge/`, copy `bridge/NuGet.config.example` to
`bridge/NuGet.config`. A plain clone needs no such file — the default nuget.org
feed is fine — but a machine whose inherited configuration points at a private
feed needs the `<clear />` it provides. The file is gitignored so a local
override is never committed.

## Testing

`tools/harness.mjs` impersonates Stream Deck over the plugin websocket protocol:
it registers the plugin, sends `willAppear` for an encoder, and inspects the
`setFeedback` frames that come back. This means the rendering and interaction
paths are verifiable without rearranging a physical profile.
