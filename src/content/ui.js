(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	function formatResetCountdown(timestampMs) {
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;
		const hours = Math.floor(totalMinutes / 60);
		if (hours < 24) return `${hours}h ${totalMinutes % 60}m`;
		return `${Math.floor(hours / 24)}d ${hours % 24}h`;
	}

	/** "4 minutes ago", for a figure that could not be refreshed. */
	function formatAgo(ms) {
		const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
		const hours = Math.round(minutes / 60);
		return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	}

	// Shown in the token counter's popover, laid out as the Claude extension's:
	// a model per row, a plan per column. Checked 2026-10-19 against two Google
	// pages. The window is set by plan, not model ("Gemini Apps limits & feature
	// availability", support.google.com/gemini/answer/16275805: no plan 32K, AI Plus
	// 128K, AI Pro and Ultra 1M). Which models a plan has is gemini.google/subscriptions:
	// no plan Flash-Lite; Plus Flash; Pro and Ultra Gemini 4 Argon, Pro and Flash.
	// Flash-Lite is on every paid plan too: the limits page says a subscriber who
	// reaches a limit "can continue your conversation with Flash-Lite". A dash is
	// "not on that plan".
	const CONTEXT_PLANS = ['FREE', 'PLUS', 'PRO', 'ULTRA'];
	const CONTEXT_SIZES = [
		['Flash-Lite', '32K', '128K', '1M', '1M'],
		['Flash', '\u2014', '128K', '1M', '1M'],
		['Pro', '\u2014', '\u2014', '1M', '1M'],
		['Argon', '\u2014', '\u2014', '1M', '1M']
	];

	// One tooltip for the whole UI, drawn to Gemini's own tooltip spec (styles.css).
	const TOOLTIP_DELAY_MS = 300;
	// Long enough to carry the pointer from the element onto its tooltip.
	const TOOLTIP_GRACE_MS = 200;
	let sharedTip = null;
	let tipOwner = null;
	let tipAction = null;
	let tipGraceTimer = null;

	function tipElement() {
		if (!sharedTip) {
			sharedTip = document.createElement('div');
			sharedTip.className = 'gc-tooltip';
			sharedTip.id = 'gc-tooltip';
			sharedTip.setAttribute('role', 'tooltip');
			// A tooltip that offers an action has to be reachable: it stays while the
			// pointer is on it, and clicking it does what it says.
			sharedTip.addEventListener('pointerenter', () => clearTimeout(tipGraceTimer));
			sharedTip.addEventListener('pointerleave', () => hideTip(tipOwner));
			sharedTip.addEventListener('click', (e) => tipAction?.(e));
		}
		if (!sharedTip.parentElement) document.body.appendChild(sharedTip);
		return sharedTip;
	}

	function hideTip(owner) {
		clearTimeout(tipGraceTimer);
		if (!sharedTip || (owner && tipOwner !== owner)) return;
		sharedTip.classList.remove('gc-tooltip--on', 'gc-tooltip--action');
		tipOwner?.removeAttribute?.('aria-describedby');
		tipOwner = null;
		tipAction = null;
	}

	/**
	 * Place a floating box beside `anchor`, kept inside the window: below it by
	 * default when `below`, above otherwise, flipping when there is no room.
	 */
	function placeNear(box, anchor, gap, below = false) {
		box.style.left = '0px';
		box.style.top = '0px';
		const a = anchor.getBoundingClientRect();
		const b = box.getBoundingClientRect();
		const left = Math.max(8, Math.min(a.left + a.width / 2 - b.width / 2, window.innerWidth - b.width - 8));
		const under = a.bottom + gap;
		const over = a.top - b.height - gap;
		let top;
		if (below) top = under + b.height > window.innerHeight - 8 && over >= 8 ? over : under;
		else top = over < 8 ? under : over;
		box.style.left = `${left}px`;
		box.style.top = `${top}px`;
	}

	function showTip(owner, text, hint, action) {
		const tip = tipElement();
		clearTimeout(tipGraceTimer);
		tip.replaceChildren(document.createTextNode(text));
		if (hint) tip.appendChild(Object.assign(document.createElement('span'), { className: 'gc-tooltip__hint', textContent: hint }));
		if (tipOwner && tipOwner !== owner) tipOwner.removeAttribute?.('aria-describedby');
		tipOwner = owner;
		tipAction = action;
		// Read out with its owner while shown.
		owner.setAttribute('aria-describedby', tip.id);
		// Below what sits in the top bar, above what sits in the composer.
		placeNear(tip, owner, 6, owner.getBoundingClientRect().top < window.innerHeight / 2);
		tip.classList.toggle('gc-tooltip--action', !!action);
		tip.classList.add('gc-tooltip--on');
	}

	/**
	 * Explain `element` on hover. With `hint` and `action`, the tooltip carries a
	 * cue ("Click for details") and is itself clickable: the cue is not decoration.
	 */
	function setupTooltip(element, text, hint = '', action = null) {
		if (!element) return;
		element.classList.add('gc-tooltipTrigger');
		let showTimer;
		let pressTimer;
		let hideTimer;
		const hide = () => {
			clearTimeout(showTimer);
			clearTimeout(pressTimer);
			clearTimeout(hideTimer);
			hideTip(element);
		};
		const show = () => showTip(element, typeof text === 'function' ? text() : text, hint, action);

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType !== 'mouse') return;
			clearTimeout(showTimer);
			clearTimeout(tipGraceTimer);
			showTimer = setTimeout(show, TOOLTIP_DELAY_MS);
		});
		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType !== 'mouse') return;
			if (!action) return hide();
			clearTimeout(showTimer);
			clearTimeout(tipGraceTimer);
			tipGraceTimer = setTimeout(() => hideTip(element), TOOLTIP_GRACE_MS);
		});
		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			} else {
				hide(); // a click is its own answer
			}
		});
		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', hide);
		element.addEventListener('focus', () => {
			if (element.matches?.(':focus-visible')) show();
		});
		element.addEventListener('blur', hide);
	}

	/** A usage bar: track, fill and elapsed-time marker. */
	function makeBar() {
		const bar = document.createElement('div');
		bar.className = 'gc-bar';
		const fill = document.createElement('div');
		fill.className = 'gc-bar__fill';
		const marker = document.createElement('div');
		marker.className = 'gc-bar__marker gc-hidden';
		bar.appendChild(fill);
		bar.appendChild(marker);
		return { bar, fill, marker };
	}

	/**
	 * Paint one usage window into its label and bar, as the Claude extension does:
	 * "Hourly: 67% (resets in 4h 1m)". Whole percentages. Returns the reset in ms, or null.
	 */
	function paintWindow(win, label, span, fill) {
		if (typeof win?.utilization !== 'number') {
			span.textContent = `${label}: \u2014`;
			fill.style.width = '0%';
			fill.classList.remove('gc-caution', 'gc-warn');
			return null;
		}
		const resetMs = win.resets_at ? Date.parse(win.resets_at) : null;
		span.textContent = `${label}: ${Math.round(win.utilization)}%${resetMs ? ` (resets in ${formatResetCountdown(resetMs)})` : ''}`;
		const width = Math.max(0, Math.min(100, win.utilization));
		fill.style.width = `${width}%`;
		fill.classList.toggle('gc-caution', width >= 75 && width < 90);
		fill.classList.toggle('gc-warn', width >= 90);
		return resetMs;
	}

	/** Rewrite the "(resets in ...)" tail of a usage label as the clock moves. */
	function retimeReset(span, resetMs) {
		const text = span?.textContent;
		const idx = resetMs && text ? text.indexOf('(resets in') : -1;
		if (idx !== -1) span.textContent = `${text.slice(0, idx + '(resets in '.length)}${formatResetCountdown(resetMs)})`;
	}

	const SVG_NS = 'http://www.w3.org/2000/svg';

	/** Build an icon through the DOM, so no markup is ever parsed from a string. */
	// Drawn light and round, as Gemini's own icons are (its symbol font at weight
	// 300-320 with full rounding): a thin stroke with round ends and joins.
	function svgIcon(className, size, shapes, strokeWidth = 1.6) {
		const svg = document.createElementNS(SVG_NS, 'svg');
		const base = {
			class: className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
			'stroke-width': String(strokeWidth), 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
			width: String(size), height: String(size), 'aria-hidden': 'true'
		};
		for (const [name, value] of Object.entries(base)) svg.setAttribute(name, value);
		for (const [tag, attrs] of shapes) {
			const shape = document.createElementNS(SVG_NS, tag);
			for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value);
			svg.appendChild(shape);
		}
		return svg;
	}

	// Gemini draws its icons with its own symbol font, "Luminous Symbols", which it
	// loads on every page (seen 2026-10-19: its "Download PDF" item is the `download`
	// glyph at opsz 20, wght 320; the top bar's at opsz 24, wght 300). Ours use the
	// same glyphs, so they are Gemini's icons, not lookalikes. The glyph is drawn by
	// `::before { content: attr(data-glyph) }` (styles.css), so no icon name lands
	// in the page's text. Until the font is known to be loaded, and on a page where
	// it never is, the SVG drawn to match is shown instead.
	const SYMBOL_FONT = 'Luminous Symbols';
	const symbols = new Set();
	let symbolFontReady = false;

	function symbolIcon(className, size, glyph, shapes, strokeWidth) {
		const box = document.createElement('span');
		box.className = `gc-sym ${className}`;
		box.setAttribute('aria-hidden', 'true');
		box.style.setProperty('--gc-sym-size', `${size}px`);
		box.dataset.name = glyph;
		box.appendChild(svgIcon('gc-sym__svg', size, shapes, strokeWidth));
		symbols.add(box);
		upgradeSymbols();
		return box;
	}

	/** Switch every icon to Gemini's glyph once its font is loaded. */
	function upgradeSymbols() {
		if (!symbolFontReady) {
			try {
				// Not fonts.check(): it answers true for a font the page never declared.
				symbolFontReady = [...(document.fonts || [])].some((f) => f.family.replace(/["']/g, '') === SYMBOL_FONT && f.status === 'loaded');
			} catch {
				symbolFontReady = false;
			}
			if (!symbolFontReady) return;
		}
		for (const box of symbols) if (!box.dataset.glyph) box.dataset.glyph = box.dataset.name;
	}
	try {
		document.fonts?.addEventListener?.('loadingdone', upgradeSymbols);
	} catch {
		/* no FontFaceSet: the SVGs stay */
	}

	/** Text for screen readers only: the label the chip does not show. */
	function srText(text) {
		return Object.assign(document.createElement('span'), { className: 'gc-sr', textContent: text });
	}

	/**
	 * The input card by its look rather than its name, for a composer that ships
	 * without `input-area-v2`: the nearest ancestor of the text box that is a flex
	 * box with a real corner radius and a painted background.
	 */
	function findComposerCard(input) {
		let el = input?.parentElement;
		for (let hops = 0; el && el !== document.body && hops < 10; hops++, el = el.parentElement) {
			const style = window.getComputedStyle(el);
			if (style.display !== 'flex') continue;
			if (parseFloat(style.borderRadius) < 8) continue;
			const bg = style.backgroundColor;
			if (!bg || bg === 'transparent' || bg.replace(/\s/g, '') === 'rgba(0,0,0,0)') continue;
			return el;
		}
		return null;
	}

	// How long a floating part waits before trying its real place again.
	const FLOAT_RETRY_MS = 30000;

	class CounterUI {
		constructor({ onUsageRefresh, onExport } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;
			this.onExport = onExport || null;
			this.settings = { ...GC.SETTINGS_DEFAULTS };

			this.totalTokens = 0;
			this.turnCount = 0;
			this.truncated = false;
			this.plan = null;
			// When the last good usage reading came, while a later one has failed; else null.
			this.usageStaleSince = null;

			this.hasSessionData = false;
			this.hasWeeklyData = false;
			this.sessionResetMs = null;
			this.weeklyResetMs = null;
			// Latched the moment a reading proves the nominal window length wrong, and
			// never cleared: the contradiction is visible only early in such a window.
			this.sessionWindowLengthUnknown = false;
			this.weeklyWindowLengthUnknown = false;
			this.refreshingUsage = false;
			this.exporting = false;

			this.headerTier = 'none';
			this.chipTier = 'none';
			this.usageTier = 'none';
			this.unseen = { chip: 0, usage: 0 };
			this.floatRetryAt = { chip: 0, usage: 0 };
		}

		initialize() {
			// The export button's container, in Gemini's top-right action group.
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'gc-header';

			// The token chip, at the top left of the chat, where the Claude extension
			// puts it beside the chat's title. Gemini has no title there (it is only in
			// the sidebar), so the chip sits alone in that place.
			this.chipBox = document.createElement('div');
			this.chipBox.className = 'gc-chipBox';
			this.chip = document.createElement('span');
			this.chip.className = 'gc-chip';
			this.chipValue = document.createElement('span');
			this.chip.append(srText('Token Counter: '), this.chipValue);

			this._initUsageLine();
			this._initExportButton();
			this._initContextPopover();
			this._setupTooltips();
			this._observeDom();
		}

		/** Apply a settings change without needing fresh data. */
		applySettings(settings) {
			this.settings = { ...GC.SETTINGS_DEFAULTS, ...(settings || {}) };
			this._syncUsageVisibility();
			this._renderHeader();
		}

		_observeDom() {
			// At most one search a second: this runs on every mutation batch, which
			// while a reply streams is hundreds a second.
			const RETRY_MS = 1000;
			let last = 0;
			let retryTimer = null;
			const check = () => {
				retryTimer = null;
				const now = Date.now();
				const usageFloating = this.usageLine.classList.contains('gc-floating');
				const chipFloating = this.chipBox.classList.contains('gc-floating');
				const wants =
					!document.contains(this.usageLine) || !document.contains(this.headerContainer) ||
					(!document.contains(this.chipBox) && !this.chipBox.classList.contains('gc-floating')) ||
					(usageFloating && now >= this.floatRetryAt.usage) ||
					(chipFloating && now >= this.floatRetryAt.chip);
				if (!wants) return;
				if (now - last >= RETRY_MS) {
					last = now;
					if (usageFloating) this.floatRetryAt.usage = now + FLOAT_RETRY_MS;
					if (chipFloating) this.floatRetryAt.chip = now + FLOAT_RETRY_MS;
					this.attachUsageLine();
					this.attachHeader();
				} else if (!retryTimer) {
					// The batch inside the throttle may be the one that brought the anchor,
					// and an idle page sends no second batch to look again on.
					retryTimer = setTimeout(check, RETRY_MS);
				}
			};
			new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className = 'gc-usageRow gc-hidden';

			this.sessionUsageSpan = Object.assign(document.createElement('span'), { className: 'gc-usageText' });
			this.weeklyUsageSpan = Object.assign(document.createElement('span'), { className: 'gc-usageText' });
			({ bar: this.sessionBar, fill: this.sessionBarFill, marker: this.sessionMarker } = makeBar());
			({ bar: this.weeklyBar, fill: this.weeklyBarFill, marker: this.weeklyMarker } = makeBar());

			this.sessionGroup = document.createElement('div');
			this.sessionGroup.className = 'gc-usageGroup';
			this.sessionGroup.append(this.sessionUsageSpan, this.sessionBar);

			// Mirrored, as in the Claude extension: bar first, label at the far end.
			this.weeklyGroup = document.createElement('div');
			this.weeklyGroup.className = 'gc-usageGroup gc-usageGroup--weekly';
			this.weeklyGroup.append(this.weeklyBar, this.weeklyUsageSpan);

			this.refreshBtn = document.createElement('button');
			this.refreshBtn.className = 'gc-iconBtn gc-refreshBtn';
			this.refreshBtn.type = 'button';
			this.refreshBtn.setAttribute('aria-label', 'Refresh usage');
			this.refreshBtn.appendChild(symbolIcon('gc-refreshIcon', 18, 'refresh', [
				['path', { d: 'M19 12a7 7 0 1 1-2.05-4.95' }],
				['polyline', { points: '19 4.5 19 8.5 15 8.5' }]
			], 2));
			this.refreshBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.refreshBtn.classList.add('gc-refreshBtn--spinning');
				this.usageLine.classList.add('gc-usageRow--dim');
				let ok = false;
				try {
					ok = (await this.onUsageRefresh()) !== false;
				} catch (err) {
					GC.noteError('usage refresh', err);
				} finally {
					this.refreshBtn.classList.remove('gc-refreshBtn--spinning');
					this.usageLine.classList.remove('gc-usageRow--dim');
					this.refreshingUsage = false;
				}
				// A spinner that stops on the same figures reads as "refreshed": say it failed.
				if (!ok) {
					this.refreshBtn.classList.add('gc-refreshBtn--error');
					setTimeout(() => this.refreshBtn?.classList.remove('gc-refreshBtn--error'), 2500);
				}
			});

			this.usageLine.append(this.sessionGroup, this.weeklyGroup, this.refreshBtn);
		}

		_initExportButton() {
			this.exportBtn = document.createElement('button');
			this.exportBtn.className = 'gc-iconBtn gc-exportBtn';
			this.exportBtn.type = 'button';
			this.exportBtn.setAttribute('aria-label', 'Export conversation');
			this.exportBtn.setAttribute('aria-haspopup', 'menu');
			this.exportBtn.setAttribute('aria-expanded', 'false');
			this.exportBtn.appendChild(symbolIcon('gc-exportIcon', 24, 'download', [
				['path', { d: 'M12 4.5v10' }],
				['polyline', { points: '7.5 10.5 12 15 16.5 10.5' }],
				['path', { d: 'M5 15.5v2.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-2.5' }]
			], 1.6));

			this.exportMenu = document.createElement('div');
			this.exportMenu.className = 'gc-menu gc-hidden';
			this.exportMenu.setAttribute('role', 'menu');
			// Each row leads with a 20px icon, as the rows of Gemini's own menus do.
			const MENU_ICONS = {
				md: [
					['rect', { x: '3', y: '5.5', width: '18', height: '13', rx: '2.5' }],
					['polyline', { points: '6.5 15 6.5 9 9 12 11.5 9 11.5 15' }],
					['path', { d: 'M16.5 9v6' }],
					['polyline', { points: '14.5 13 16.5 15 18.5 13' }]
				],
				txt: [
					['path', { d: 'M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z' }],
					['polyline', { points: '14 3.5 14 7.5 18 7.5' }],
					['path', { d: 'M9 12h6M9 15.5h6' }]
				]
			};
			// Gemini's own glyphs for them: a page of text for Markdown, plain lines for text.
			const MENU_GLYPHS = { md: 'article', txt: 'notes' };
			for (const [format, label] of [['md', 'Markdown (.md)'], ['txt', 'Plain text (.txt)']]) {
				const item = document.createElement('button');
				item.className = 'gc-menuItem';
				item.type = 'button';
				item.setAttribute('role', 'menuitem');
				item.append(symbolIcon('gc-menuIcon', 20, MENU_GLYPHS[format], MENU_ICONS[format], 1.6), document.createTextNode(label));
				item.addEventListener('click', (e) => {
					e.stopPropagation();
					this._closeExportMenu(this.exportMenu.contains(document.activeElement));
					this._runExport(format);
				});
				this.exportMenu.appendChild(item);
			}
			// What role="menu" promises a keyboard user: arrows move, Tab leaves.
			this.exportMenu.addEventListener('keydown', (e) => {
				const items = [...this.exportMenu.children];
				const i = items.indexOf(document.activeElement);
				if (e.key === 'Enter' && e.repeat) e.preventDefault();
				else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
					e.preventDefault();
					items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus?.();
				} else if (e.key === 'Tab') {
					e.preventDefault();
					this._closeExportMenu(true);
				}
			});
			document.body.appendChild(this.exportMenu);

			this.exportBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.exportMenu.classList.contains('gc-hidden')) this._openExportMenu();
				else this._closeExportMenu();
			});
			document.addEventListener('click', () => this._closeFloaters());
			document.addEventListener('keydown', (e) => {
				if (e.key !== 'Escape') return;
				const menuOpen = !this.exportMenu.classList.contains('gc-hidden');
				this._closeFloaters();
				if (menuOpen) this._closeExportMenu(true);
			});
		}

		/** The chip's click popover: model, and the context window of each plan. */
		_initContextPopover() {
			const pop = document.createElement('div');
			pop.className = 'gc-popover gc-hidden';
			pop.setAttribute('role', 'dialog');
			pop.setAttribute('aria-label', 'Context window');
			const row = (className, cells) => {
				const r = Object.assign(document.createElement('div'), { className: `gc-popover__row ${className}` });
				for (const text of cells) r.appendChild(Object.assign(document.createElement('span'), { textContent: text }));
				pop.appendChild(r);
				return r;
			};
			this.popHead = row('gc-popover__row--head', ['Context window', 'Free', 'Plus', 'Pro', 'Ultra']);
			for (const cells of CONTEXT_SIZES) row('', cells);
			pop.appendChild(Object.assign(document.createElement('div'), {
				className: 'gc-popover__note',
				textContent: 'Google sets the window by plan, not by model. The count is an estimate: uploaded files, images, thinking and Gemini\u2019s own instructions are not in it.'
			}));
			document.body.appendChild(pop);
			this.contextPopover = pop;

			const trigger = this.chip;
			trigger.setAttribute('role', 'button');
			trigger.setAttribute('tabindex', '0');
			trigger.setAttribute('aria-haspopup', 'dialog');
			trigger.setAttribute('aria-expanded', 'false');
			this._toggleContext = (e) => {
				e.stopPropagation();
				const opening = pop.classList.contains('gc-hidden');
				this._closeFloaters();
				if (!opening) return;
				hideTip(trigger);
				// The column of the plan this account is on.
				[...this.popHead.children].slice(1).forEach((cell, i) => cell.classList.toggle('gc-popover__plan--current', CONTEXT_PLANS[i] === this.plan));
				pop.classList.remove('gc-hidden');
				trigger.setAttribute('aria-expanded', 'true');
				placeNear(pop, trigger, 6, true);
			};
			trigger.addEventListener('click', this._toggleContext);
			// Tabbing on from the chip leaves the popover behind otherwise.
			trigger.addEventListener('focusout', (e) => {
				if (!pop.contains(e.relatedTarget)) {
					pop.classList.add('gc-hidden');
					trigger.setAttribute('aria-expanded', 'false');
				}
			});
			trigger.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					this._toggleContext(e);
				}
			});
		}

		_openExportMenu() {
			this._closeFloaters();
			this.exportMenu.classList.remove('gc-hidden');
			this.exportBtn.setAttribute('aria-expanded', 'true');
			placeNear(this.exportMenu, this.exportBtn, 6, true);
			// The menu sits at the end of the page, a whole document of tab stops away.
			this.exportMenu.firstElementChild?.focus?.();
		}

		_closeExportMenu(refocus = false) {
			this.exportMenu?.classList.add('gc-hidden');
			this.exportBtn?.setAttribute('aria-expanded', 'false');
			if (refocus) this.exportBtn?.focus?.();
		}

		_closeFloaters() {
			this._closeExportMenu();
			this.contextPopover?.classList.add('gc-hidden');
			this.chip?.setAttribute('aria-expanded', 'false');
		}

		async _runExport(format) {
			if (!this.onExport || this.exporting) return;
			this.exporting = true;
			this.exportBtn.classList.add('gc-exportBtn--busy');
			try {
				await this.onExport(format);
			} catch (e) {
				GC.noteError('export', e);
				// A click that silently does nothing is worse than a visible failure.
				this.exportBtn.classList.add('gc-exportBtn--error');
				setTimeout(() => this.exportBtn?.classList.remove('gc-exportBtn--error'), 2000);
			} finally {
				this.exportBtn.classList.remove('gc-exportBtn--busy');
				this.exporting = false;
			}
		}

		_setupTooltips() {
			setupTooltip(this.chip, 'Approximate: counts prompts, replies and the documents Gemini wrote. Uploaded files, images, thinking and Gemini’s own instructions are not included.', 'Click for details', (e) => this._toggleContext(e));
			setupTooltip(this.exportBtn, 'Export as Markdown or plain text');
			setupTooltip(this.refreshBtn, 'Refresh usage');
			const stale = () => (this.usageStaleSince ? ` Could not refresh: these figures are from ${formatAgo(this.usageStaleSince)}.` : '');
			setupTooltip(this.sessionGroup, () => `5-hour session window. The thin line shows how far through it you are.${stale()}`);
			setupTooltip(this.weeklyGroup, () => `7-day usage window. The thin line shows how far through it you are.${stale()}`);
		}

		/**
		 * The export button goes in Gemini's top-right action group, right before the
		 * last child (the one holding the conversation menu), as a sibling: the
		 * group spaces its children 12px apart, which is how its own buttons sit. Not
		 * first: an empty upsell container sits between, and the gap either side of it
		 * left a hole (seen 2026-10-18). Its right-hand section is the first choice,
		 * the group itself the second.
		 */
		attachHeader() {
			this._attachChip();
			const right = document.querySelector(GC.DOM.TOP_BAR_RIGHT);
			const host = right || document.querySelector(GC.DOM.TOP_BAR);
			if (!host) {
				// No top bar: beside the chip rather than nowhere.
				if (this.headerContainer.parentElement !== this.chipBox) this.chipBox.appendChild(this.headerContainer);
				this.headerTier = 'chip';
				this._renderHeader();
				return;
			}
			this.headerTier = right ? 'topbar' : 'topbar-host';
			const kids = [...host.children].filter((c) => c !== this.headerContainer);
			const before = kids[kids.length - 1] || null;
			if (this.headerContainer.parentElement !== host || this.headerContainer.nextElementSibling !== before) host.insertBefore(this.headerContainer, before);
			this._renderHeader();
		}

		/**
		 * The chip goes in the chat column, `.main-content`, held to its top left and
		 * level with Gemini's top-right buttons (see _alignChip). Falls back to the
		 * floating pill when the column is not there.
		 */
		_attachChip() {
			const column = document.querySelector(GC.DOM.CHAT_COLUMN);
			if (!column) {
				if (!this.chipBox.classList.contains('gc-floating')) this.chipTier = 'none';
				return;
			}
			this.chipTier = 'column';
			if (column.firstElementChild !== this.chipBox) column.insertBefore(this.chipBox, column.firstElementChild);
			this.chipBox.classList.remove('gc-floating');
			this._alignChip();
		}

		/**
		 * Level with the top bar's buttons, and clear of the sidebar's own button,
		 * which floats over the top left of the column when the sidebar is closed.
		 */
		_alignChip() {
			if (this.chipBox.classList.contains('gc-floating') || !document.contains(this.chipBox)) return;
			const column = this.chipBox.parentElement?.getBoundingClientRect?.();
			const bar = document.querySelector(GC.DOM.TOP_BAR)?.getBoundingClientRect?.();
			const nav = document.querySelector(GC.DOM.SIDE_NAV_BUTTON)?.getBoundingClientRect?.();
			const box = this.chipBox.getBoundingClientRect();
			if (!column || !box.height) return;
			const navOver = nav?.width && nav.right > column.left;
			// Level with the sidebar's button while it sits beside the chip, else with the top bar.
			const level = navOver ? nav : bar;
			const top = level?.height ? level.top + level.height / 2 - box.height / 2 - column.top : 16;
			const clear = navOver ? nav.right + 12 - column.left : 0;
			const left = Math.max(24, clear);
			const next = [`${Math.round(top)}px`, `${Math.round(left)}px`];
			if (this.chipBox.style.top !== next[0]) this.chipBox.style.top = next[0];
			if (this.chipBox.style.left !== next[1]) this.chipBox.style.left = next[1];
		}

		/**
		 * The usage row goes inside the input card, on its own line under the text
		 * field, so the card grows to hold it. Gemini's card is a flex row whose one
		 * child, `.input-area`, is a plain block: appended there, the row stacks below
		 * the field. Fallbacks, in order: right under the card's container, right
		 * under the card, right under whatever ancestor of the text box looks like a
		 * card. Only the first is inside.
		 */
		attachUsageLine() {
			const input = document.querySelector(GC.DOM.CHAT_INPUT);
			if (!input) return;
			const area = input.closest(GC.DOM.INPUT_AREA);
			const body = input.closest(GC.DOM.INPUT_AREA_BODY);
			const container = area?.closest(GC.DOM.INPUT_CONTAINER);
			const card = area || findComposerCard(input);
			this.usageCard = card;
			this.usageLine.classList.remove('gc-floating');
			this.usageLine.classList.toggle('gc-usageRow--inCard', !!body);
			if (body) {
				this.usageTier = 'in-card';
				if (body.lastElementChild !== this.usageLine) body.appendChild(this.usageLine);
				this._alignToCard();
				return;
			}
			const anchor = container || card;
			if (!anchor?.parentElement) return;
			this.usageTier = container ? 'container' : area ? 'input-area' : 'shape';
			if (anchor.nextElementSibling !== this.usageLine) anchor.after(this.usageLine);
			this._alignToCard();
		}

		/**
		 * Under the card, the row's container is wider than the card; line the row up
		 * with it. Re-measured every tick, since the card changes width with the window.
		 * Inside the card there is nothing to line up.
		 */
		_alignToCard() {
			const rect = this.usageCard?.getBoundingClientRect?.();
			const inCard = this.usageLine.classList.contains('gc-usageRow--inCard');
			if (inCard || !rect || rect.width < 200 || this.usageLine.classList.contains('gc-floating')) {
				this.usageLine.style.maxWidth = '';
				return;
			}
			const width = `${Math.round(rect.width)}px`;
			if (this.usageLine.style.maxWidth !== width) this.usageLine.style.maxWidth = width;
		}

		setPlan(plan) {
			this.plan = plan || null;
		}

		setConversationMetrics({ totalTokens, turns, truncated } = {}) {
			this.totalTokens = typeof totalTokens === 'number' ? totalTokens : 0;
			this.turnCount = typeof turns === 'number' ? turns : 0;
			this.truncated = truncated === true;
			// An empty conversation (a new chat before the server has it) has nothing
			// to count; "0 tokens" read as broken. A chat too long to read whole is
			// counted from its newest turns, so the figure is a floor.
			this.chipValue.textContent = this.totalTokens > 0 ? `${this.truncated ? '≥ ' : ''}${this.totalTokens.toLocaleString()} tokens` : '';
			this._renderHeader();
		}

		/** Mark the usage figures as left over from `since` (ms) after a failed read; false clears it. */
		setUsageStale(since) {
			this.usageStaleSince = since || null;
			this.usageLine.classList.toggle('gc-usageRow--stale', !!since);
		}

		/**
		 * The chip in its box, the export button in the top bar, each only when its
		 * setting allows: the chip for a chat with a count, export for a chat with
		 * turns (one of only uploads or images counts 0 and is still worth exporting).
		 */
		_renderHeader() {
			const sync = (host, el, show) => {
				const has = el.parentElement === host;
				if (show && !has) host.prepend(el);
				else if (!show && has) el.remove();
			};
			sync(this.chipBox, this.chip, this.totalTokens > 0 && this.settings.tokenCounter);
			sync(this.headerContainer, this.exportBtn, (this.turnCount > 0 || this.totalTokens > 0) && this.settings.exportButton);
			this._alignChip();
		}

		setUsage(usage) {
			this.hasSessionData = typeof usage?.session?.utilization === 'number';
			this.hasWeeklyData = typeof usage?.weekly?.utilization === 'number';
			this.sessionResetMs = paintWindow(usage?.session, 'Hourly', this.sessionUsageSpan, this.sessionBarFill);
			this.weeklyResetMs = paintWindow(usage?.weekly, 'Weekly', this.weeklyUsageSpan, this.weeklyBarFill);
			this._syncUsageVisibility();
			this._updateMarkers();
		}

		_syncUsageVisibility() {
			// Settings decide what may be shown; data decides whether anything is. A
			// window with no current figure keeps its place, marked unknown, so the row
			// never collapses to a lone bar.
			const { sessionBar, weeklyBar, usageRefresh } = this.settings;
			const hasData = this.hasSessionData || this.hasWeeklyData;
			this.sessionGroup.classList.toggle('gc-hidden', !sessionBar);
			this.weeklyGroup.classList.toggle('gc-hidden', !weeklyBar);
			this.sessionGroup.classList.toggle('gc-usageGroup--single', !weeklyBar);
			this.weeklyGroup.classList.toggle('gc-usageGroup--single', !sessionBar);
			this.sessionUsageSpan.classList.toggle('gc-usageUnknown', !this.hasSessionData);
			this.weeklyUsageSpan.classList.toggle('gc-usageUnknown', !this.hasWeeklyData);
			this.refreshBtn.classList.toggle('gc-hidden', !usageRefresh);
			this.usageLine.classList.toggle('gc-hidden', !hasData || (!sessionBar && !weeklyBar));
		}

		/**
		 * Place both elapsed-time markers, or withdraw them. No payload states how long
		 * a window is, so its start is inferred as `resets_at - nominal`. A window can
		 * never have meaningfully more time left than it is long, so a reading that
		 * does proves the nominal wrong for this account, and the marker hides itself
		 * for good (latched: later readings look ordinary while the marker would be
		 * badly misplaced).
		 */
		_updateMarkers() {
			const now = Date.now();
			const place = (marker, resetMs, windowMs, latchKey) => {
				const known = resetMs && Number.isFinite(resetMs);
				if (known && resetMs - now > windowMs + GC.CONST.WINDOW_NOMINAL_TOLERANCE_MS) this[latchKey] = true;
				const remaining = known ? resetMs - now : 0;
				if (!known || this[latchKey] || remaining <= 0) {
					marker.classList.add('gc-hidden');
					return;
				}
				const pct = Math.max(0, Math.min(100, ((windowMs - remaining) / windowMs) * 100));
				marker.style.left = `${pct}%`;
				marker.classList.remove('gc-hidden');
			};
			place(this.sessionMarker, this.sessionResetMs, GC.CONST.SESSION_WINDOW_MS, 'sessionWindowLengthUnknown');
			place(this.weeklyMarker, this.weeklyResetMs, GC.CONST.WEEKLY_WINDOW_MS, 'weeklyWindowLengthUnknown');
		}

		/**
		 * Last resort, for whenever Gemini changes its layout: a part with something to
		 * say that has not been painted for three ticks is lifted onto the page body and
		 * floated as a small pill, and its real place is tried again every 30 seconds.
		 * Only on a chat page: elsewhere there is nothing to show.
		 */
		_ensureShown() {
			this._keepSeen('chip', this.chipBox, this.chipBox.children.length > 0);
			this._keepSeen('usage', this.usageLine, !this.usageLine.classList.contains('gc-hidden'));
		}

		_keepSeen(key, el, wanted) {
			const onChat = !!document.querySelector(GC.DOM.CHAT_INPUT);
			if (el.classList.contains('gc-floating')) {
				if (!onChat) {
					el.classList.remove('gc-floating');
					el.remove();
				}
				return;
			}
			if (!onChat) {
				this.unseen[key] = 0;
				return;
			}
			// No layout to ask (a non-rendering context) counts as painted: floating on a
			// guess would be worse than not floating.
			const rects = document.contains(el) ? el.getClientRects?.() : [];
			const painted = !wanted || (rects ? rects.length > 0 && rects[0].width > 0 : true);
			if (painted) {
				this.unseen[key] = 0;
				return;
			}
			if (++this.unseen[key] < 3) return;
			this.unseen[key] = 0;
			el.style.maxWidth = '';
			document.body.appendChild(el);
			el.classList.add('gc-floating');
			this.floatRetryAt[key] = Date.now() + FLOAT_RETRY_MS;
			if (key === 'chip') this.chipTier = 'floating';
			else this.usageTier = 'floating';
		}

		/** What a bug report needs: which anchors matched and what is painted. No ids, no text. */
		getDiagnostics() {
			const shown = (el) => !!(el && document.contains(el) && el.getBoundingClientRect().width > 0);
			return {
				export: this.headerTier,
				chip: this.chipTier,
				composer: this.usageTier,
				theme: document.body?.classList?.contains('dark-theme') ? 'dark' : 'light',
				tokens: shown(this.chip) && this.totalTokens > 0,
				usageRow: shown(this.usageLine),
				exportBtn: shown(this.exportBtn),
				floating: [['chip', this.chipBox], ['usage', this.usageLine]]
					.filter(([, el]) => el.classList.contains('gc-floating')).map(([k]) => k),
				disabled: Object.keys(this.settings).filter((k) => this.settings[k] === false),
				errors: GC.recentErrors()
			};
		}

		tick() {
			if (!symbolFontReady) upgradeSymbols();
			this._ensureShown();
			if (document.contains(this.usageLine)) this._alignToCard();
			retimeReset(this.sessionUsageSpan, this.sessionResetMs);
			retimeReset(this.weeklyUsageSpan, this.weeklyResetMs);
			this._alignChip();
			// The markers move with the clock, not with usage.
			this._updateMarkers();
		}
	}

	GC.ui = { CounterUI };
})();
