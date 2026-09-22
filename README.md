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
| Plex HTPC (the Qt/mpv desktop app) | Partly | Metadata, artwork and transport work. It publishes **no position or duration**, and by default runs audio in **WASAPI exclusive mode**, which makes per-app volume impossible — see below |
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
│                                        │
│            Nothing playing             │
│                                        │
└────────────────────────────────────────┘
```

Reusing the playing layout here meant an empty 88px art tile sitting beside a
line of small text crammed into the remaining 104px, which reads as a plugin
that has crashed rather than one that is simply idle. Text only, deliberately:
a decorative glyph beside a single short line made the panel busier than the
state it represents. The message shrinks through a set of sizes and truncates
only as a last resort, so a pinned player with a long name still fits. A pinned
player that is closed is named — "Waiting for Plexamp" — rather than reported as
a generic error.

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

### Artwork

Two things about artwork are not obvious, and both were found against Plex:

- **The declared content type cannot be trusted.** Plex reports
  `image/jpeg,image/jpe,image/jpg`. Embedded verbatim that yields
  `data:image/jpeg,image/jpe,image/jpg;base64,...`, and a data URI parser stops
  at the first comma — so it reads a plain `image/jpeg` payload with no base64
  flag and decodes the remainder as text. The image silently fails to render.
  The type is therefore taken from the bytes' magic number, with the declared
  value used only as a fallback.
- **Players publish far more pixels than the slot needs.** The art slot is
  88×88 layout units, 176px on the device. Plex serves 1280×1280 — about 435 KB
  once base64'd, for every track change. Artwork is scaled to a 192px longest
  edge before it leaves the sidecar, which took that example to 8 KB.

### When per-app volume cannot work

An app rendering in **WASAPI exclusive mode** takes the endpoint for itself and
bypasses the Windows audio engine. Its mixer entry still exists and can still be
set — the value even reads back — but nothing it does reaches the speakers.
Windows' own Volume Mixer slider is equally ineffective for such an app.

Plex HTPC does this by default (`audio-exclusive=yes` in its embedded mpv).
Turning **Settings → Audio → Exclusive Mode** off restores normal per-app
volume.

Rather than show a percentage that does nothing, the dial says so:

```
┌──────────────┬───────────────────────┐
│              │ Fragments of Time     │
│  album art   │ Daft Punk             │
│              │                       │
│              │    EXCLUSIVE MODE     │
│              │   no volume control   │
└──────────────┴───────────────────────┘
```

Exclusive mode is **detected, not inferred**: while one app owns an endpoint,
any other app's shared-mode `IAudioClient::Initialize` fails with
`AUDCLNT_E_DEVICE_IN_USE`. The client is opened and dropped, never started, so
the probe disturbs nothing. The obvious alternative — noticing the endpoint
meter reads zero while a player claims to be playing — would misfire on a quiet
passage or the gap between tracks.

Behaviour is deliberately unchanged: the dial still writes to the mixer entry,
because silently retargeting the system volume instead would be a surprise.

The sidecar can demonstrate all of this rather than leaving it to guesswork:

```powershell
SmtcBridge.exe --diagnose   # SMTC fields and every endpoint's sessions
SmtcBridge.exe --meters     # peak level per endpoint; all-zero means exclusive mode
SmtcBridge.exe --voltest    # halves the app's volume and measures the change
```

If `--meters` shows no signal on any endpoint while a player reports "playing",
the stream is either exclusive-mode or not local at all.

### Players that publish no timeline

Plex's desktop app publishes transport controls and metadata but never a
position or duration. An empty progress bar above two `--:--` placeholders
reads as a fault, so when there is no timeline the row shows the player and its
state instead.

### Sidecar lifecycle

Exactly one sidecar should ever be running. Two would both subscribe to every
media session and both answer commands, and because each holds COM
subscriptions an orphan is expensive rather than merely untidy.

Three things guarantee it:

- **Exits are matched to the child they came from.** `stop()` clears the handle
  before killing, and the exit handler ignores any child that is no longer the
  current one. Without this, `stop()` followed by `start()` races the old
  child's exit event: the restart lands on top of a sidecar that is already
  running, and the pair accumulates one per cycle. This was a real bug — six
  sidecars after a few minutes of page switching.
- **A live child is never replaced silently.** `#spawn()` refuses to start a
  second one.
- **The sidecar watches its host.** stdin EOF is the normal shutdown signal, but
  a host killed abruptly can leave EOF unobserved, so the pid is passed with
  `--parent` and the sidecar exits when that process does.

Stream Deck also sends `willDisappear`/`willAppear` around page and profile
changes, so the sidecar is given a short grace period before being torn down
rather than being stopped and restarted moments later.

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

### Plugin icons

`tools/build-icons.mjs` draws everything from one source, because the list and
the deck follow different rules. Elgato require the category icon and every
action icon — the ones inside the Stream Deck app's
[action list](https://docs.elgato.com/guidelines/stream-deck/plugins#icons) — to
be a monochrome white stroke on a transparent background, and call out colour
and solid backgrounds as incorrect. The key has no such restriction, and is only
seen before the first frame arrives anyway, since the real album art replaces it.

So the mark is emitted twice: `imgs/actions/dial/icon.svg` white and untiled for
the list, `key.svg` tinted and on its tile for the deck. The category icon drops
both the tile and the disc fill — filled, that disc alone covers 78% of the
canvas, which reads as a solid background however clear the corners are.
`tests/marketplace.test.ts` rasterises every list icon and fails on any colour
but white, on inked corners, on coverage above 80%, or on a blank icon. Pixels
rather than markup, so a PNG cannot slip past by having no fills to read.

To install for development:

```powershell
streamdeck link com.bad-duck.nowplaying.sdPlugin
streamdeck restart com.bad-duck.nowplaying
```

### Two build settings that are not optional

`bridge/SmtcBridge.csproj` sets `BuiltInComInteropSupport` and pins a
`RuntimeHostConfigurationOption`. Trimming otherwise disables built-in COM, and
Core Audio then fails **silently** — volume reads a flat zero and per-app volume
disappears, with no error. Trimming takes the sidecar from 94 MB to 14 MB, so it
is worth keeping, but not without that switch.

If `dotnet restore` fails in `bridge/` with `NU1301 ... 401 (Unauthorized)`,
copy `bridge/NuGet.config.example` to `bridge/NuGet.config`. The `<clear />` it
provides drops inherited sources, which is the fix when a machine-level
configuration lists a private feed that cannot authenticate non-interactively.
If nuget.org is *also* unreachable on that machine, replace the feed URL in the
copy with an internal package proxy.

The file is gitignored, so such an override is never committed. A plain clone
needs no NuGet.config at all, and note the failure only appears on a **cold
package cache**: once the packages are cached locally, restore succeeds without
contacting any feed, so a warm machine will not reproduce it.

## Testing

`tools/harness.mjs` impersonates Stream Deck over the plugin websocket protocol:
it registers the plugin, sends `willAppear` for an encoder, and inspects the
`setFeedback` frames that come back. This means the rendering and interaction
paths are verifiable without rearranging a physical profile.
