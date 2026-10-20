# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                        # every suite via test/run.js
node test/page.test.js          # one suite (each file runs standalone)
npm run lint                    # eslint .
```

There is **no build step**. Load the repo root as an unpacked extension and reload
it after editing; content script changes need an extension reload, not just a page
refresh. Chromium only (Chrome 111+): there is no Firefox build.

`.npmrc` sets `ignore-scripts=true` and CI installs with `npm ci --ignore-scripts`.
Do not install packages without asking first: this project ships no runtime
dependencies and that is deliberate.

## Two halves, two JavaScript worlds

Gemini's RPCs need the page's CSRF token, `window.WIZ_global_data.SNlM0e`, which a
content script cannot see. So:

- `src/injected/bridge.js` runs in the **page's own world** (manifest `world: "MAIN"`,
  `document_start`). It makes the two read-only RPCs below, reading the token and
  build label fresh on every call (the token rotates in a long session).
- `src/content/*.js` runs in the **isolated content-script world** and owns all UI.

The only channel is `window.postMessage`, tagged `gc: 'GeminiCounter'`, matched by
request id. Both sides check `event.source === window` and the origin, and address
their messages to Gemini's origin (the bridge `window.location.origin`, the content
script the fixed `https://gemini.google.com`), never `'*'`. The bridge accepts only its own two request
kinds (an own-property lookup, so `toString` is not a handler) and validates the
conversation id against `ID_PATTERN` before it goes into a request.

## How Gemini was read (2026-10-18, build `boq_gemini-web-uiserver_20261016.00_p0`)

Everything is `POST /_/BardChatUi/data/batchexecute?rpcids=…` (prefixed `/u/N` for
the Nth signed-in account), form body `f.req=[[[rpc, JSON payload, null, "generic"]]]`
and `at=<SNlM0e>`. The answer is `)]}'` then length-prefixed chunks; the lengths are
not usable for slicing, so `frames()` finds the top-level arrays by bracket
matching. The payload is the third field of the `["wrb.fr", rpc, "<json>"]` entry,
JSON inside a string.

- **`jSf9Qc`, usage** (what Gemini's own `/usage` page calls). Payload `[]`. Answer
  `[2, [[remaining, fractionUsed, kind, [[epochSec, nanos]]], …], false]`. Kind 1 is
  "Current usage" (refreshes every 5 hours), kind 2 the weekly limit; the fraction
  is exactly what the usage page shows as "% used". Kind 4 also appears on Pro and is
  not shown by Gemini's page, so it is ignored. **Free accounts get real figures**
  here (unlike claude.ai's free tier), so there is no "send a message first" state.
- **`hNvQHb`, a conversation.** Payload `["c_<hex id>", pageSize, pageToken, 1, [1], [4], null, 1]`.
  Answer `[turns, nextPageToken, …]`, turns **newest first**, paged: Gemini's own
  call uses 10; the bridge uses 50 and follows the token. Turn layout is documented
  at the top of `src/content/conversation.js`. Positional arrays, no field names:
  every read goes through `at()` so a moved field reads as missing, never throws.
- **Sending a message does not use batchexecute.** It goes over a WebChannel on
  `geminiweb-pa.clients6.google.com/v1/processSession`, which the extension does not
  touch. The end of a reply is taken from the DOM instead (below).
- `cCSu7` returns the user's saved personal context (name, family, location). It is
  not read, and must not be.

## Things that are not obvious and will bite

**Reply end is a DOM signal, debounced.** Gemini sets `aria-busy="true"` inside the
reply (`GC.DOM.BUSY`, `model-response [aria-busy="true"]`) while writing it. The flag drops to false
for a few milliseconds as the reply starts, then rises again, so the end is the
flag staying down for `REPLY_SETTLE_MS`. During the thinking phase it is false as
well. A one-word reply can raise and drop it between two looks, so the observer
reads the mutation records' old values too. After the end, the conversation is
re-read, and once more after `REPLY_RETRY_MS` if the server does not yet have the
new turn or the read failed. Whether the flag's dip during thinking triggers an early,
extra re-read has not been checked on a live thinking model. A reply that ends in Gemini's "Sorry, something went wrong" is saved as a
turn with that text.

**Navigation is polled.** Angular moves between chats with `pushState`, which a
content script cannot hear. `tick()` compares `location.pathname` every second
(plus `popstate` for back and forward); cheaper and harder to break than patching
history in the page world.

**Reads that race.** Several things read the same chat (a reply's end, its retry,
the empty-chat re-read, every 5s up to 6 times); `readSeq` lets only the newest set
the count. A usage refresh asked for while one is out joins it and runs once more
after (the read out may predate a reply). A failed usage read leaves the figures but
marks them old (`gc-usageRow--stale`, the tooltip says from when) and a manual refresh
that failed turns its button red. A chat longer than one read (40 pages of 50, or
45s, `READ_DEADLINE_MS` in the bridge) comes back `truncated`: the chip reads "≥ N
tokens" and the export says older turns are not included. A repeated page token
ends the read. The tokenizer counts text that merely mentions `<|endoftext|>` and
the like as text (`disallowedSpecial: new Set()`); by default it throws, and the
message counted 0.

**Claude's parts and layout, Gemini's look.** The parts, their places and their
words are the Claude extension's: the chip at the top left, the usage row in the
input card ("Hourly: 67% (resets in 4h 1m)", the weekly group mirrored, refresh at
the end), the elapsed-time marker, the export button by the top-right menu, the
context popover. Do not move, merge or relabel them; a Gemini
redesign of the layout (pill bars with Gemini's usage-page labels, the count inside
the row) was tried and rejected. How they *look* is Gemini's (asked for on
2026-10-18): Google Sans Flex at `wdth` 92, the chip as Gemini's 36px "Get app"
pill, bars round as its usage page draws them but filled in Gemini blue with the
marker in the text colour (its page's white fill hid a blue marker, 2026-10-19),
its tooltip, its menu surface (radius 20, 8px in, rows radius 12 with
a 20px leading icon), its round icon buttons with a hover state layer, and Gemini's own icons: its
symbol font "Luminous Symbols" (`download`, `refresh`, `article`, `notes`), drawn via
`::before { content: attr(data-glyph) }` once the font is loaded, with a matching
SVG until then (`symbolIcon`). The tooltip is light in dark mode on purpose: that
is Gemini's own (#e6e6e6 on #171717, measured on its Dictate button). The focus
ring is Gemini's too: 1px in `--mat-focus-indicator-border-color`, no offset. The only
part left out is the cache timer, on purpose (decided 2026-10-19): Google publishes no
cache lifetime for the Gemini app, its pages carry no cache signal, and nothing says
a cached turn uses less of the limit. The only figure found is for the API (Gemini
4 Argon's developer guide: 15-20 minutes for prompts sharing 6,144 tokens or more),
which is not the app. Add it only once measured: `jSf9Qc` gives each limit's
remaining units, so a short message right after a reply versus one 30 minutes later
in a long chat would show whether caching saves anything, and for how long.

**The popup is a page of Google's own settings, not the Claude extension's popup.**
Two earlier designs were rejected on 2026-10-19: Gemini's usage page drawn small
(badly structured), then a compact Gemini menu (13px rows; "pathetic"). Four mockups
followed and the user chose "grouped settings", Material 3 Expressive grouped lists
as Google's current settings draw them: a 320px popup on Gemini's page colour
(#faf9f9 / #0f0f0f) padded 8px 12px 12px; a 48px top bar (24px icon, "Gemini Token
Counter" 18px weight 500, the plan as a tonal chip); under it the account picker,
then, as the Claude extension's "USAGE LIMITS" line, "Usage limits" as a 14px weight-500 heading in
Gemini blue (`primary`) with refresh, settings, feedback as 32px round buttons at
its end; the two limits as one group of rows on the input card's colour
(#f0f4f9 / #1e1f20), 2px apart, the group's outer corners 20px and inner ones 4px;
each row "Current usage" 15px weight 500 / "N% used" muted, an 8px round bar
with the page's elapsed-time marker (2px, text colour, hidden when the reading
contradicts the nominal length), "Resets at 2:16 AM" 13px muted; "Updated just now" 12px muted, centred under the group. Its
words are the usage page's ("Current usage", not the chip's "Hourly"). The logo,
name and actions stay on every view, as in the Claude extension; settings and
feedback replace what is under them, the open panel's button lit, a back arrow
before the blue title ("Settings", "Send feedback"). Escape goes back, focus moves into the panel
and back to its button. Settings are five 48px rows in one group, no
sub-headings (removed on request), with Material 3's switch scaled to 40x24 (its own
52x32 read too heavy; `role="switch"`). Feedback is a 20px-radius field on the row colour and 40px pill
buttons, "Open issue" as in the Claude extension. A missing window keeps its row ("—", "Not reported yet"); a
refresh that failed says so in full colour before the age of the figures, in a
`role="status"` line. There is no link to the usage page (removed on request).
Google Sans Flex is bundled (`src/vendor/google-sans-flex-latin.woff2`, OFL, Latin
only, cut to width 92, weights 400-540, optical sizes 12-14; 104 KB) and pinned by
hash in `THIRD_PARTY_NOTICES.md`, so the popup has Gemini's type offline; a weight
outside 400-540 or a non-Latin character falls back to system-ui. The content
script does not need it: Gemini's page already loads the font.

**Where things are placed.** The chip goes where the Claude extension puts it,
the top left of the chat. Gemini has no title there (the title is only in the
sidebar), so it sits alone: held in `.main-content`, level with the top bar's
buttons and clear of the sidebar's own button, which floats over the column's top
left when the sidebar is closed (`_alignChip`, every tick). The **export button**
goes beside the top-right controls, as Claude's does: a sibling right before the
right section's last child (the container holding the menu). Not first in that
section: an empty upsell container sits first, and the section's 12px gap on both
sides of it made a 28px hole beside the menu (seen 2026-10-18). Percentages are
whole numbers.

The usage row goes **inside the input card**, on its own line under the text field,
so the card grows to hold it, as the Claude extension's row does in Claude's
composer. The card, `input-area-v2`, is a flex row; its one child `.input-area` is a
plain block, and the row is appended last there (`in-card`, look
`.gc-usageRow--inCard`, insets measured against the "+" and mic buttons). Do not
append to `input-area-v2` itself: in a flex row the row would sit beside the field.
Without that block it falls back to right under `.input-area-container`, above the
"Gemini is AI and can make mistakes" line (`container`), then after `input-area-v2`,
then after any ancestor of `rich-textarea` shaped like a card. Under the card, the
row's container is wider than the card, so its `max-width` is set to the card's width
every tick. If the chip or the usage row has something to show but is not painted
for three ticks, it is floated as a pill (`.gc-floating`) and its real place retried
every 30s. The export button does not float: with no top bar it sits beside the chip
(`export=chip` in reports). It shows for a chat with turns, the chip only for one with
a count. The plan is re-read every tick while it reads FREE, since the sidebar's
account chip can render before its tier label.
None of this has a real-layout test; it needs a real page.

**The plan comes from the sidebar.** `.mavatar-tier-label` reads "Pro" (or Ultra,
Plus) on a paid account; a free account has the account chip
(`.mavatar-user-info`) and no label, which reads as FREE. No chip yet means the plan
is unknown, not free. No RPC was found that states the plan.

**Colours come from Gemini.** Gemini sets its design tokens on `body.theme-host`
(`--lumi-sys-color--*`, `--lumi-sys-elevation--level1`, `--gem-sys-color--*`) and
switches them itself under `.dark-theme`, so `styles.css` reads them with Gemini's
dark values as the fallback and has no theme rules of its own. Which token is
which was measured on 2026-10-18: menu surface `surface-bright` (#1f1f1f / #fff),
hover `states--hover-on-surface`, text `on-surface` (#e6e6e6 / #000), muted
`on-surface-variant` (55%), tooltip `on-surface` on `surface-dim`. Light was checked
by dropping `dark-theme` on a real page. If Gemini renames its tokens the fallbacks
keep dark working; light would then need values.

**Context sizes in the popover are sourced.** The popover is the Claude
extension's table (a model per row, a plan per column; no "Model" row), from two
Google pages checked 2026-10-19. The window is set by plan, not model ("Gemini Apps
limits & feature availability", support.google.com/gemini/answer/16275805: no plan
32K, AI Plus 128K, AI Pro and Ultra 1M). Which models each plan has is
gemini.google/subscriptions: no plan Flash-Lite, Plus Flash, Pro and Ultra Argon,
Pro and Flash; Flash-Lite is on paid plans too (the limits page sends a subscriber
at a limit to it). No Google page gives a per-model window for the app; blogs
disagree, so do not use them. Re-check when models or plans change.

**The count is an estimate and says so.** `o200k_base` (OpenAI's tokenizer, vendored
from the Claude extension, pinned by hash in `THIRD_PARTY_NOTICES.md`) over prompts,
replies (minus the `immersive_entry_chip` placeholder URLs) and documents. Thinking
summaries, uploaded files (only their names reach the page) and images are not
counted.

**Usage windows.** No payload states a window's length; the elapsed-time marker
infers the start as `resets_at - nominal` (5 h / 7 d) and latches itself hidden the
first time a reading has meaningfully more time left than that
(`WINDOW_NOMINAL_TOLERANCE_MS`). Unlike Claude's, Gemini's windows do not wait for a
message to start: they are a fixed grid that rolls on regardless (seen 2026-10-19 on
Pro: the 5-hour window resets on the dot every 5 hours, the weekly on the same :16:50
grid, and a window 3 minutes old read 0%). So a window whose reset has passed is not
"unknown": `GC.currentWindow` replaces it with the next, empty, ending one length
later, in the page, the snapshot seed and the popup, and usage is read to confirm
it. Showing "—" there (as the Claude extension does) left the hourly figure blank
until a manual refresh. Each signed-in account has its own stored snapshot
(`gc:usageSnapshot:N`), seeded only on that account's pages.

**The popup refreshes on its own.** With the optional host permission it fetches
`/u/N/app`, takes `SNlM0e`, `cfb2h` and `FdrFJe` from the inline page data, and
calls `jSf9Qc` itself; it keeps the account's email (`oPEP7c`) from that page, or
none, never an older one. A `/u/N` that Google sends to another account's page
(an account since signed out) is refused, not stored as N. The fetch of the app page is about 800 KB; it happens only on
a click.

**A number on screen must belong to what is on screen.** Each of these once did
not, or would not have, and `page.test.js` pins them. A navigation clears the count
before reading the new chat, so a failed read cannot leave the last chat's figure on
this one. A read that finishes after the user moved on, or after a newer read of the
same chat started (`readSeq`), is dropped. The stored usage snapshot is seeded only
on pages of the account it was read on (`/u/N`), so switching account never shows
the other's bars. A window that has ended is replaced by the next, empty one
(`GC.currentWindow`), never shown as "resets in 0s" and never left blank. A usage
read that failed keeps the last figures but marks them old (`gc-usageRow--stale`,
the tooltip says from when), rather than presenting them as current. A chat too
long to read whole reads "≥ N tokens", a floor rather than a figure.

**The extension must stay visible whatever Gemini does.** `ui._ensureShown()` runs
every tick: a chip or usage row that has something to show but has not been painted
for three ticks is lifted onto `document.body` and floated as a pill
(`.gc-floating`), and its real place is tried again every 30 seconds. It never
floats on a guess: with no layout to ask (`getClientRects` absent, as in the test
shim) a part counts as painted. It floats only where there is a chat (a
`rich-textarea` on the page), and is taken down on leaving for a page without one.
The export button is not floated; it moves beside the chip instead. A DOM observer
re-attaches everything Gemini's re-renders remove, at most once a second with one
retry, since it runs on every mutation batch and a streaming reply sends hundreds.

**Everything hoverable uses one tooltip, Gemini's.** One shared `.gc-tooltip` node
serves the chip, the export and refresh buttons and both usage groups, shown after
`TOOLTIP_DELAY_MS` (300ms) and fading in 120ms, placed below things in the top half
of the window and above things in the composer. While shown it is the owner's
`aria-describedby`, so a screen reader hears it with the control. A tooltip that
offers an action (the chip's "Click for details") is interactive: it stays while
the pointer is on it (`TOOLTIP_GRACE_MS` to cross the gap) and clicking it does the
action. Do not give a tooltip a click cue without that. The export menu and the
context popover use Gemini's menu surface; Escape and an outside click close them,
the menu takes focus when it opens and hands it back, and the popover closes when
focus leaves the chip for anything but the popover.

**Export.** The conversation is read fresh on export, so the file has the reply that
just finished. It holds every turn oldest first: the time, the prompt, attachment
names and types (their content never reaches the page), the reply on screen (the
draft whose id is `turn[3][3]`, not the alternatives), and each document the reply
made in full (`draft[30]`, Deep Research and Canvas). Thinking summaries are left
out. Gemini puts `googleusercontent.com/immersive_entry_chip/N` placeholders in the
reply where a document chip sits; they are removed (`cleanReply`), in the count too.
Blank lines are tidied between blocks only, never inside one, so code keeps its own.
A read with nothing readable in it throws, and the button shows its error state
rather than doing nothing. Filenames keep letters and digits of any script.

**Bug reports carry diagnostics.** `ui.getDiagnostics()` plus the build label, plan,
usage source and account number are published to `gc:diag` (their own key, so a
report has them even before any usage was read), every fifth tick when they change.
The popup turns them into report lines: Gemini's build label (`cfb2h`, the only
version name Gemini's web app has), the theme, where the chip, export button and
usage row landed (`chip=column|floating|none`, `export=topbar|topbar-host|chip`,
`composer=in-card|container|input-area|shape`), which parts are painted, where usage
came from, what floated, what is switched off, and the last five errors. Errors are
cut to 80 characters with anything in quotes blanked (`GC.noteError`), since a
parser error quotes the text it choked on. The account number is in `gc:diag` but
not in the report. Nothing in it is an id or conversation text.

## Popup and settings

The popup is a separate document and cannot read the content script's memory, but
it loads `src/content/constants.js` ahead of `popup.js`, so the storage keys,
settings defaults, `GC.parseUsage`, `GC.currentWindow` and the batchexecute reader
(`GC.batchAnswer`) exist once and are shared, not mirrored. The content script
mirrors each usage reading into `gc:usageSnapshot:N` with its account, email and
time; the popup renders one, so it works from any tab. **The account picker** is a
40px pill under the top bar (Gemini's model-picker shape) naming the shown account by
email, on every view, from the first reading (asked for: the email always shows). With
two or more accounts it opens a Gemini menu with a check on the shown one; with one it
has no chevron and does nothing. Settings are one set for all accounts
(`gc:settings`); picking an account on the settings view leaves it open. The person
picks; the popup never switches on its own. The pick is kept
in `gc:popupAccount`; before any pick it shows the newest reading. Refresh reads the
account shown at the click and merges into that account's own reading, even if
another is picked while it runs. An account with no reading for 30 days is deleted
when the popup opens (`FORGET_ACCOUNT_MS`), so a signed-out account's email does not
linger. The email comes from the page's inline data (`"oPEP7c"`, beside
`SNlM0e`, `GC.pageEmail`), read from `document.scripts` by the content script and from
the fetched app page by the popup; with none, it reads "Account N+1" (`/u/1` is "Account 2";
people count from one). It is
personal data: kept in local storage only, never in `gc:diag` or a report (a page test
checks `gc:diag`, and a popup test the issue URL a report actually opens), and PRIVACY.md says so. Settings (`gc:settings`) are written by
the popup and applied by `ui.applySettings()` through `storage.onChanged`, so open
tabs change without a reload. Visibility is decided by settings **and** data: a
setting never reveals a part with nothing behind it. A setting that fails to save
springs back. The feedback draft (`gc:feedbackDraft`) is saved as it is typed and
cleared once the issue opens; a report too long for a URL is cut, and then kept.

**The version lives in three places**: `manifest.json`, `package.json` and
`package-lock.json`. `test/packaging.test.js` fails if they disagree.

## Tests

`test/harness.js` runs the shipped files in Node against a small DOM shim. Selectors
are not parsed: an element is told which selectors it answers to
(`el.answers('top-bar-actions')`) and `querySelector`/`closest` look for that, so a
suite builds the page shape it needs (`geminiPage()` is the 2026-10-18 one). The shim
has no layout, so a part always counts as painted there.

`test/fixtures/` holds real responses (see its README). Their reset times are fixed,
so a test that runs usage through `main.js` uses `liveUsage()`, which moves them to
now. `page.test.js` runs every content script and `main.js` with a fake bridge;
`bridge.test.js` runs the real bridge against a fake fetch speaking Gemini's envelope,
and checks the popup's reader (`GC.batchAnswer`) agrees with it; `popup.test.js` runs
`popup.js` on a page built from `popup.html`'s ids (the account picker and its keys,
picking, forgetting, refresh including one with another account picked mid-flight,
its failures, and the URL a bug report opens); `parsing.test.js`
covers turn parsing and counting against a real conversation; `packaging.test.js`
the version and icon files; `security.test.js` is a guard (no eval or innerHTML,
permissions unchanged, the bridge can call exactly the two read RPCs, actions pinned,
lockfile hashed). Timer tests wait with `waitFor`, never a fixed sleep, so a busy CI
machine does not fail them.

## What the suites cannot reach

Where things sit on Gemini's page, and whether they are painted, needs real layout,
and the shim has none: it can prove an element exists and carries `gc-hidden`,
never that it is visible. Selectors are declared, not matched, so a typo in
`GC.DOM` would be copied into a test and still pass. Check on a real page: Brave,
`gemini.google.com/u/1` (Pro) or `/u/0` (free), with the extension reloaded in
`brave://extensions`. To try a change without reloading, a build of `constants.js`
and `ui.js` can be pasted into the page with the `gc-` prefix renamed (`gp-`), so it
does not clash with the installed copy; Gemini's CSP blocks loading it from a local
server, but allows `eval` of pasted code. Light mode can be checked by removing
`dark-theme` from `body` (Gemini's tokens switch with it). Nothing here runs in CI.

## Permissions

`storage` only, with `https://gemini.google.com/*` as an *optional* host permission
for the popup. Content scripts run on `https://gemini.google.com/*` only. Widening
this is a product decision, and the security suite asserts the current values.
