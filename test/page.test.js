// The content scripts as shipped, on the page shape Gemini had on 2026-10-18,
// with a fake bridge in place of the page world.
const { loadWith, run, fakeChrome, geminiPage, fixture, flush, section, t, report } = require('./harness');

const CONTENT = [
	'src/content/constants.js',
	'src/content/bridge-client.js',
	'src/vendor/o200k_base.js',
	'src/content/conversation.js',
	'src/content/export.js',
	'src/content/ui.js'
];

// Where the parts end up: the export button's container in the top bar, the
// token count first in the usage row.
const headerOf = (dom) => dom.right.children.find((c) => c.classList.contains('gc-header'));
const rowOf = (dom) => dom.inner.lastElementChild;
const chipBoxOf = (dom) => dom.column.children.find((c) => c.classList.contains('gc-chipBox'));
const chipOf = (dom) => chipBoxOf(dom)?.children.find((c) => c.classList.contains('gc-chip'));
const shown = (el) => !!el && !el.classList.contains('gc-hidden');

const later = (ms) => new Date(Date.now() + ms).toISOString();

/** Wait until `cond()` holds, up to `ms`: real timers, without betting on how busy the machine is. */
async function waitFor(cond, ms = 4000) {
	const end = Date.now() + ms;
	while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
	return cond();
}

/** A promise with its resolve and reject handed out, to finish requests in a chosen order. */
function deferred() {
	let resolve, reject;
	const promise = new Promise((a, b) => { resolve = a; reject = b; });
	return { promise, resolve, reject };
}

/** The recorded Pro reading, its reset times moved to 4h and 4d 2h from now so it never goes stale. */
function liveUsage() {
	const u = fixture('usage-pro.json');
	const now = Math.floor(Date.now() / 1000);
	for (const w of u[1]) w[3][0][0] = now + (w[2] === 1 ? 4 * 3600 + 30 : (4 * 24 + 2) * 3600 + 30);
	return u;
}

/** Load everything up to main.js, swap the bridge, then start main.js. */
async function page({ pathname = '/u/1/app/80eeb4ca73c8a8fa', store = {}, usage = liveUsage(), turns = fixture('hello-conversation.json')[0], build } = {}) {
	const chrome = fakeChrome(store);
	let dom;
	const ctx = loadWith({ chrome, pathname, setup: (c) => { dom = geminiPage(c); build?.(c, dom); } }, ...CONTENT);
	const calls = { usage: 0, conversation: [] };
	ctx.GeminiCounter.bridge = {
		requestUsage: async () => { calls.usage++; return { data: typeof usage === 'function' ? usage() : usage, build: 'boq_test' }; },
		requestConversation: async (id) => { calls.conversation.push(id); return { turns: typeof turns === 'function' ? turns() : turns }; }
	};
	run(ctx, 'src/content/main.js');
	for (let i = 0; i < 10; i++) await flush();
	return { ctx, dom, chrome, calls, GC: ctx.GeminiCounter };
}

