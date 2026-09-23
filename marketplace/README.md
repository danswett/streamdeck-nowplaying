# Marketplace submission

Everything Maker Console asks for, kept beside the product so a submission can
be reproduced rather than reassembled from memory.

Regenerate the images with:

```bash
npm run marketplace
```

Every touch strip in these images is composed by the same `renderPanel` and
`renderIdle` the plugin calls at runtime, placed at the exact rects
`layouts/nowplaying.json` gives the runtime. The listing therefore cannot show
a layout the product does not produce, and a baseline or colour moving in
`src/render.ts` moves it here too. A screenshot would go stale the first time
either changed.

The one thing drawn rather than rendered is the album art, because at runtime
that comes from the player. The covers are obviously synthetic and gallery 1
says where real art comes from.

| File | Purpose | Required size |
|---|---|---|
| `app-icon-288.png` | App icon | 288 × 288 PNG |
| `thumbnail.png` | Thumbnail | 1920 × 960 PNG |
| `gallery-1-panel.png` | Gallery 1 of 4 | 1920 × 960 PNG |
| `gallery-2-controls.png` | Gallery 2 of 4 | 1920 × 960 PNG |
| `gallery-3-volume.png` | Gallery 3 of 4 | 1920 × 960 PNG |
| `gallery-4-players.png` | Gallery 4 of 4 | 1920 × 960 PNG |

Elgato require three gallery items and allow up to ten. Four covers the
questions a buyer actually has: what the strip shows, what the gestures do,
what happens to volume, and whether it works with their player.

The app icon is drawn by `mark()` from `tools/mark.mjs`, which is the same
function `tools/build-icons.mjs` uses for the plugin icon — imported, not
copied, so the store and the preferences pane cannot end up showing different
products.

No video. The guidelines allow one and do not require it.

Product file: `dist/com.bad-duck.nowplaying.streamDeckPlugin`, built by
`npm run pack` and attached to every GitHub release by the release workflow.

---

## Name

```
Now Playing
```

11 characters. No maker name, no price wording, no product category, no special
characters — see [product guidelines](https://docs.elgato.com/guidelines/products).

## Description

The first 250 characters are what search engines show, so the opening sentence
states what the product is before anything can be truncated.

```
Turn a Stream Deck + dial into a now playing display. Album art, track, artist and album for whatever is playing on Windows, with a live progress bar and elapsed time.

Press to play or pause, tap for next, hold for previous, turn for volume, track or scrub. Every one of those four gestures is a setting, so the dial does what you want rather than what it was shipped doing.

Volume drives the displayed player's own mixer entry, never the system slider — a dial captioned TIDAL will not quietly turn down everything on the machine. When that player has released its audio, or holds the device in exclusive mode, the readout says so instead of showing a percentage that reaches nothing.

Long titles scroll rather than truncate, so the part that tells one remaster from another is still readable. Players that publish no timeline show their name and state rather than an empty bar over two placeholders, and a session with no artwork gets a stand-in rather than an empty square.

Works with anything that reports to Windows media controls: Spotify, TIDAL, Plexamp, Apple Music, foobar2000 and browser players all appear without configuration. Pick a specific player or let it follow whatever is in front.

Requires Windows 10 or later, Stream Deck 7.1 or later, and a Stream Deck + or Stream Deck Studio for the dial.
```

1,193 characters, within the 1,500 limit and above the 250 minimum.

Character counts are asserted by `tests/marketplace.test.ts`, which also checks
the copy does not claim a gesture the action does not implement.

## Tags

`media`, `music`, `now playing`, `spotify`, `tidal`, `plexamp`, `apple music`,
`media controls`, `album art`, `volume`, `dial`, `stream deck plus`,
`windows`, `smtc`

## Identity

These must agree, because the `Author` field is shown in both Stream Deck and
Marketplace, and Elgato's guidelines ask for the organization name.

| Where | Value |
|---|---|
| Plugin UUID | `com.bad-duck.nowplaying` |
| Author | Bad Duck Software |
| URL | https://bad-duck.com |
| Support | https://github.com/danswett/streamdeck-nowplaying/issues |

## Pricing

Free.

## Hardware

Stream Deck + and Stream Deck Studio only. The action is a dial with an encoder
layout and has nothing to draw on a plain key, so the manifest declares only
the encoder controller rather than offering an action that would install and do
nothing.

## Release notes

### Version 1.0.0 — the notes for this submission

First release, so the notes describe the plugin rather than what changed.

```
Turn a Stream Deck + dial into a now playing display.

Album art, track, artist and album for whatever is playing on Windows, with a live progress bar. Press to play or pause, tap for next, hold for previous, turn for volume, track or scrub — every gesture is a setting.

Volume drives that player's own mixer entry rather than the system slider, and says so when the player has released its audio or holds the device in exclusive mode.

Works with anything that reports to Windows media controls: Spotify, TIDAL, Plexamp, Apple Music and browser players.
```

555 characters.

---

## Before submitting

- `npm test` — the guideline checks live in `tests/marketplace.test.ts`
- `npm run marketplace` — regenerate, and confirm nothing changed unexpectedly
- `npm run validate` — Elgato's own validator
- `npm run pack` — the product file
- Check the packaged plugin installs and works on a real Stream Deck +

### Trademark

*Spotify*, *TIDAL*, *Plexamp*, *Apple Music* and *foobar2000* belong to their
owners. The listing names them to say what the plugin works with, which is
nominative use. The plugin ships none of their artwork and integrates with none
of them directly — it reads Windows' own media session API, which is why the
list is open-ended rather than a set of supported players.
