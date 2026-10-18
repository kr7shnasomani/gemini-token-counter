(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	GC.DOM = Object.freeze({
		// The text box, Gemini's own custom element. Every composer variant seen has it.
		CHAT_INPUT: 'rich-textarea',
		// The rounded input card (a flex row) and the plain block inside it that holds
		// the text field. The usage row goes last in that block, so the card grows to
		// take it, as the Claude extension's row does in Claude's composer.
		INPUT_AREA: 'input-area-v2',
		INPUT_AREA_BODY: 'input-area-v2 .input-area',
		// The card's container: the fallback, right under the card.
		INPUT_CONTAINER: '.input-area-container',
		// Top-right of every chat: Gemini's own actions (Listen, the conversation menu),
		// fixed to the window. The export button goes beside the menu.
		TOP_BAR: 'top-bar-actions',
		TOP_BAR_RIGHT: 'top-bar-actions .right-section',
		// The chat column. The token chip is held to its top left, where the Claude
		// extension puts it beside the title; Gemini shows no title there.
		CHAT_COLUMN: '.main-content',
		// The sidebar's own button, fixed over the column's top left when the
		// sidebar is closed. The chip keeps clear of it.
		SIDE_NAV_BUTTON: '.side-nav-menu-button',
		// Set on a reply's text while it is being written (seen 2026-10-18). It flickers
		// to false for a moment as the reply starts, so its end is debounced.
		BUSY: 'model-response [aria-busy="true"]',
		// The account chip at the bottom of the sidebar. A paid plan adds a tier label
		// ("Pro"); a free account has the chip and no label.
		ACCOUNT_INFO: '.mavatar-user-info',
		TIER_LABEL: '.mavatar-tier-label'
	});

	GC.SETTINGS_KEY = 'gc:settings';
	GC.DIAG_KEY = 'gc:diag';
	GC.SNAPSHOT_KEY = 'gc:usageSnapshot';

	// This file is also loaded by the popup, so what both sides need lives here once.

	GC.getStorage = () => {
		try {
			return globalThis.chrome?.storage?.local || null;
		} catch {
			return null;
		}
	};

	GC.storageGet = async (key) => {
		try {
			return (await GC.getStorage()?.get(key)) || null;
		} catch {
			return null;
		}
	};

	/** The signed-in account a path belongs to: `/u/1/app` is account 1, no prefix is 0. */
	GC.accountFromPath = (pathname) => (String(pathname || '').match(/^\/u\/(\d{1,2})(?:\/|$)/) || [])[1] || '0';

	/**
	 * Usage from the `jSf9Qc` RPC (the one Gemini's own /usage page calls), as
	 * `{ session, weekly }` windows of `{ utilization: 0-100, resets_at: ISO }`, or null.
	 * Shape seen 2026-10-18 on a Pro and a free account alike:
	 * `[2, [[remaining, fractionUsed, kind, [[epochSeconds, nanos]]], ...], false]`,
	 * kind 1 the 5-hour "Current usage" window and kind 2 the weekly one. The
	 * fraction is what Gemini's page shows as "% used". Other kinds (4 exists on
	 * Pro) are not shown on that page and are ignored here.
	 */
	GC.parseUsage = (data) => {
		const list = Array.isArray(data?.[1]) ? data[1] : [];
		const out = { session: null, weekly: null };
		for (const entry of list) {
			if (!Array.isArray(entry)) continue;
			const key = entry[2] === 1 ? 'session' : entry[2] === 2 ? 'weekly' : null;
			const ratio = entry[1];
			// A shape drift that still passed `!= null` once rendered NaN% elsewhere.
			if (!key || typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) continue;
			const seconds = entry[3]?.[0]?.[0];
			const ms = typeof seconds === 'number' ? seconds * 1000 : NaN;
			out[key] = {
				utilization: Math.round(ratio * 1000) / 10,
				resets_at: Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null
			};
		}
		return out.session || out.weekly ? out : null;
	};

	/**
	 * Has this window's reset already passed? Then its figure is not old but wrong:
	 * the window has rolled over. One rule for the page and the popup.
	 */
	/**
	 * The payload of `rpc` in a batchexecute answer, or null. The same reader as the
	 * bridge's `frames()` (which runs in the page world and cannot load this file):
	 * the body is `)]}'` then length-prefixed chunks whose lengths cannot be sliced
	 * by, so the top-level arrays are found by bracket matching. The popup uses it;
	 * `test/bridge.test.js` checks the two agree.
	 */
	GC.batchAnswer = (text, rpc) => {
		const arrays = [];
		let depth = 0;
		let inStr = false;
		let esc = false;
		let start = -1;
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (esc) { esc = false; continue; }
			if (inStr) {
				if (c === '\\') esc = true;
				else if (c === '"') inStr = false;
				continue;
			}
			if (c === '"') inStr = true;
			else if (c === '[') {
				if (depth === 0) start = i;
				depth++;
			} else if (c === ']' && depth > 0 && --depth === 0) {
				try {
					arrays.push(JSON.parse(text.slice(start, i + 1)));
				} catch {
					// one malformed chunk is skipped, not the whole answer
				}
			}
		}
		const hit = arrays.flat().find((e) => Array.isArray(e) && e[0] === 'wrb.fr' && e[1] === rpc);
		if (!hit || typeof hit[2] !== 'string') return null;
		try {
			return JSON.parse(hit[2]);
		} catch {
			return null;
		}
	};

	GC.windowEnded = (w) => !!w?.resets_at && Date.parse(w.resets_at) <= Date.now();

	/**
	 * The window running now, given a reading whose reset may have passed. Gemini's
	 * windows do not wait for a message to start (Claude's 5-hour one does): they
	 * are a fixed grid that rolls on whether or not you chat. Seen 2026-10-19 on a Pro
	 * account: the hourly window resets every 5 hours on the dot (07:16:50, 02:16:50…),
	 * the weekly one on the same :16:50 grid, and a window 3 minutes old read 0%.
	 * So an ended window is followed at once by the next, empty, ending one length
	 * later; that is shown rather than "unknown", and the next read confirms it.
	 */
	GC.currentWindow = (w, key) => {
		if (!w || !GC.windowEnded(w)) return w;
		const length = key === 'weekly' ? GC.CONST.WEEKLY_WINDOW_MS : GC.CONST.SESSION_WINDOW_MS;
		const ended = Date.parse(w.resets_at);
		const next = ended + (Math.floor((Date.now() - ended) / length) + 1) * length;
		return { utilization: 0, resets_at: new Date(next).toISOString(), rolled: true };
	};

	// The last few errors the extension swallowed, for bug reports. Plain strings,
	// never page content.
	const recentErrors = [];
	GC.noteError = (where, err) => {
		const message = String(err?.message || err).replace(/(["'`]).*?\1/g, '$1…$1').slice(0, 80);
		const text = `${where}: ${message}`;
		if (recentErrors[recentErrors.length - 1] === text) return;
		recentErrors.push(text);
		if (recentErrors.length > 5) recentErrors.shift();
	};
	GC.recentErrors = () => recentErrors.slice();

	// Every on-page element the popup can switch off. All on by default.
	GC.SETTINGS_DEFAULTS = Object.freeze({
		tokenCounter: true,
		exportButton: true,
		sessionBar: true,
		weeklyBar: true,
		usageRefresh: true
	});

	GC.CONST = Object.freeze({
		// How long the reply flag must stay down before the reply counts as finished:
		// it drops for a few milliseconds as a reply starts (seen 2026-10-18).
		REPLY_SETTLE_MS: 1200,
		// The reply can be finished on screen a moment before the server returns it.
		REPLY_RETRY_MS: 2000,
		// A chat with no count yet is looked at again this often, this many times.
		EMPTY_REFRESH_MS: 5000,
		EMPTY_REFRESH_MAX: 6,
		// Usage is asked again this often while a tab is visible.
		USAGE_POLL_MS: 5 * 60 * 1000,
		// A usage answer that still carries a window which already ended is asked again.
		USAGE_ROLLOVER_RETRY_MS: 30000,
		// Nominal window lengths. Google's help page "Gemini Apps limits & feature
		// availability" says the limit "refreshes every 5 hours until you reach your
		// weekly limit"; no payload states a duration. Used only to place the
		// elapsed-time marker, which hides itself when a reading contradicts them.
		SESSION_WINDOW_MS: 5 * 60 * 60 * 1000,
		WEEKLY_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
		// The reset time is the server's clock and Date.now() the browser's; a margin
		// so ordinary skew is not taken as proof the nominal length is wrong.
		WINDOW_NOMINAL_TOLERANCE_MS: 5 * 60 * 1000
	});
})();
