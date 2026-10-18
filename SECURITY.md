# Security Policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/kr7shnasomani/gemini-token-counter/security/advisories/new)
rather than opening a public issue.

Include the extension version, your browser, and enough detail to reproduce.
You can expect an acknowledgement within a few days.

## What this extension can access

It runs only on `https://gemini.google.com/*`, the one site the browser lists it
as able to access. It requests one permission, `storage`. The popup's own access
to gemini.google.com is optional and requested at the moment you press refresh
there.

Everything runs locally. Nothing is sent anywhere except to gemini.google.com, and
the requests it makes are the same ones the site already makes for itself: your
usage limits (`jSf9Qc`) and the open conversation (`hNvQHb`).

## What is stored

Four keys in local extension storage, never transmitted:

- `gc:usageSnapshot` — the last usage reading, your plan name, and the number of
  the signed-in account it belongs to (`1` for `/u/1`)
- `gc:settings` — which on-page elements you have switched off
- `gc:diag` — Gemini's build label, the theme, which page anchors were found, your
  plan label, which of the extension's elements are showing, where the last usage
  reading came from, the account number, and the last few error messages. No
  conversation ids or text; shown to you in a bug report only if you file one
- `gc:feedbackDraft` — an unsent bug report, cleared once the issue is opened

**No conversation content is stored.** Exports are written straight to a
download and are never uploaded.

## Boundaries in the code

- The page-world bridge accepts messages only from its own window and Gemini's own
  origin, and addresses replies to that origin instead of broadcasting them.
  Nothing in the extension is web-accessible, so no page can load its files
- The bridge answers exactly two kinds of request, looked up as its own properties
  only, so no other RPC can be reached through it
- Conversation ids are checked against Gemini's hex id pattern, and the account
  number against digits only, before either reaches a URL, so a crafted message
  cannot point a request anywhere else
- Gemini's request token is read from the page for each request and sent only to
  gemini.google.com. It is never stored, logged or posted across to the content
  script
- Error messages kept for bug reports are cut to 80 characters with anything in
  quotes blanked, so a message that quotes page text cannot carry it out
- No `eval`, no `new Function`, no `innerHTML` in shipped code. Page text reaches
  the UI as text only
- No credentials are bundled. The feedback button opens a prefilled GitHub issue
  rather than filing one, precisely so no token has to ship inside the extension

`npm test` includes a security suite that fails if any of the above regresses.

## Build and dependency policy

The extension ships **no runtime dependencies**. The only packages in
`package.json` are ESLint and a SARIF formatter, used to test and lint.

- `.npmrc` sets `ignore-scripts=true`, and every CI install runs
  `npm ci --ignore-scripts`, so no dependency can execute code at install time
  on a contributor's machine or in a workflow
- `package-lock.json` pins every package by version and SHA-512 integrity, all
  from the public npm registry
- Every GitHub Action is pinned to a commit SHA rather than a tag, so an action
  cannot be changed underneath a build by repointing its tag
- `npm test` fails if any of the above regresses

## Third-party code

Two files are vendored, each pinned by SHA-256 in `THIRD_PARTY_NOTICES.md`: the
`o200k_base` tokenizer at `src/vendor/o200k_base.js`, and the Google Sans Flex
font for the popup at `src/vendor/google-sans-flex-latin.woff2` (Latin subset). The
extension bundles them and fetches nothing at runtime.

Neither appears in a package manifest, so Dependabot does not watch them; each is
re-pinned by hand when its version changes, and `npm test` fails if a file and its
recorded hash disagree.