(async () => {
	section('placing the parts');
	{
		const { dom, GC } = await page();
		const header = headerOf(dom);
		t('export goes in the top bar, right before the menu’s container', header && header.nextElementSibling === dom.menu);
		t('not before the empty upsell container (that left a gap)', dom.right.children[0] === dom.upsell);
		t('the top bar holds only the export button', header.children.length === 1 && header.children[0].classList.contains('gc-exportBtn'));
		const row = dom.inner.lastElementChild;
		t('usage row goes inside the input card, after the field', row?.classList.contains('gc-usageRow') && dom.fieldset.nextElementSibling === row);
		t('in the in-card look', row.classList.contains('gc-usageRow--inCard'));
		t('nothing left under the card', dom.container.nextElementSibling === dom.disclaimer);
		t('the open chat is the one in the path', GC.main.readState().conversationId === '80eeb4ca73c8a8fa');
	}
	{
		// No right section: the top bar itself is the second tier.
		const { dom } = await page({ build: (c, d) => { d.right.remove(); } });
		t('without the right section, first in the top bar', dom.topBar.firstElementChild?.classList.contains('gc-header'));
	}
	{
		// A card without its inner block: the row goes right under the card instead.
		const { dom, GC, chrome } = await page({ build: (c, d) => { d.inner.remove(); d.area.appendChild(d.fieldset); } });
		const row = dom.container.nextElementSibling;
		t('no inner block: right under the card\u2019s container', row?.classList.contains('gc-usageRow') && row.nextElementSibling === dom.disclaimer);
		t('in the outside look', !row.classList.contains('gc-usageRow--inCard'));
		GC.main.tick();
		for (let i = 0; i < 5; i++) await flush();
		t('reports name the fallback tier', chrome._store['gc:diag']?.composer === 'container', chrome._store['gc:diag']?.composer);
	}

	section('token count');
	{
		const { dom, calls, GC } = await page();
		const chip = chipOf(dom);
		t('the open chat is read by its id', calls.conversation[0] === '80eeb4ca73c8a8fa');
		t('the chip sits at the top left of the chat column, as beside Claude\u2019s title', dom.column.firstElementChild === chipBoxOf(dom) && !!chip);
		t('chip shows the count', /^Token Counter: [\d,.\s]+ tokens$/.test(chip?.textContent || ''), chip?.textContent);
		t('the usage row has no chip in it', !rowOf(dom).children.some((c) => c.classList.contains('gc-chip')));
		chip.click();
		const pop = GC.ui && dom.right.parentElement.parentElement.children.find((c) => c.classList.contains('gc-popover'));
		t('clicking the chip opens the popover', pop && !pop.classList.contains('gc-hidden'));
		const head = pop.children[0];
		t('popover is the Claude table: a model per row, a plan per column', head.children.map((c) => c.textContent).join('|') === 'Context window|Free|Plus|Pro|Ultra' && pop.children[1].textContent === 'Flash-Lite32K128K1M1M', pop.children.map((c) => c.textContent).join(' / '));
		t('every Gemini model has a row', ['Flash-Lite', 'Flash', 'Pro', 'Argon'].every((m, i) => pop.children[i + 1].children[0].textContent === m));
		t('no plan known yet: no column marked', !head.children.some((c) => c.classList.contains('gc-popover__plan--current')));
	}
	{
		const { dom } = await page({ turns: [] });
		t('an empty chat shows no count, not "0 tokens"', !chipOf(dom));
		t('and nothing to export', headerOf(dom).children.length === 0);
		t('the usage still shows', shown(rowOf(dom)) && rowOf(dom).textContent.includes('Hourly: 67%'));
	}
	{
		const { dom, calls } = await page({ pathname: '/u/1/app' });
		t('no chat open: nothing read, no count, no export', calls.conversation.length === 0 && !chipOf(dom) && headerOf(dom).children.length === 0);
	}
	{
		const { calls } = await page({ pathname: '/gem/abc123/0123456789abcdef' });
		t('a chat inside a Gem is read too', calls.conversation[0] === '0123456789abcdef');
	}

	section('a reply ending moves the count');
	{
		let n = 1;
		const base = fixture('hello-conversation.json')[0];
		const { dom, calls, GC } = await page({ turns: () => base.slice(0, 1).concat(n > 1 ? [JSON.parse(JSON.stringify(base[0]))] : []) });
		const before = chipOf(dom).textContent;
		n = 2;
		await GC.main.handleReplyEnd();
		for (let i = 0; i < 5; i++) await flush();
		const after = chipOf(dom).textContent;
		t('conversation read again', calls.conversation.length === 2);
		t('usage read again too', calls.usage >= 2);
		t('count went up', parseInt(after.replace(/\D/g, ''), 10) > parseInt(before.replace(/\D/g, ''), 10), `${before} -> ${after}`);
	}

	section('the page\'s own busy flag ends a reply');
	{
		const { El } = require('./harness');
		const { ctx, calls } = await page();
		const busy = new El('div').answers('model-response [aria-busy="true"]');
		const observe = (records) => { for (const fn of ctx.__observers) fn(records); };
		const before = calls.conversation.length;
		ctx.document.body.appendChild(busy);
		observe([{ type: 'attributes', target: { getAttribute: () => 'true' }, oldValue: 'false' }]);
		await new Promise((r) => setTimeout(r, 300));
		busy.remove();
		observe([{ type: 'attributes', target: { getAttribute: () => 'false' }, oldValue: 'true' }]);
		await new Promise((r) => setTimeout(r, 600));
		t('not yet: the flag can drop for a moment as a reply starts', calls.conversation.length === before);
		t('read again once it has stayed down', await waitFor(() => calls.conversation.length >= before + 1), String(calls.conversation.length - before));
	}
	{
		// A one-word reply raised and dropped the flag between two looks.
		const { ctx, calls } = await page();
		const before = calls.conversation.length;
		for (const fn of ctx.__observers) fn([{ type: 'attributes', target: { getAttribute: () => 'false' }, oldValue: 'true' }]);
		t('a flag seen only in the records still ends the reply', await waitFor(() => calls.conversation.length >= before + 1));
	}

	section('navigation');
	{
		const { ctx, calls, dom } = await page();
		ctx.window.location.pathname = '/u/1/app/aaaaaaaaaaaaaaaa';
		ctx.GeminiCounter.bridge.requestConversation = async (id) => { calls.conversation.push(id); return { turns: [] }; };
		ctx.GeminiCounter.main.tick();
		for (let i = 0; i < 5; i++) await flush();
		t('a new path is noticed on the next tick', calls.conversation[1] === 'aaaaaaaaaaaaaaaa');
		t('the last chat’s count does not stay on the new one', !chipOf(dom));
	}

	section('usage row');
	{
		const { dom, GC } = await page();
		const row = dom.inner.lastElementChild;
		const text = row.textContent;
		t('row visible with data', !row.classList.contains('gc-hidden'));
		t('labelled as the Claude extension labels it', /Hourly: 67% \(resets in /.test(text), text);
		t('whole percentages (23.2 reads 23)', text.includes('Weekly: 23%') && !text.includes('23.2'), text);
		const groups = row.children.filter((c) => c.classList.contains('gc-usageGroup'));
		const kinds = (g) => g.children.map((c) => c.className.split(' ')[0]).join(',');
		t('hourly reads label then bar; weekly is mirrored, as in the Claude extension', kinds(groups[0]) === 'gc-usageText,gc-bar' && kinds(groups[1]) === 'gc-bar,gc-usageText', groups.map(kinds).join(' | '));
		t('usage source recorded', GC.main.readState().usageFrom === 'rpc');
	}
	{
		const { dom } = await page({ usage: [2, []] });
		t('no windows: the row stays hidden', !shown(rowOf(dom)));
		t('the count still shows', !!chipOf(dom));
	}
	{
		// A window that has already ended is never "resets in 0s": Gemini's next one
		// began at once, empty, one window length later (seen 2026-10-19).
		const ended = [2, [[1, 0.9, 1, [[Math.floor(Date.now() / 1000) - 60, 0]]], [1, 0.4, 2, [[Math.floor(Date.now() / 1000) + 3600, 0]]]], false];
		const { dom } = await page({ usage: ended });
		const text = dom.inner.lastElementChild.textContent;
		t('an ended window is shown as the next one, empty', /Hourly: 0% \(resets in 4h 59m\)/.test(text) && text.includes('Weekly: 40%'), text);
	}

	section('popup snapshot');
	// The page's inline data, as Gemini serves it, with the signed-in email in it.
	const withEmail = (c) => { c.document.scripts = [{ textContent: 'window.WIZ_global_data = {"SNlM0e":"tok","oPEP7c":"someone@example.com"};' }]; };
	{
		const { chrome } = await page({ build: (c) => { c.document.body.appendChild(new (require('./harness').El)('span').answers('.mavatar-user-info')); withEmail(c); } });
		const snap = chrome._store['gc:usageSnapshot:1'];
		t('snapshot written for the popup, under its account', snap && snap.session.utilization === 67);
		t('carries the account it belongs to', snap.account === '1');
		t('and its email, for the popup\u2019s picker', snap.email === 'someone@example.com');
		t('nothing under a key shared by every account', !('gc:usageSnapshot' in chrome._store));
	}
	{
		const { chrome } = await page();
		t('a page with no email in its data stores none', chrome._store['gc:usageSnapshot:1']?.email === '');
	}
	{
		const { chrome } = await page({ build: (c) => { c.document.scripts = [{ textContent: '{"oPEP7c":"not an email"}' }]; } });
		t('something that is not an email is not stored as one', chrome._store['gc:usageSnapshot:1']?.email === '');
	}
	{
		const store = { 'gc:usageSnapshot:0': { account: '0', updatedAt: 1, session: { utilization: 99, resets_at: later(3600e3) }, weekly: null } };
		// What the row showed while the live read was out, read from the page the build hook saw.
		let pageDom = null;
		let seen = null;
		const { dom, chrome } = await page({ store, build: (_c, d) => { pageDom = d; }, usage: () => { seen = pageDom.inner.lastElementChild.textContent; return [2, []]; } });
		t('the row was read while the live read was out', typeof seen === 'string');
		t('another account\u2019s stored reading is not shown', !String(seen).includes('99%') && !dom.inner.lastElementChild.textContent.includes('99%'));
		t('and stays stored for its own account', chrome._store['gc:usageSnapshot:0']?.session.utilization === 99);
	}
	{
		const store = { 'gc:usageSnapshot:1': { account: '1', updatedAt: 1, session: { utilization: 42, resets_at: later(3600e3) }, weekly: null } };
		const { dom, GC } = await page({ store, usage: () => { throw new Error('offline'); } });
		t('this account\u2019s stored reading shows while the live one fails', dom.inner.lastElementChild.textContent.includes('Hourly: 42%'));
		t('and is marked a seed, not a reading', GC.main.readState().seeded === true);
	}

	section('icons');
	{
		const { dom } = await page();
		const icon = dom.right.children.find((c) => c.classList.contains('gc-header'))?.querySelector('.gc-exportIcon');
		t('no symbol font on the page: the SVG is drawn', icon && !icon.dataset.glyph && icon.children[0]?.tag === 'svg');
	}
	{
		const { dom } = await page({ build: (c) => { c.document.fonts = [{ family: '"Luminous Symbols"', status: 'loaded' }]; } });
		const icon = dom.right.children.find((c) => c.classList.contains('gc-header'))?.querySelector('.gc-exportIcon');
		t('Gemini\u2019s symbol font loaded: the export icon is its download glyph', icon?.dataset.glyph === 'download');
		t('and no icon name lands in the page text', !/download/.test(dom.right.textContent));
	}
	{
		const { dom } = await page({ build: (c) => { c.document.fonts = [{ family: 'Luminous Symbols', status: 'loading' }]; } });
		const icon = dom.right.children.find((c) => c.classList.contains('gc-header'))?.querySelector('.gc-exportIcon');
		t('a font still loading is not used yet', icon && !icon.dataset.glyph);
	}

	section('plan');
	{
		const { El } = require('./harness');
		const { GC, dom } = await page({
			build: (c) => {
				const info = new El('div').answers('.mavatar-user-info');
				const label = new El('span').answers('.mavatar-tier-label');
				label.textContent = 'Pro';
				info.appendChild(label);
				c.document.body.appendChild(info);
			}
		});
		GC.main.tick();
		t('"Pro" from the sidebar reads as PRO', GC.main.readState().plan === 'PRO');
		chipOf(dom).click();
		const head = dom.right.parentElement.parentElement.children.find((c) => c.classList.contains('gc-popover')).children[0];
		t('the popover marks the Pro column', head.children.map((c) => c.classList.contains('gc-popover__plan--current')).join() === 'false,false,false,true,false');
	}
	{
		const { El } = require('./harness');
		const { GC } = await page({ build: (c) => c.document.body.appendChild(new El('div').answers('.mavatar-user-info')) });
		GC.main.tick();
		t('an account chip with no tier is FREE', GC.main.readState().plan === 'FREE');
	}
	{
		const { GC } = await page();
		GC.main.tick();
		t('no account chip yet: plan unknown, not guessed', GC.main.readState().plan === null);
	}

	section('settings');
	{
		const store = { 'gc:settings': { tokenCounter: false, exportButton: true, sessionBar: false, weeklyBar: true, usageRefresh: false } };
		const { dom } = await page({ store });
		const header = headerOf(dom);
		t('token counter off: count gone, export stays', !shown(chipOf(dom)) && header.children.length === 1 && header.children[0].classList.contains('gc-exportBtn'));
		const row = dom.inner.lastElementChild;
		const groups = row.children.filter((c) => c.classList.contains('gc-usageGroup'));
		t('current bar off', groups[0].classList.contains('gc-hidden') && !groups[1].classList.contains('gc-hidden'));
		t('refresh button off', row.children.find((c) => c.classList.contains('gc-refreshBtn')).classList.contains('gc-hidden'));
	}

	section('export');
	{
		const { dom, calls, ctx } = await page();
		const btn = headerOf(dom).children.find((c) => c.classList.contains('gc-exportBtn'));
		let downloaded = null;
		ctx.URL = { createObjectURL: (blob) => { downloaded = blob.text; return 'blob:x'; }, revokeObjectURL() {} };
		const menu = ctx.document.body.children.find((c) => c.classList.contains('gc-menu'));
		btn.click();
		t('menu opens', !menu.classList.contains('gc-hidden'));
		menu.children[0].click();
		for (let i = 0; i < 10; i++) await flush();
		t('export reads the chat fresh', calls.conversation.length === 2);
		t('Markdown has the title, prompt and reply', /^# A Simple Greeting/.test(downloaded || '') && downloaded.includes('Reply with just the word: hello') && downloaded.includes('## Gemini'), String(downloaded).slice(0, 200));
		t('the model is in the header line', downloaded.includes('3.1 Pro'));
	}

	section('diagnostics');
	{
		const { chrome, GC } = await page({ build: withEmail });
		GC.main.tick();
		for (let i = 0; i < 5; i++) await flush();
		const d = chrome._store['gc:diag'];
		t('published', !!d);
		t('anchors named', d.export === 'topbar' && d.chip === 'column' && d.composer === 'in-card', JSON.stringify(d));
		t('build from the bridge', d.build === 'boq_test');
		t('no conversation id or text in it', !JSON.stringify(d).includes('80eeb4ca') && !JSON.stringify(d).includes('hello'));
		t('no email in it, though the page has one', !JSON.stringify(d).includes('@'));
	}

	section('usage refresh');
	{
		const { dom, ctx } = await page();
		ctx.GeminiCounter.bridge.requestUsage = async () => { throw new Error('signed out'); };
		const row = rowOf(dom);
		const btn = row.children.find((c) => c.classList.contains('gc-refreshBtn'));
		btn.click();
		for (let i = 0; i < 10; i++) await flush();
		t('a failed refresh says so on the button', btn.classList.contains('gc-refreshBtn--error'));
		t('and marks the figures still shown as old', row.classList.contains('gc-usageRow--stale') && row.textContent.includes('Hourly: 67%'));
		ctx.GeminiCounter.bridge.requestUsage = async () => ({ data: liveUsage() });
		await ctx.GeminiCounter.main.refreshUsage();
		t('a good reading clears the mark', !row.classList.contains('gc-usageRow--stale'));
	}
	{
		// A refresh asked for while a read is out (a reply ending during the poll) is not lost.
		const { ctx } = await page();
		const first = deferred();
		let n = 0;
		ctx.GeminiCounter.bridge.requestUsage = () => { n++; return n === 1 ? first.promise : Promise.resolve({ data: liveUsage() }); };
		const a = ctx.GeminiCounter.main.refreshUsage();
		const b = ctx.GeminiCounter.main.refreshUsage();
		t('a second call joins the read in flight', a === b && n === 1);
		first.resolve({ data: liveUsage() });
		await a;
		for (let i = 0; i < 10; i++) await flush();
		t('and one more read follows it', n === 2, String(n));
	}

	section('conversation reads');
	{
		// Two reads of one chat finishing out of order: the newer one's count stands.
		const { ctx, dom } = await page();
		const raw = fixture('hello-conversation.json')[0];
		const reads = [];
		ctx.GeminiCounter.bridge.requestConversation = () => { const d = deferred(); reads.push(d); return d.promise; };
		ctx.GeminiCounter.main.handleReplyEnd();
		ctx.GeminiCounter.main.handleReplyEnd();
		await flush();
		reads[1].resolve({ turns: [...raw, ...raw] });
		for (let i = 0; i < 5; i++) await flush();
		const newer = chipOf(dom).textContent;
		reads[0].resolve({ turns: raw });
		for (let i = 0; i < 5; i++) await flush();
		t('an older read landing last does not take the count back', chipOf(dom).textContent === newer, `${newer} -> ${chipOf(dom).textContent}`);
	}
	{
		// A read that fails after a reply is tried again, not left showing the old count.
		const { ctx } = await page();
		let n = 0;
		ctx.GeminiCounter.bridge.requestConversation = async () => { n++; if (n === 1) throw new Error('timeout'); return { turns: fixture('hello-conversation.json')[0] }; };
		ctx.GeminiCounter.main.handleReplyEnd();
		t('a failed read after a reply is retried', await waitFor(() => n >= 2, 3500), String(n));
	}
	{
		// More turns than one read takes: counted from the newest, and shown as a floor.
		const { ctx, dom } = await page();
		ctx.GeminiCounter.bridge.requestConversation = async () => ({ turns: fixture('hello-conversation.json')[0], truncated: true });
		ctx.GeminiCounter.main.handleReplyEnd();
		for (let i = 0; i < 10; i++) await flush();
		t('a truncated chat reads as at least the count', /^Token Counter: ≥ \d/.test(chipOf(dom).textContent), chipOf(dom).textContent);
	}

	section('export');
	{
		const { ctx, dom } = await page();
		ctx.GeminiCounter.bridge.requestConversation = async () => ({ turns: [] });
		const menu = ctx.document.body.children.find((c) => c.classList.contains('gc-menu'));
		menu.children[0].click();
		for (let i = 0; i < 10; i++) await flush();
		t('nothing to export shows the error state, not a silent no-op', headerOf(dom).children[0].classList.contains('gc-exportBtn--error'));
	}

	section('plan, late tier label');
	{
		const { El } = require('./harness');
		let info;
		const { GC } = await page({ build: (c) => { info = new El('div').answers('.mavatar-user-info'); c.document.body.appendChild(info); } });
		GC.main.tick();
		t('an account chip without a tier reads FREE', GC.main.readState().plan === 'FREE');
		const label = new El('span').answers('.mavatar-tier-label');
		label.textContent = 'Pro';
		info.appendChild(label);
		GC.main.tick();
		t('and is upgraded when the tier label renders after it', GC.main.readState().plan === 'PRO');
	}

	section('elapsed-time marker');
	{
		const { dom } = await page();
		const marker = rowOf(dom).children[0].children[1].children[1];
		t('a 5-hour window 4 hours from reset shows the marker', marker.classList.contains('gc-bar__marker') && !marker.classList.contains('gc-hidden'));
	}
	{
		// More time left than the window is long proves the nominal wrong: the marker hides, for good.
		const now = Math.floor(Date.now() / 1000);
		const long = [2, [[1, 0.5, 1, [[now + 6 * 3600, 0]]], [1, 0.2, 2, [[now + 3 * 86400, 0]]]], false];
		const { dom, ctx } = await page({ usage: long });
		const marker = rowOf(dom).children[0].children[1].children[1];
		t('a reading longer than the window hides the marker', marker.classList.contains('gc-hidden'));
		ctx.GeminiCounter.bridge.requestUsage = async () => ({ data: liveUsage() });
		await ctx.GeminiCounter.main.refreshUsage();
		t('and an ordinary reading later does not bring it back', marker.classList.contains('gc-hidden'));
	}

	section('window ending while the page is open');
	{
		const now = Date.now();
		const soon = [2, [[1, 0.8, 1, [[Math.ceil((now + 1500) / 1000), 0]]], [1, 0.2, 2, [[Math.floor(now / 1000) + 86400, 0]]]], false];
		const { dom, ctx, calls } = await page({ usage: soon });
		t('shown before it ends', rowOf(dom).textContent.includes('Hourly: 80%'));
		// The confirming read is held open, to see what shows in the meantime.
		ctx.GeminiCounter.bridge.requestUsage = () => { calls.usage++; return new Promise(() => {}); };
		const before = calls.usage;
		// The reset is rounded up to a whole second, so it can be up to 2.5s away.
		await new Promise((r) => setTimeout(r, 2600));
		ctx.GeminiCounter.main.tick();
		for (let i = 0; i < 10; i++) await flush();
		t('it rolls straight into the next window, empty, never "—"', /Hourly: 0% \(resets in (4h 59m|5h 0m)\)/.test(rowOf(dom).textContent), rowOf(dom).textContent);
		t('and usage is read to confirm it', calls.usage > before);
	}

	process.exit(report('page'));
})();
