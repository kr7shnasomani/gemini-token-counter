// The toolbar popup, run as shipped (constants.js then popup.js) against a page
// built from popup.html's own ids, a fake extension storage and a fake fetch
// speaking Gemini's envelope. Covers the account picker, the popup's refresh and
// what a bug report sends.
const fs = require('fs');
const path = require('path');
const { El, loadWith, run, envelope, fixture, flush, section, t, report } = require('./harness');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup', 'popup.html'), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const later = (ms) => new Date(Date.now() + ms).toISOString();
const reading = (account, email, plan, used, updatedAt = Date.now()) => ({
	account, email, plan, updatedAt,
	session: { utilization: used, resets_at: later(3600e3) },
	weekly: { utilization: used, resets_at: later(3 * DAY) }
});
const twoAccounts = () => ({
	'gc:usageSnapshot:0': reading('0', 'free@example.com', 'FREE', 10, Date.now() - 3600e3),
	'gc:usageSnapshot:1': reading('1', 'pro@example.com', 'PRO', 40)
});
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await flush(); };

/** Gemini's app page and usage answer, as the popup's refresh fetches them. */
const gemini = ({ email = '', url } = {}) => async (target) => ({
	ok: true, status: 200,
	url: url || target,
	text: async () => (target.endsWith('/app')
		? `<script>window.WIZ_global_data = {"SNlM0e":"tok","cfb2h":"boq","FdrFJe":"1"${email ? `,"oPEP7c":"${email}"` : ''}};</script>`
		: envelope('jSf9Qc', usage()))
});

/** Pro's real usage answer (fixtures/usage-pro.json) with its resets moved into the future. */
function usage() {
	const answer = fixture('usage-pro.json');
	for (const w of answer[1]) w[3] = [[Math.floor((Date.now() + 3 * DAY) / 1000), 0]];
	return answer;
}

