// Runs in the page's own world (manifest: world MAIN, document_start). Gemini's
// RPCs need the page's CSRF token (`WIZ_global_data.SNlM0e`) and build label, which
// only this world can read, and the token rotates during a long session, so it is
// read fresh on every call rather than handed over once.
//
// Two read-only RPCs, the same ones Gemini's own pages call, and nothing else:
//   jSf9Qc  usage limits (Gemini's /usage page)
//   hNvQHb  a conversation's turns, newest first, paged by a token
// Wrapped in an IIFE: top-level names in a page-world script are globals shared
// with the page and every other extension's page-world script.
(() => {
	'use strict';

	const TAG = 'GeminiCounter';
	const TARGET_ORIGIN = window.location.origin;
	// Captured before Gemini's own scripts run, so a wrapper they add is not ours to go through.
	const nativeFetch = window.fetch.bind(window);

	const ID_PATTERN = /^[0-9a-f]{8,64}$/;
	// Page size per request, and a ceiling: 40 pages of 50 is 2,000 turns. A long chat
	// on a slow line also stops at READ_DEADLINE_MS, inside the content script's 60s
	// wait, and says what it has is partial rather than being dropped as a timeout.
	const PAGE_SIZE = 50;
	const MAX_PAGES = 40;
	const READ_DEADLINE_MS = 45000;

	let reqid = Math.floor(Math.random() * 900000) + 100000;

	/**
	 * Every top-level JSON array in a batchexecute response. The body is
	 * `)]}'` then length-prefixed chunks, and the lengths cannot be trusted to
	 * slice by (they count bytes, the text is UTF-16), so the arrays are found by
	 * bracket matching instead, which holds however the chunks are cut.
	 */
	function frames(text) {
		const out = [];
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
					out.push(JSON.parse(text.slice(start, i + 1)));
				} catch {
					// one malformed chunk is skipped, not the whole answer
				}
			}
		}
		return out;
	}

	async function call(rpc, payload) {
		const wiz = window.WIZ_global_data || {};
		if (!wiz.SNlM0e) throw new Error('signed out');
		const prefix = (window.location.pathname.match(/^\/u\/\d{1,2}(?=\/|$)/) || [''])[0];
		reqid += 100000;
		const query = new URLSearchParams({
			rpcids: rpc,
			'source-path': window.location.pathname,
			bl: wiz.cfb2h || '',
			'f.sid': wiz.FdrFJe || '',
			hl: document.documentElement.lang || 'en',
			_reqid: String(reqid),
			rt: 'c'
		});
		const body = new URLSearchParams({
			'f.req': JSON.stringify([[[rpc, JSON.stringify(payload), null, 'generic']]]),
			at: wiz.SNlM0e
		});
		const res = await nativeFetch(`${prefix}/_/BardChatUi/data/batchexecute?${query}`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
			body: body.toString()
		});
		// An error status still carries a body; read as data it would be "no usage".
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const hit = frames(await res.text()).flat().find((e) => Array.isArray(e) && e[0] === 'wrb.fr' && e[1] === rpc);
		if (!hit || typeof hit[2] !== 'string') throw new Error('no answer');
		return JSON.parse(hit[2]);
	}

	/**
	 * A conversation's turns, newest first, following the page token. `truncated`
	 * says older turns are missing: the page or time ceiling was reached first.
	 */
	async function conversation(id) {
		const turns = [];
		const started = Date.now();
		let token = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const data = await call('hNvQHb', [`c_${id}`, PAGE_SIZE, token, 1, [1], [4], null, 1]);
			if (Array.isArray(data?.[0])) turns.push(...data[0]);
			const next = typeof data?.[1] === 'string' && data[1] ? data[1] : null;
			// The same token twice would read the same page again and count it twice.
			if (!next || next === token) return { turns, truncated: false };
			token = next;
			if (Date.now() - started > READ_DEADLINE_MS) break;
		}
		return { turns, truncated: true };
	}

	const HANDLERS = {
		// The build label rides along for bug reports: it is the only version name
		// Gemini's web app has, and only this world can read it.
		usage: async () => ({ data: await call('jSf9Qc', []), build: String(window.WIZ_global_data?.cfb2h || '').slice(0, 80) }),
		conversation: ({ conversationId } = {}) => {
			// It ends up in the request: nothing but the hex id Gemini itself uses.
			if (!ID_PATTERN.test(String(conversationId))) throw new Error('bad id');
			return conversation(conversationId);
		}
	};

	window.addEventListener('message', async (event) => {
		if (event.source !== window || event.origin !== TARGET_ORIGIN) return;
		const data = event.data;
		if (!data || data.gc !== TAG || data.type !== 'gc:request') return;
		const handler = Object.prototype.hasOwnProperty.call(HANDLERS, data.kind) ? HANDLERS[data.kind] : null;
		const reply = (fields) => window.postMessage({ gc: TAG, type: 'gc:response', requestId: data.requestId, ...fields }, TARGET_ORIGIN);
		if (!handler) return reply({ ok: false, error: 'unknown request' });
		try {
			reply({ ok: true, payload: await handler(data.payload) });
		} catch (e) {
			reply({ ok: false, error: String(e?.message || e).slice(0, 80) });
		}
	});
})();
