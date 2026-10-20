(() => {
	'use strict';

	// Shared with the content script: constants.js is loaded first by popup.html.
	const GC = globalThis.GeminiCounter;
	const ISSUES_URL = 'https://github.com/kr7shnasomani/gemini-token-counter/issues/new';
	const DRAFT_KEY = 'gc:feedbackDraft';
	// GitHub does not publish its limit; long links fail at around 8 KB.
	const MAX_ISSUE_URL = 7000;
	const GEMINI_ORIGIN = 'https://gemini.google.com';
	// An account with no reading for this long is forgotten, email and all: one
	// signed out of the browser would otherwise stay in the picker for good.
	const FORGET_ACCOUNT_MS = 30 * 24 * 60 * 60 * 1000;

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

	/** The elapsed-time marker, as on the page (`GC.windowElapsed`). */
	function placeMarker(el, resetMs, key) {
		const at = GC.windowElapsed(resetMs, key);
		el.hidden = typeof at?.pct !== 'number';
		if (!el.hidden) el.style.left = `${at.pct}%`;
	}

	/** One limit's row; true if it had a reading. A row without one keeps its slot. */
	function renderWindow(win, key) {
		const row = document.getElementById(`${key}Row`);
		const valueEl = document.getElementById(`${key}Value`);
		const fillEl = document.getElementById(`${key}Fill`);
		const resetEl = document.getElementById(`${key}Reset`);
		const markerEl = document.getElementById(`${key}Marker`);
		const blank = (sub) => {
			valueEl.textContent = '\u2014';
			resetEl.textContent = sub;
			fillEl.style.width = '0';
			fillEl.classList.remove('caution', 'warn');
			row.classList.add('item--stale');
			markerEl.hidden = true;
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
		const level = GC.usageLevel(pct);
		fillEl.classList.toggle('caution', level === 'caution');
		fillEl.classList.toggle('warn', level === 'warn');
		placeMarker(markerEl, Date.parse(win.resets_at), key);
		return true;
	}

	/** What the picker calls an account: its email, or its number when the page gave none
	    (the path's is 0-based, `/u/1` is the second; people count from one). */
	const accountName = (snap) => snap?.email || `Account ${Number(snap?.account || 0) + 1}`;

	// --- account picker ---------------------------------------------------------
	// Every account a Gemini tab has read usage for has its own stored reading. The
	// account shown is always named, on every view; with more than one, the person
	// picks which, and it is never switched for them. The pick is remembered.

	const menu = () => document.getElementById('accountMenu');
	const menuButton = () => document.getElementById('accountBtn');
	const picking = () => Object.keys(accounts).length > 1;

	/** The shown account: its plan chip and its name in the picker. */
	function renderPicker() {
		const chip = document.getElementById('plan');
		chip.textContent = current?.plan || '';
		chip.title = current?.plan || '';
		chip.hidden = !current?.plan;
		const row = document.getElementById('accountRow');
		row.hidden = !current;
		// With one account there is nothing to pick: the name shows, and nothing
		// tells a screen reader it opens a menu.
		row.classList.toggle('account--single', !picking());
		if (picking()) {
			menuButton().setAttribute('aria-haspopup', 'menu');
			menuButton().setAttribute('aria-expanded', String(!menu().hidden));
		} else {
			menuButton().removeAttribute('aria-haspopup');
			menuButton().removeAttribute('aria-expanded');
		}
		if (row.hidden || !picking()) closeMenu(false);
		if (row.hidden) return;
		document.getElementById('accountName').textContent = accountName(current);
		const list = Object.values(accounts).sort((a, b) => Number(a.account) - Number(b.account));
		menu().replaceChildren(...list.map((snap) => {
			const item = document.createElement('button');
			item.type = 'button';
			item.className = 'menu__item';
			item.setAttribute('role', 'menuitemradio');
			item.setAttribute('aria-checked', String(snap.account === current?.account));
			item.dataset.account = snap.account;
			const name = document.createElement('span');
			name.className = 'menu__name';
			name.textContent = accountName(snap);
			const plan = document.createElement('span');
			plan.className = 'menu__plan';
			plan.textContent = snap.plan || '';
			item.append(name, plan);
			return item;
		}));
	}

	function openMenu() {
		menu().hidden = false;
		menuButton().setAttribute('aria-expanded', 'true');
		(menu().querySelector('[aria-checked="true"]') || menu().firstElementChild)?.focus();
	}

	function closeMenu(refocus) {
		if (menu().hidden) return;
		menu().hidden = true;
		menuButton().setAttribute('aria-expanded', 'false');
		if (refocus) menuButton().focus();
	}

	function pickAccount(account) {
		if (!accounts[account]) return;
		current = accounts[account];
		Promise.resolve(storage.set({ [GC.POPUP_ACCOUNT_KEY]: account })).catch(() => {});
		closeMenu(true);
		// Settings and feedback stay open; only the usage view has figures to swap.
		if (panel === 'usage') render();
		else renderPicker();
	}

	function wirePicker() {
		menuButton().addEventListener('click', () => {
			if (!picking()) return;
			if (menu().hidden) openMenu();
			else closeMenu(true);
		});
		menu().addEventListener('click', (e) => {
			const item = e.target.closest('.menu__item');
			if (item) pickAccount(item.dataset.account);
		});
		menu().addEventListener('keydown', (e) => {
			// What role="menu" promises a keyboard user: arrows move, Tab leaves.
			if (e.key === 'Tab') {
				e.preventDefault();
				closeMenu(true);
				return;
			}
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
			e.preventDefault();
			const items = [...menu().children];
			const at = items.indexOf(document.activeElement);
			items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
		});
		document.addEventListener('click', (e) => {
			if (!document.getElementById('accountRow').contains(e.target)) closeMenu(false);
		});
	}

	/** The line under the limits: how old the figures are, plus what a refresh just did. */
	function setStatus(problem) {
		const el = document.getElementById('stamp');
		const parts = [];
		if (problem) parts.push(problem);
		if (current?.updatedAt) parts.push(formatStamp(current.updatedAt));
		el.textContent = parts.join('. ');
		el.classList.toggle('status--problem', Boolean(problem));
		el.title = current?.account && current.account !== '0' ? `gemini.google.com/u/${current.account}` : '';
	}

	/** The usage view for the account shown (`current`). */
	function render() {
		const empty = document.getElementById('empty');
		const content = document.getElementById('content');
		renderPicker();
		const showEmpty = () => {
			empty.hidden = false;
			content.hidden = true;
			setStatus('');
		};
		if (!current) return showEmpty();

		const hasSession = renderWindow(current.session, 'session');
		const hasWeekly = renderWindow(current.weekly, 'weekly');
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
		// An account no longer signed in is sent to another one's page: not its figures.
		if (prefix && page.url && !new URL(page.url).pathname.startsWith(`${prefix}/`)) return { signedOut: true };
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
		return { data: GC.batchAnswer(await res.text(), 'jSf9Qc'), email: GC.pageEmail(html) };
	}

	async function refresh() {
		const button = document.getElementById('refresh');
		// aria-disabled rather than disabled: a disabled button drops keyboard focus.
		if (button.getAttribute('aria-disabled') === 'true') return;
		button.classList.add('icon--busy');
		button.setAttribute('aria-disabled', 'true');
		document.getElementById('content').setAttribute('aria-busy', 'true');
		// The account shown at the click. The person can pick another while this runs,
		// and what this refresh says belongs under this account only.
		const account = /^\d{1,2}$/.test(current?.account) ? current.account : '0';
		const say = (problem) => {
			if (!current || current.account === account) setStatus(problem);
		};
		try {
			if (!(await requestHostAccess())) {
				say('Refreshing needs access to Gemini');
				return;
			}
			const { signedOut, data, email } = await fetchUsage(account);
			if (signedOut) {
				say('Sign in to Gemini to refresh');
				return;
			}
			const parsed = GC.parseUsage(data);
			if (!parsed) throw new Error('no usage');
			// Merged into that account's own reading, never into whichever is shown now.
			// The email is this page's: an old one could belong to an account since signed out.
			const fresh = { ...accounts[account], account, email, session: parsed.session, weekly: parsed.weekly, updatedAt: Date.now() };
			// Saved before it is shown, so a failed save leaves the old figures, as "Couldn't refresh" says.
			await storage.set({ [GC.snapshotKey(account)]: fresh });
			accounts[account] = fresh;
			if (!current || current.account === account) current = fresh;
			if (panel === 'usage') render();
			else renderPicker();
		} catch {
			// Keep how old the figures on screen are; only add that this try failed.
			say("Couldn't refresh");
		} finally {
			button.classList.remove('icon--busy');
			button.removeAttribute('aria-disabled');
			document.getElementById('content').removeAttribute('aria-busy');
		}
	}

	// --- panels -----------------------------------------------------------------

	const PANELS = {
		usage: { title: 'Usage limits' },
		settings: { title: 'Settings', panel: 'settings', button: 'settingsBtn' },
		feedback: { title: 'Send feedback', panel: 'feedback', button: 'feedbackBtn' }
	};

	let panel = 'usage';

	/** Settings and feedback replace the usage view under the top bar, with a back arrow by their title. */
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
			render();
			// Back where the person left from: the button that opened the panel.
			if (from !== 'usage') document.getElementById(PANELS[from].button).focus();
		} else {
			document.getElementById('content').hidden = true;
			document.getElementById('empty').hidden = true;
			renderPicker();
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
	// Each account's stored reading, by its number in the path.
	const accounts = {};
	if (!storage) {
		render();
		return;
	}

	Promise.resolve(storage.get(null))
		.then((items) => {
			const forgotten = [];
			for (const [key, snap] of Object.entries(items || {})) {
				if (!key.startsWith(`${GC.SNAPSHOT_KEY}:`) || !/^\d{1,2}$/.test(snap?.account)) continue;
				if (!(Date.now() - (snap.updatedAt || 0) < FORGET_ACCOUNT_MS)) forgotten.push(key);
				else accounts[snap.account] = snap;
			}
			if (forgotten.length) Promise.resolve(storage.remove(forgotten)).catch(() => {});
			// The account picked last time, else the one read most recently.
			current = accounts[items?.[GC.POPUP_ACCOUNT_KEY]]
				|| Object.values(accounts).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]
				|| null;
			render();
		})
		.catch(() => {
			render();
			setStatus("Couldn't read saved usage");
		});

	document.getElementById('back').addEventListener('click', () => showPanel('usage'));
	document.addEventListener('keydown', (e) => {
		// Escape closes the account menu, then steps back to usage; only from there
		// does it close the popup.
		if (e.key === 'Escape' && !menu().hidden) {
			e.preventDefault();
			closeMenu(true);
		} else if (e.key === 'Escape' && panel !== 'usage') {
			e.preventDefault();
			showPanel('usage');
		}
	});
	document.getElementById('refresh').addEventListener('click', () => {
		if (panel !== 'usage') showPanel('usage');
		refresh();
	});
	wirePicker();
	wireSettings();
	wireFeedback();
})();