/** `chrome.storage.local` with `get(null)` and `remove([...])`, which the popup uses. */
function storageWith(items, { failGet = false } = {}) {
	const store = { ...items };
	const local = {
		get: async (key) => {
			if (failGet && key === null) throw new Error('storage unavailable');
			return key === null ? { ...store } : key in store ? { [key]: store[key] } : {};
		},
		set: async (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
		remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
	};
	return { store, chrome: { storage: { local, onChanged: { addListener() {} } }, permissions: { request: async () => true } } };
}

async function popup({ store = {}, fetch, failGet } = {}) {
	const { store: saved, chrome } = storageWith(store, { failGet });
	const byId = {};
	const opened = [];
	const ctx = loadWith({
		chrome,
		fetch: fetch || (() => Promise.reject(new Error('no network in tests'))),
		setup(c) {
			const doc = c.document;
			for (const [, id] of HTML.matchAll(/\bid="([^"]+)"/g)) byId[id] = new El('div').answers(`#${id}`);
			// Hidden as popup.html starts them.
			for (const id of ['accountRow', 'accountMenu', 'back', 'content', 'settings', 'feedback']) byId[id].hidden = true;
			// The parts the popup reaches by more than an id.
			const head = new El('div').answers('.head');
			byId.accountRow.append(byId.accountBtn, byId.accountMenu, byId.accountName);
			byId.feedbackText.value = '';
			// The settings switches, one per data-key the page really has.
			const boxes = [...HTML.matchAll(/data-key="(\w+)"/g)].map(([, key]) => {
				const box = new El('input').answers('#settings input', '.opt input[data-key]');
				box.dataset.key = key;
				return box;
			});
			byId.settings.append(...boxes);
			doc.body.append(head, ...Object.values(byId).filter((el) => !el.parentElement));
			doc.getElementById = (id) => byId[id] || null;
			const all = (el) => el.children.flatMap((kid) => [kid, ...all(kid)]);
			doc.querySelectorAll = (sel) => all(doc.body).filter((el) => el.matchesSel(sel));
			El.prototype.focus = function focus() { doc.activeElement = this; };
			c.window.open = (url) => opened.push(url);
		}
	}, 'src/content/constants.js');
	run(ctx, 'src/popup/popup.js');
	await settle(10);
	const items = () => byId.accountMenu.children;
	const pick = (account) => byId.accountMenu.fire('click', { target: items().find((i) => i.dataset.account === account) });
	const key = (name) => { for (const fn of ctx.document._handlers.keydown) fn({ key: name, preventDefault() {} }); };
	return { ctx, byId, saved, items, pick, key, opened };
}

(async () => {
	section('which account is shown');
	{
		const { byId, items } = await popup({ store: twoAccounts() });
		t('before any pick, the newest reading', byId.accountName.textContent === 'pro@example.com');
		t('with its plan in the chip', byId.plan.textContent === 'PRO' && !byId.plan.hidden);
		t('and its figures', byId.sessionValue.textContent === '40% used');
		t('the menu lists both accounts, by number', items().map((i) => i.dataset.account).join() === '0,1');
		t('the one shown is checked', items().find((i) => i.dataset.account === '1').getAttribute('aria-checked') === 'true');
		t('the name is a menu button', byId.accountBtn.getAttribute('aria-haspopup') === 'menu');
	}
	{
		const { byId } = await popup({ store: { ...twoAccounts(), 'gc:popupAccount': '0' } });
		t('the last pick wins over the newest reading', byId.accountName.textContent === 'free@example.com' && byId.sessionValue.textContent === '10% used');
	}
	{
		const { byId } = await popup({ store: { 'gc:usageSnapshot:1': reading('1', '', 'PRO', 40) } });
		t('one account: named, nothing to pick', byId.accountRow.classList.contains('account--single') && !byId.accountRow.hidden);
		t('and not announced as a menu button', byId.accountBtn.getAttribute('aria-haspopup') === null && byId.accountBtn.getAttribute('aria-expanded') === null);
		t('with no email, by its number counted from one', byId.accountName.textContent === 'Account 2');
		byId.accountBtn.click();
		t('and the button opens no menu', byId.accountMenu.hidden === true);
	}
	{
		const { byId } = await popup();
		t('no reading at all: no account row', byId.accountRow.hidden === true);
		t('and the empty view', byId.empty.hidden === false && byId.content.hidden === true);
	}
	{
		const { byId } = await popup({ store: twoAccounts(), failGet: true });
		t('stored readings that cannot be read say so, not "no usage yet"', byId.stamp.textContent === "Couldn't read saved usage");
	}

	section('picking');
	{
		const { byId, saved, pick, ctx } = await popup({ store: twoAccounts() });
		byId.accountBtn.click();
		t('the button opens the menu', byId.accountMenu.hidden === false && byId.accountBtn.getAttribute('aria-expanded') === 'true');
		pick('0');
		await flush();
		t('picking shows that account', byId.accountName.textContent === 'free@example.com' && byId.sessionValue.textContent === '10% used' && byId.plan.textContent === 'FREE');
		t('and remembers the pick', saved['gc:popupAccount'] === '0');
		t('the menu closes, focus back on its button', byId.accountMenu.hidden === true && ctx.document.activeElement === byId.accountBtn);
	}
	{
		const { byId, items, ctx, key } = await popup({ store: twoAccounts() });
		byId.accountBtn.click();
		byId.accountMenu.fire('keydown', { key: 'ArrowUp' });
		t('arrow up from the first item wraps to the last', ctx.document.activeElement === items()[1]);
		byId.accountMenu.fire('keydown', { key: 'ArrowDown' });
		t('arrow down from the last wraps to the first', ctx.document.activeElement === items()[0]);
		byId.accountMenu.fire('keydown', { key: 'Tab' });
		t('Tab leaves the menu closed, focus on its button', byId.accountMenu.hidden === true && ctx.document.activeElement === byId.accountBtn);
		byId.accountBtn.click();
		for (const fn of ctx.document._handlers.click) fn({ target: ctx.document.body });
		t('a click outside closes the menu', byId.accountMenu.hidden === true);
		byId.settingsBtn.click();
		byId.accountBtn.click();
		key('Escape');
		t('Escape over settings closes only the menu', byId.accountMenu.hidden === true && byId.settings.hidden === false);
		key('Escape');
		t('and the next Escape goes back to usage', byId.settings.hidden === true && byId.content.hidden === false);
	}
	{
		const { byId, pick } = await popup({ store: twoAccounts() });
		byId.settingsBtn.click();
		byId.accountBtn.click();
		pick('0');
		await flush();
		t('picking on settings keeps settings open', byId.settings.hidden === false && byId.content.hidden === true);
		t('and names the picked account', byId.accountName.textContent === 'free@example.com');
	}

	section('stored readings');
	{
		const { byId, saved } = await popup({ store: {
			'gc:usageSnapshot:0': reading('0', 'gone@example.com', 'FREE', 10, Date.now() - 31 * DAY),
			'gc:usageSnapshot:1': reading('1', 'pro@example.com', 'PRO', 40, Date.now() - 3600e3),
			'gc:usageSnapshot:2': reading('2', 'new@example.com', 'PRO', 20),
			'gc:popupAccount': '0',
			'gc:settings': { tokenCounter: false },
			'gc:feedbackDraft': 'half a report',
			'gc:diag': { build: 'boq' }
		} });
		t('an account with no reading for 30 days is forgotten', !('gc:usageSnapshot:0' in saved));
		t('and is not offered', byId.accountMenu.children.every((i) => i.dataset.account !== '0'));
		t('a pick of it falls back to the newest reading', byId.accountName.textContent === 'new@example.com');
		t('nothing else in storage is touched', !!saved['gc:settings'] && saved['gc:feedbackDraft'] === 'half a report' && !!saved['gc:diag'] && !!saved['gc:usageSnapshot:1']);
	}

	section('refresh');
	{
		const { byId, saved } = await popup({ store: twoAccounts(), fetch: gemini({ email: 'pro@example.com' }) });
		byId.refresh.click();
		await settle();
		t('a refresh shows its figures', byId.sessionValue.textContent === '67% used' && byId.stamp.textContent === 'Updated just now');
		t('and saves what it shows', saved['gc:usageSnapshot:1'].session.utilization === 67 && saved['gc:usageSnapshot:1'].email === 'pro@example.com');
		t('the busy state ends', byId.refresh.getAttribute('aria-disabled') === null);
	}
	{
		// The page fetch waits, so another account can be picked while it is out.
		let releasePage;
		const pageReady = new Promise((r) => { releasePage = r; });
		const urls = [];
		const answer = gemini({ email: 'pro@example.com' });
		const fetch = async (url) => {
			urls.push(url);
			if (url.endsWith('/app')) await pageReady;
			return answer(url);
		};
		const { byId, saved, pick } = await popup({ fetch, store: twoAccounts() });
		byId.refresh.click();
		await settle(5);
		t('refresh reads the account shown', urls[0] === 'https://gemini.google.com/u/1/app');
		pick('0');
		releasePage();
		await settle();
		const one = saved['gc:usageSnapshot:1'];
		t('the reading lands on the account it was asked for', one.session.utilization === 67 && one.weekly.utilization === 23.2);
		t('which keeps its own plan', one.plan === 'PRO' && one.email === 'pro@example.com');
		t('the other account is untouched', saved['gc:usageSnapshot:0'].session.utilization === 10 && saved['gc:usageSnapshot:0'].email === 'free@example.com');
		t('and stays the one shown', byId.accountName.textContent === 'free@example.com' && byId.sessionValue.textContent === '10% used');
	}
	{
		const { byId, saved } = await popup({ store: twoAccounts(), fetch: gemini() });
		byId.refresh.click();
		await settle();
		t('a page with no email leaves none, not an older account’s', saved['gc:usageSnapshot:1'].email === '' && byId.accountName.textContent === 'Account 2');
	}
	{
		// Google sends a /u/N that is no longer signed in to another account's page.
		const { byId, saved } = await popup({ store: twoAccounts(), fetch: gemini({ url: 'https://gemini.google.com/app' }) });
		byId.refresh.click();
		await settle();
		t('another account’s page is not stored as this one', saved['gc:usageSnapshot:1'].session.utilization === 40);
		t('and says so', byId.stamp.textContent.startsWith('Sign in to Gemini to refresh'));
	}
	{
		const { byId, saved } = await popup({ store: twoAccounts(), fetch: () => Promise.reject(new Error('offline')) });
		byId.refresh.click();
		await settle();
		t('a failed refresh says so', byId.stamp.textContent.startsWith("Couldn't refresh"));
		t('keeps the figures it had', byId.sessionValue.textContent === '40% used' && saved['gc:usageSnapshot:1'].session.utilization === 40);
		t('and can be tried again', byId.refresh.getAttribute('aria-disabled') === null);
	}
	{
		const { byId, saved } = await popup({ fetch: gemini({ email: 'first@example.com' }) });
		byId.refresh.click();
		await settle();
		t('with nothing stored, refresh reads the first account', saved['gc:usageSnapshot:0']?.session.utilization === 67);
		t('and names it from the page', byId.accountName.textContent === 'first@example.com');
	}

	section('a bug report');
	{
		// What leaves the machine: the URL of the GitHub issue, nothing else.
		const store = { ...twoAccounts(), 'gc:diag': { account: '1', build: 'boq_test', plan: 'PRO', usageFrom: 'rpc', theme: 'dark' } };
		const { byId, opened } = await popup({ store });
		byId.feedbackBtn.click();
		byId.feedbackText.value = 'The weekly bar went missing';
		byId.feedbackText.fire('input');
		byId.feedbackSend.click();
		await settle();
		const sent = decodeURIComponent(opened[0] || '');
		t('the report opens as a GitHub issue', sent.startsWith('https://github.com/') && sent.includes('The weekly bar went missing'));
		t('it carries the page details', sent.includes('boq_test'));
		t('never the account’s email', !sent.includes('pro@example.com') && !sent.includes('free@example.com') && !sent.includes('@'));
		t('nor the account number', !sent.includes('/u/1') && !/account\W+1\b/i.test(sent));
	}

	process.exit(report('popup'));
})();
