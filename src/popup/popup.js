(() => {
	'use strict';

	// Shared with the content script: constants.js is loaded first by popup.html.
	const GC = globalThis.GeminiCounter;
	const ISSUES_URL = 'https://github.com/kr7shnasomani/gemini-token-counter/issues/new';
	const DRAFT_KEY = 'gc:feedbackDraft';
	// GitHub does not publish its limit; long links fail at around 8 KB.
	const MAX_ISSUE_URL = 7000;
	const GEMINI_ORIGIN = 'https://gemini.google.com';

	const sameDay = (a, b) => a.toDateString() === b.toDateString();
	const clock = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	const day = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

	/** In the usage page's words: "Resets at 2:16 AM" today, "Resets Oct 22 at 8:16 PM" later. */
	function formatReset(iso) {
		const ms = Date.parse(iso);
		if (!Number.isFinite(ms)) return '';
		const d = new Date(ms);
		return sameDay(d, new Date()) ? `Resets at ${clock(d)}` : `Resets ${day(d)} at ${clock(d)}`;
	}

	/** "Updated just now" / "Updated 12 min ago" / "Updated at 1:02 AM" / "Updated Oct 18 at 9:40 PM". */
	function formatStamp(ms) {
		const minutes = Math.floor((Date.now() - ms) / 60000);
		if (minutes < 1) return 'Updated just now';
		if (minutes < 60) return `Updated ${minutes} min ago`;
		const d = new Date(ms);
		return sameDay(d, new Date()) ? `Updated at ${clock(d)}` : `Updated ${day(d)} at ${clock(d)}`;
	}

	/** One limit's row; true if it had a reading. A row without one keeps its slot. */
	function renderWindow(win, key) {
		const row = document.getElementById(`${key}Row`);
		const valueEl = document.getElementById(`${key}Value`);
		const fillEl = document.getElementById(`${key}Fill`);
		const resetEl = document.getElementById(`${key}Reset`);
		const blank = (sub) => {
			valueEl.textContent = '\u2014';
			resetEl.textContent = sub;
			fillEl.style.width = '0';
			fillEl.classList.remove('caution', 'warn');
			row.classList.add('item--stale');
		};
		if (!win || typeof win.utilization !== 'number') {
			blank('Not reported yet');
			return false;
		}
		// Past its reset the stored figure is over, but the window is not unknown:
		// Gemini's next one has already begun, empty (GC.currentWindow).
		win = GC.currentWindow(win, key);
		const pct = Math.max(0, Math.min(100, win.utilization));
		row.classList.remove('item--stale');
		valueEl.textContent = `${Math.round(pct)}% used`;
		resetEl.textContent = formatReset(win.resets_at);
		// A reading above zero always shows as a dot at least, as Gemini's own bar does.
		fillEl.style.width = pct > 0 ? `max(${pct}%, 4px)` : '0';
		fillEl.classList.toggle('caution', pct >= 75 && pct < 90);
		fillEl.classList.toggle('warn', pct >= 90);
		return true;
	}

	/** The account in the path is 0-based (`/u/1` is the second); people count from one. */
	const accountLabel = (account) => (account && account !== '0' ? `Account ${Number(account) + 1}` : '');

	/** The line under the heading: how old the figures are, plus what a refresh just did. */
	function setStatus(problem) {
		const el = document.getElementById('stamp');
		const parts = [];
		if (problem) parts.push(problem);
		if (current?.updatedAt) {
			const age = formatStamp(current.updatedAt);
			parts.push(problem ? age : [accountLabel(current.account), age].filter(Boolean).join(' \u00b7 '));
		}
		el.textContent = parts.join('. ');
		el.classList.toggle('status--problem', Boolean(problem));
		el.title = current?.account && current.account !== '0' ? `gemini.google.com/u/${current.account}` : '';
	}

	function render(snapshot) {
		const empty = document.getElementById('empty');
		const content = document.getElementById('content');
		const plan = document.getElementById('plan');
		plan.textContent = snapshot?.plan || '';
		plan.title = snapshot?.plan || '';
		plan.hidden = !snapshot?.plan;
		const showEmpty = () => {
			empty.hidden = false;
			content.hidden = true;
			setStatus('');
		};
		if (!snapshot) return showEmpty();

		const hasSession = renderWindow(snapshot.session, 'session');
		const hasWeekly = renderWindow(snapshot.weekly, 'weekly');
		if (!hasSession && !hasWeekly) return showEmpty();

		setStatus('');
		empty.hidden = true;
		content.hidden = false;
	}

	// --- refresh ----------------------------------------------------------------
	// Reading usage means talking to gemini.google.com, which the popup cannot do on
	// install permissions alone. That host access is optional and requested on the
	// first click, so nobody sees a permission warning unless they ask for it.

	async function requestHostAccess() {
		try {
			return !!(await globalThis.chrome?.permissions?.request({ origins: [`${GEMINI_ORIGIN}/*`] }));
		} catch {
			return false;
		}
	}

	/**
	 * The RPC needs the page's CSRF token, which only a Gemini page carries. The app
	 * page's HTML has it inline (`"SNlM0e":"…"`), fresh on every load, so the popup
	 * reads it from there rather than keeping one.
	 */
	async function fetchUsage(account) {
		const prefix = account && account !== '0' ? `/u/${account}` : '';
		const page = await fetch(`${GEMINI_ORIGIN}${prefix}/app`, { credentials: 'include' });
		if (!page.ok) throw new Error(String(page.status));
		const html = await page.text();
		const field = (name) => (html.match(new RegExp(`"${name}":"([^"]+)"`)) || [])[1] || '';
		const at = field('SNlM0e');
		if (!at) return { signedOut: true };
		const query = new URLSearchParams({ rpcids: 'jSf9Qc', 'source-path': `${prefix}/usage`, bl: field('cfb2h'), 'f.sid': field('FdrFJe'), hl: 'en', rt: 'c' });
		const res = await fetch(`${GEMINI_ORIGIN}${prefix}/_/BardChatUi/data/batchexecute?${query}`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
			body: new URLSearchParams({ 'f.req': JSON.stringify([[['jSf9Qc', '[]', null, 'generic']]]), at }).toString()
		});
		if (!res.ok) throw new Error(String(res.status));
		return { data: GC.batchAnswer(await res.text(), 'jSf9Qc') };
	}

	async function refresh() {
		const button = document.getElementById('refresh');
		// aria-disabled rather than disabled: a disabled button drops keyboard focus.
		if (button.getAttribute('aria-disabled') === 'true') return;
		button.classList.add('icon--busy');
		button.setAttribute('aria-disabled', 'true');
		document.getElementById('content').setAttribute('aria-busy', 'true');
		try {
			if (!(await requestHostAccess())) {
				setStatus('Refreshing needs access to Gemini');
				return;
			}
			const account = /^\d{1,2}$/.test(current?.account) ? current.account : '0';
			const { signedOut, data } = await fetchUsage(account);
			if (signedOut) {
				setStatus('Sign in to Gemini to refresh');
				return;
			}
			const parsed = GC.parseUsage(data);
			if (!parsed) throw new Error('no usage');
			current = { ...(current || {}), account, session: parsed.session, weekly: parsed.weekly, updatedAt: Date.now() };
			render(current);
			await storage.set({ [GC.SNAPSHOT_KEY]: current });
		} catch {
			// Keep how old the figures on screen are; only add that this try failed.
			setStatus("Couldn't refresh");
		} finally {
			button.classList.remove('icon--busy');
			button.removeAttribute('aria-disabled');
			document.getElementById('content').removeAttribute('aria-busy');
		}
	}

	// --- panels -----------------------------------------------------------------

	const PANELS = {
		usage: { title: 'Usage limits' },
		settings: { title: 'Show on Gemini', panel: 'settings', button: 'settingsBtn' },
		feedback: { title: 'Send feedback', panel: 'feedback', button: 'feedbackBtn' }
	};

	let panel = 'usage';

	/** Settings and feedback replace the usage view, as a Gemini sub-menu does, with a back arrow. */
	function showPanel(name) {
		const from = panel;
		panel = PANELS[name] ? name : 'usage';
		for (const [key, spec] of Object.entries(PANELS)) {
			if (!spec.panel) continue;
			document.getElementById(spec.panel).hidden = key !== panel;
			document.getElementById(spec.button).setAttribute('aria-expanded', String(key === panel));
		}
		document.getElementById('title').textContent = PANELS[panel].title;
		const onUsage = panel === 'usage';
		document.querySelector('.head').classList.toggle('head--sub', !onUsage);
		document.getElementById('back').hidden = onUsage;
		document.getElementById('stamp').hidden = !onUsage;
		if (onUsage) {
			render(current);
			// Back where the person left from: the button that opened the panel.
			if (from !== 'usage') document.getElementById(PANELS[from].button).focus();
		} else {
			document.getElementById('content').hidden = true;
			document.getElementById('empty').hidden = true;
			document.querySelector(panel === 'feedback' ? '#feedbackText' : '#settings input').focus();
		}
	}

	const togglePanel = (name) => showPanel(panel === name ? 'usage' : name);

	/**
	 * A readable browser name. Brave reports itself as plain Chrome on purpose, so
	 * the user agent alone would file a Brave report as Chrome.
	 */
	async function describeBrowser() {
		const ua = navigator.userAgent;
		let name = 'Unknown browser';
		try {
			if (navigator.brave && (await navigator.brave.isBrave())) name = 'Brave';
		} catch {
			// not Brave
		}
		if (name === 'Unknown browser') {
			if (/\bEdgA?\//.test(ua)) name = 'Edge';
			else if (/\bOPR\//.test(ua)) name = 'Opera';
			else if (/\bVivaldi\//.test(ua)) name = 'Vivaldi';
			else if (/\bChrome\//.test(ua)) name = 'Chrome';
		}
		const version = (ua.match(/(?:Edg|OPR|Vivaldi|Chrome)\/(\d+)/) || [])[1];
		const platforms = { Mac: 'macOS', Win: 'Windows', Linux: 'Linux', Android: 'Android', CrOS: 'ChromeOS' };
		const key = (/(Mac|Win|Linux|Android|CrOS)/.exec(ua) || [])[1];
		return [name, version, platforms[key] && `on ${platforms[key]}`].filter(Boolean).join(' ');
	}

	function runtimeVersion() {
		try {
			return globalThis.chrome?.runtime?.getManifest().version || 'unknown';
		} catch {
			return 'unknown';
		}
	}

	const yn = (v) => (v ? 'yes' : 'no');

	/** The page-side facts a layout bug needs, as report lines. Empty if none yet. */
	function diagLines(d) {
		if (!d || typeof d !== 'object') return [];
		const lines = [
			`Gemini build: ${d.build || 'unknown'}, theme ${d.theme || 'unknown'}`,
			`Layout: chip=${d.chip || 'none'}, export=${d.export || d.header || 'none'}, composer=${d.composer || 'none'}`,
			`Shown: tokens=${yn(d.tokens)} usageRow=${yn(d.usageRow)} export=${yn(d.exportBtn)}`,
			`Usage from: ${d.usageFrom || 'unknown'}`
		];
		if (Array.isArray(d.floating) && d.floating.length) lines.push(`Floating, no place found: ${d.floating.join(', ')}`);
		if (Array.isArray(d.disabled) && d.disabled.length) lines.push(`Turned off in settings: ${d.disabled.join(', ')}`);
		if (Array.isArray(d.errors) && d.errors.length) lines.push(`Errors: ${d.errors.join('; ')}`);
		return lines;
	}

	/**
	 * Opens a prefilled issue rather than posting one: creating issues from here
	 * would mean shipping a GitHub token inside the extension. This way the person
	 * filing it sees exactly what is sent before it goes.
	 */
	async function openIssue() {
		const description = document.getElementById('feedbackText').value.trim();
		if (!description) return;
		const diag = (await GC.storageGet(GC.DIAG_KEY))?.[GC.DIAG_KEY];
		const facts = [
			`Extension: ${runtimeVersion()}`,
			`Browser: ${await describeBrowser()}`,
			`Plan: ${current?.plan || diag?.plan || 'unknown'}`,
			// Nothing at all can mean the extension never ran: a tab open before
			// install is not injected until it is reloaded.
			...(diag || current ? [] : ['Seen on gemini.google.com: no (no Gemini tab has reported since install or reload)']),
			...diagLines(diag)
		];
		// Cut by character, not UTF-16 unit: half an emoji is a lone surrogate, and
		// encodeURIComponent throws on one.
		const cut = (text, n) => Array.from(text).slice(0, n).join('');
		const build = (text) => `${ISSUES_URL}?title=${encodeURIComponent(cut(description.split('\n')[0], 70))}&body=${encodeURIComponent(`${text}\n\n---\n${facts.join('\n')}\n`)}`;
		let sent = description;
		let url = build(sent);
		while (url.length > MAX_ISSUE_URL && sent.length > 1) {
			sent = cut(sent, Math.floor(Array.from(sent).length * 0.9));
			url = build(`${sent}\n\n[cut to fit the link; paste the rest from the extension's feedback box]`);
		}
		window.open(url, '_blank', 'noopener');
		if (sent === description) {
			document.getElementById('feedbackText').value = '';
			storage.remove(DRAFT_KEY);
		}
		showPanel('usage');
	}

	function wireFeedback() {
		const text = document.getElementById('feedbackText');
		const send = document.getElementById('feedbackSend');
		const sync = () => {
			send.disabled = !text.value.trim();
		};
		// A popup closes the moment it loses focus; keep the draft until it is sent.
		GC.storageGet(DRAFT_KEY).then((items) => {
			const draft = items?.[DRAFT_KEY];
			if (typeof draft === 'string' && draft && !text.value) text.value = draft;
			sync();
		});
		let saveTimer = null;
		text.addEventListener('input', () => {
			sync();
			clearTimeout(saveTimer);
			saveTimer = setTimeout(() => Promise.resolve(storage.set({ [DRAFT_KEY]: text.value })).catch(() => {}), 250);
		});
		sync();
		send.addEventListener('click', openIssue);
		document.getElementById('feedbackCancel').addEventListener('click', () => showPanel('usage'));
		document.getElementById('feedbackBtn').addEventListener('click', () => togglePanel('feedback'));
	}

	function wireSettings() {
		const boxes = [...document.querySelectorAll('.opt input[data-key]')];
		GC.storageGet(GC.SETTINGS_KEY).then((items) => {
			const merged = { ...GC.SETTINGS_DEFAULTS, ...(items?.[GC.SETTINGS_KEY] || {}) };
			for (const box of boxes) box.checked = merged[box.dataset.key] !== false;
		});
		for (const box of boxes) {
			box.addEventListener('change', () => {
				const next = {};
				for (const other of boxes) next[other.dataset.key] = other.checked;
				// A setting that did not save springs back, rather than looking saved.
				Promise.resolve(storage.set({ [GC.SETTINGS_KEY]: next })).catch(() => { box.checked = !box.checked; });
			});
		}
		document.getElementById('settingsBtn').addEventListener('click', () => togglePanel('settings'));
	}

	const storage = GC.getStorage();
	let current = null;
	if (!storage) {
		render(null);
		return;
	}

	GC.storageGet(GC.SNAPSHOT_KEY).then((items) => {
		current = items?.[GC.SNAPSHOT_KEY] || null;
		render(current);
	});

	document.getElementById('back').addEventListener('click', () => showPanel('usage'));
	document.addEventListener('keydown', (e) => {
		// Escape steps back to usage first; only from there does it close the popup.
		if (e.key === 'Escape' && panel !== 'usage') {
			e.preventDefault();
			showPanel('usage');
		}
	});
	document.getElementById('refresh').addEventListener('click', () => {
		if (panel !== 'usage') showPanel('usage');
		refresh();
	});
	wireSettings();
	wireFeedback();
})();
