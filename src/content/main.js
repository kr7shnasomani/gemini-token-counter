(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});
	if (GC.__started) return;
	GC.__started = true;

	/** The open chat's id: `/app/<hex>`, or `/gem/<gem>/<hex>` inside a Gem. */
	function getConversationId() {
		const m = window.location.pathname.match(/\/(?:app|gem\/[^/]+)\/([0-9a-f]{8,64})(?:[/?#]|$)/);
		return m ? m[1] : null;
	}

	const account = () => GC.accountFromPath(window.location.pathname);

	/**
	 * "Pro", "Ultra", "Plus" from the sidebar's account chip; FREE when it has no tier.
	 * The chip can render before its tier label, so FREE is read again every tick
	 * (tick) and upgraded when a label appears.
	 */
	function readPlan() {
		const label = document.querySelector(GC.DOM.TIER_LABEL)?.textContent?.trim();
		if (label) return label.split(/\s+/).pop().toUpperCase().slice(0, 16);
		return document.querySelector(GC.DOM.ACCOUNT_INFO) ? 'FREE' : null;
	}

	let currentConversationId = null;
	let usageState = null;
	let usageIsSeeded = false;
	let usageSource = 'none';
	let lastUsageUpdateMs = 0;
	let lastUsageAttemptMs = 0;
	let usageRead = null;
	let usageRerun = false;
	let expiredRetries = 0;
	let build = null;
	let plan = null;
	const rolloverHandled = { session: null, weekly: null };

	const ui = new GC.ui.CounterUI({ onUsageRefresh: refreshUsage, onExport: exportConversation });
	ui.initialize();

	// --- usage ----------------------------------------------------------------

	function applyUsage(windows, source) {
		if (!windows) return;
		// A window whose reset has passed is over, whichever source sent it; Gemini's
		// next one has already begun, empty (GC.currentWindow), so that is shown.
		for (const key of ['session', 'weekly']) {
			if (GC.windowEnded(windows[key])) windows = { ...windows, [key]: GC.currentWindow(windows[key], key) };
		}
		usageState = windows;
		usageIsSeeded = source === 'snapshot';
		if (!usageIsSeeded) {
			usageSource = source;
			lastUsageUpdateMs = Date.now();
			persistSnapshot(windows);
		}
		ui.setUsage(windows);
	}

	/**
	 * Read usage. Resolves true when a reading was applied, false when it failed,
	 * so the refresh button can say so. A call while a read is out joins it and
	 * asks for one more after it: the read in flight may predate a reply.
	 */
	function refreshUsage() {
		lastUsageAttemptMs = Date.now();
		if (usageRead) {
			usageRerun = true;
			return usageRead;
		}
		usageRead = readUsage().finally(() => {
			usageRead = null;
			if (usageRerun) {
				usageRerun = false;
				refreshUsage();
			}
		});
		return usageRead;
	}

	async function readUsage() {
		let parsed;
		try {
			const answer = await GC.bridge.requestUsage();
			build = typeof answer?.build === 'string' ? answer.build : build;
			parsed = GC.parseUsage(answer?.data);
			if (!parsed) throw new Error('no usage windows');
		} catch (e) {
			GC.noteError('usage', e);
			ui.setUsageStale(lastUsageUpdateMs || null);
			return false;
		}
		// Just after a rollover the server can still answer with the window that
		// ended. The next window is shown in its place (applyUsage); ask again
		// shortly to have it confirmed.
		const expired = ['session', 'weekly'].filter((k) => GC.windowEnded(parsed[k]));
		if (expired.length && expiredRetries++ < 3) setTimeout(refreshUsage, GC.CONST.USAGE_ROLLOVER_RETRY_MS);
		else if (!expired.length) expiredRetries = 0;
		applyUsage(parsed, 'rpc');
		ui.setUsageStale(false);
		return true;
	}

	// --- popup snapshot -------------------------------------------------------
	// The popup is its own document and cannot read this script's memory, so the
	// last reading is mirrored into extension storage, with its own timestamp.

	async function persistSnapshot(windows) {
		const storage = GC.getStorage();
		if (!storage) return;
		try {
			await storage.set({
				[GC.SNAPSHOT_KEY]: { updatedAt: Date.now(), account: account(), plan, session: windows.session, weekly: windows.weekly }
			});
		} catch (e) {
			GC.noteError('snapshot write', e);
		}
	}

	/**
	 * Show the last stored reading at once on load, only this account's. A window
	 * that has not reset is a floor (usage only rises within it); one that has is
	 * shown as the empty window that followed it.
	 */
	async function seedFromSnapshot() {
		const snapshot = (await GC.storageGet(GC.SNAPSHOT_KEY))?.[GC.SNAPSHOT_KEY];
		if (!snapshot || usageState || snapshot.account !== account()) return;
		// One that has reset since is followed by the next, empty: shown as that.
		const usable = (w) => typeof w?.utilization === 'number' && Number.isFinite(Date.parse(w.resets_at));
		const session = usable(snapshot.session) ? GC.currentWindow(snapshot.session, 'session') : null;
		const weekly = usable(snapshot.weekly) ? GC.currentWindow(snapshot.weekly, 'weekly') : null;
		if (session || weekly) applyUsage({ session, weekly }, 'snapshot');
	}

	// --- conversation ---------------------------------------------------------

	let lastTurnCount = 0;
	// A new chat is read the moment it gets its id, often before the server has the
	// reply. A chat that has produced no count is read again a few times (tick).
	let countSeen = false;
	let emptyRefreshes = 0;
	let lastEmptyRefreshMs = 0;

	/** The chat's turns, oldest first; `truncated` when older ones were not read. */
	async function fetchTurns(conversationId) {
		const data = await GC.bridge.requestConversation(conversationId);
		const turns = GC.conversation.parseConversation(data);
		turns.truncated = data?.truncated === true;
		return turns;
	}

	// Several things read the same chat (a reply's end, its retry, the empty-chat
	// re-read); only the newest read may set the count, or a slow older one would
	// land last and take it back down.
	let readSeq = 0;

	async function refreshConversation() {
		const id = currentConversationId;
		const seq = ++readSeq;
		if (!id) {
			ui.setConversationMetrics();
			return null;
		}
		let turns;
		try {
			turns = await fetchTurns(id);
		} catch (e) {
			GC.noteError('conversation', e);
			return null;
		}
		// Navigated away while it loaded, or a newer read was started: not ours to show.
		if (id !== currentConversationId || seq !== readSeq) return null;
		const metrics = GC.conversation.computeMetrics(turns);
		if (metrics.totalTokens > 0) countSeen = true;
		lastTurnCount = turns.length;
		ui.setConversationMetrics({ ...metrics, truncated: turns.truncated });
		return turns;
	}

	/** The title Gemini gives the tab, without its " - Google Gemini" suffix. */
	function chatTitle() {
		return document.title.replace(/\s*[-|]\s*(Google\s+)?Gemini\s*$/i, '').trim() || 'Gemini conversation';
	}

	async function exportConversation(format) {
		const id = currentConversationId;
		if (!id) return;
		// Fresh rather than the last read, so the export has the turn that just finished.
		const turns = await fetchTurns(id);
		// Nothing readable is a failure to show, not a silent no-op.
		if (!turns.some((t) => t.prompt || t.reply || t.docs.length || t.files.length)) throw new Error('nothing to export');
		GC.exportChat.download(turns, chatTitle(), format, { truncated: turns.truncated });
	}

	/**
	 * A reply has finished. Gemini renders it from its own channel and does not
	 * re-read the conversation, so this is what moves the count between page loads.
	 * The server can lag the screen by a moment: if the read does not yet have a new
	 * turn, or failed, it is tried once more.
	 */
	async function handleReplyEnd() {
		const before = lastTurnCount;
		emptyRefreshes = 0;
		refreshUsage();
		const turns = await refreshConversation();
		if (!turns || turns.length <= before) setTimeout(refreshConversation, GC.CONST.REPLY_RETRY_MS);
	}

	/**
	 * Gemini marks a reply in progress with `aria-busy="true"` on its text, an
	 * attribute rather than words, so it holds in every language. The flag drops for
	 * a few milliseconds as a reply starts, so the end is the flag staying down for
	 * REPLY_SETTLE_MS. A one-word reply can raise and drop it between two looks, so
	 * the mutation records are read too.
	 */
	function watchReplies() {
		let busy = false;
		let sawBusy = false;
		let checkTimer = null;
		let settleTimer = null;
		const check = () => {
			checkTimer = null;
			const now = !!document.querySelector(GC.DOM.BUSY);
			if (now) {
				busy = true;
				sawBusy = false;
				clearTimeout(settleTimer);
				settleTimer = null;
				return;
			}
			if (!busy && !sawBusy) return;
			busy = false;
			sawBusy = false;
			clearTimeout(settleTimer);
			settleTimer = setTimeout(() => {
				settleTimer = null;
				if (!document.querySelector(GC.DOM.BUSY)) handleReplyEnd();
			}, GC.CONST.REPLY_SETTLE_MS);
		};
		new MutationObserver((records) => {
			if (records.some((r) => r.type === 'attributes' && (r.oldValue === 'true' || r.target.getAttribute('aria-busy') === 'true'))) sawBusy = true;
			if (!checkTimer) checkTimer = setTimeout(check, 150);
		}).observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['aria-busy'] });
	}

	// --- navigation -----------------------------------------------------------

	let lastPath = null;

	function handleUrlChange() {
		const path = window.location.pathname;
		if (path === lastPath) return;
		lastPath = path;
		const previous = currentConversationId;
		currentConversationId = getConversationId();
		ui.attachUsageLine();
		ui.attachHeader();
		if (currentConversationId === previous) return;
		countSeen = false;
		emptyRefreshes = 0;
		lastEmptyRefreshMs = Date.now();
		lastTurnCount = 0;
		// The last chat's count is not this one's, and would stay if this read failed.
		ui.setConversationMetrics();
		refreshConversation();
	}

	// --- settings -------------------------------------------------------------

	async function loadSettings() {
		ui.applySettings((await GC.storageGet(GC.SETTINGS_KEY))?.[GC.SETTINGS_KEY]);
	}

	globalThis.chrome?.storage?.onChanged?.addListener?.((changes, area) => {
		if (area === 'local' && changes[GC.SETTINGS_KEY]) ui.applySettings(changes[GC.SETTINGS_KEY].newValue);
	});

	// --- diagnostics ----------------------------------------------------------
	// Their own key, so a report carries them even before any usage was read.

	let lastDiag = '';
	function publishDiagnostics() {
		const storage = GC.getStorage();
		if (!storage) return;
		try {
			const diag = { ...ui.getDiagnostics(), build, plan, usageFrom: usageSource, account: account() };
			const text = JSON.stringify(diag);
			if (text === lastDiag) return;
			lastDiag = text;
			Promise.resolve(storage.set({ [GC.DIAG_KEY]: diag })).catch(() => {});
		} catch (e) {
			GC.noteError('diagnostics', e);
		}
	}

	// --- clock ----------------------------------------------------------------

	let ticks = 0;
	function tick() {
		// Angular navigates with pushState, which a content script cannot hear; a
		// look once a second costs nothing and catches every way of changing chats.
		handleUrlChange();
		const now = Date.now();

		// The sidebar can render after the first usage reading; the snapshot is
		// written again once the plan is known, so the popup heading gets it.
		if (!plan || plan === 'FREE') {
			const read = readPlan();
			if (read && read !== plan) {
				plan = read;
				ui.setPlan(plan);
				if (usageState && !usageIsSeeded) persistSnapshot(usageState);
			}
		}

		if (!document.hidden) {
			ui.tick();
			if (ticks++ % 5 === 0) publishDiagnostics();

			if (currentConversationId && !countSeen && emptyRefreshes < GC.CONST.EMPTY_REFRESH_MAX &&
				now - lastEmptyRefreshMs >= GC.CONST.EMPTY_REFRESH_MS) {
				lastEmptyRefreshMs = now;
				emptyRefreshes++;
				refreshConversation();
			}

			if (now - Math.max(lastUsageUpdateMs, lastUsageAttemptMs) >= GC.CONST.USAGE_POLL_MS) refreshUsage();
		}

		// A window that ends while the page is open rolls straight into the next
		// (Gemini's do not wait for a message), and usage is read to confirm it.
		for (const key of ['session', 'weekly']) {
			const w = usageState?.[key];
			const resetMs = w?.resets_at ? Date.parse(w.resets_at) : null;
			if (resetMs && now >= resetMs && rolloverHandled[key] !== resetMs) {
				rolloverHandled[key] = resetMs;
				usageState = { ...usageState, [key]: GC.currentWindow(w, key) };
				ui.setUsage(usageState);
				refreshUsage();
			}
		}
	}

	loadSettings();
	watchReplies();
	window.addEventListener('popstate', handleUrlChange);
	seedFromSnapshot().finally(refreshUsage);
	handleUrlChange();

	// Exposed for tests: this file is one IIFE with no other seam.
	GC.main = {
		tick,
		handleReplyEnd,
		refreshUsage,
		readState: () => ({ usage: usageState, seeded: usageIsSeeded, conversationId: currentConversationId, plan, usageFrom: usageSource })
	};

	setInterval(tick, 1000);
})();
