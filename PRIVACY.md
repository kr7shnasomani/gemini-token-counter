# Privacy Policy for Gemini Token Counter

**Last updated:** October 20, 2026

## Overview

Gemini Token Counter is an independent extension, not affiliated with, endorsed or sponsored by Google. It operates entirely within your browser. It does not collect, transmit, or store any personal data on external servers.

## Data Accessed

### Your Gemini session
The extension uses the sign-in you already have on `gemini.google.com`. To make the same requests Gemini's own pages make, it reads three values the Gemini page itself carries: its request token (`SNlM0e`), its session id (`FdrFJe`) and its build label (`cfb2h`). They are read fresh for each request and sent only in requests to `gemini.google.com`. The request token and session id are never stored or sent anywhere else; the build label is also kept in the layout diagnostics described below, so a bug report you choose to file can name Gemini's version. The extension reads no cookies itself.

### Network Requests
The extension makes requests exclusively to `gemini.google.com`, through the same endpoint Gemini's web app uses (`/_/BardChatUi/data/batchexecute`), and only for two things:
- **Your usage limits** (`jSf9Qc`), the same request Gemini's usage page makes, to show your 5-hour and weekly limits
- **The open conversation** (`hNvQHb`), for the token count and for export

When you press refresh in the toolbar popup, the popup also loads Gemini's app page (`https://gemini.google.com/app`, or `/u/N/app` for another signed-in account) to read the request token and the account's email from it, then makes the same usage request.

No data from these responses is ever sent to any external server.

### Website Content
The extension reads the open conversation, your account's plan label from the sidebar (for example "Pro"), the signed-in account's email address from the Gemini page's own data (to name the account in the popup), and the page's own reply-in-progress marker, for the purposes of token counting, usage display, and chat export. This data is processed locally and never transmitted externally.

### Chat Export
The export feature converts the open conversation into a Markdown or plain-text file that is saved directly to your device via the browser's download mechanism. No conversation content is sent to any external server during export.

## Data Storage

The extension uses `chrome.storage.local` (browser-local storage) for these purposes:

- **Usage snapshots** — For each signed-in Google account you use Gemini with, its latest usage reading (the two windows' percentages and reset times), its plan name, its number in the address (such as `1` for `/u/1`) and its email address, saved so the toolbar popup can display them without a Gemini tab open and let you pick which account to show. The email is read from the Gemini page you are on (and from Gemini's app page when you refresh from the popup); it is shown only in the popup, never put in the layout diagnostics or a bug report, and never sent anywhere. An account with no new reading for 30 days is deleted, email and all, the next time the popup opens. No token count or conversation content is stored.
- **Popup account choice** — Which account you last picked in the popup, by its number.
- **User settings** — A single settings object recording which on-page elements you have switched off, persisted so preferences survive page reloads and browser restarts.
- **Layout diagnostics** — A small record of how the extension sits on the Gemini page: Gemini's build label, the theme, which of Gemini's page anchors were found, your plan label, which of the extension's elements are currently showing, where the last usage reading came from, which of your settings are switched off, the signed-in account's number, and the last few error messages from the extension itself. It holds no conversation id or conversation content. It exists only so a bug report you choose to file can say what went wrong; it is never sent anywhere by the extension. The feedback form shows it to you inside the prefilled GitHub issue (all of it except the account's number, which stays out of reports), and nothing is submitted unless you submit it.
- **Bug-report draft** — The feedback form in the popup saves draft text as you type so it is not lost if the popup is closed, and clears it once the issue is opened.

All stored data remains on your device. The extension does **not** use:
- `localStorage` or `sessionStorage`
- Any remote database or analytics service

## Third Parties

This extension does not integrate any third-party analytics, advertising, or tracking services. It bundles two third-party files, both used locally: the `gpt-tokenizer` library (MIT licensed, by Bazyli Brzoska) for token counting, and the Google Sans Flex font (SIL Open Font License) so the popup has Gemini's typeface offline. On the Gemini page itself the text and icons use the fonts Gemini has already loaded. The extension fetches no fonts or other files from anywhere.

## External Servers

This extension makes **no requests** to any server outside of `gemini.google.com`. No data ever leaves your browser to any server controlled by the extension author. A bug report opens a prefilled page on `github.com` in a new tab only when you ask for one, and is sent only if you submit it there.

## Changes to This Policy

Any updates to this policy will be reflected in this file on the GitHub repository with an updated date at the top.

## Contact

For questions or concerns, open an issue on the [GitHub repository](https://github.com/kr7shnasomani/gemini-token-counter).
