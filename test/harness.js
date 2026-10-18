// Minimal DOM shim + module loader, so the shipped content scripts run in Node.
//
// Selectors are not parsed. An element is told which selectors it answers to
// (`el.answers('top-bar-actions')`), and querySelector/closest look for that. It
// keeps the shim tiny while still letting a test build the page shape a selector
// expects, and a test that forgets to say what an element is fails visibly.
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

class El {
	constructor(tag) {
		this.tag = tag;
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.parentElement = null;
		this._text = null;
		this._sel = new Set();
		this.style = { setProperty(k, v) { this[k] = String(v); }, getPropertyValue(k) { return this[k] ?? ''; } };
		this.attrs = {};
		this.dataset = {};
		const set = new Set();
		this.classList = {
			_s: set,
			add: (...c) => c.forEach((x) => this.classList._s.add(x)),
			remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
			toggle: (c, f) => {
				const on = f === undefined ? !this.classList._s.has(c) : !!f;
				if (on) this.classList._s.add(c); else this.classList._s.delete(c);
				return on;
			},
			contains: (c) => this.classList._s.has(c)
		};
	}
	/** Declare which selectors this element matches. Chainable. */
	answers(...sels) { for (const s of sels) this._sel.add(s); return this; }
	matchesSel(sel) {
		return sel.split(',').map((s) => s.trim()).some((s) => this._sel.has(s) || (s.startsWith('.') && this.classList.contains(s.slice(1))));
	}
	get textContent() { return this._text !== null ? this._text : this.children.map((c) => c.textContent).join(''); }
	set textContent(v) { this._text = String(v); this.children = []; }
	// The set is the single source of truth; the string derives from it, as in a real element.
	set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
	get className() { return [...this.classList._s].join(' '); }
	appendChild(c) { if (c.parentElement) c.remove(); this._text = null; c.parentElement = this; this.children.push(c); return c; }
	append(...c) { for (const x of c) this.appendChild(x); }
	prepend(c) { return this.insertBefore(c, this.children[0] || null); }
	removeAttribute(k) { delete this.attrs[k]; }
	replaceChildren(...c) { for (const x of this.children) x.parentElement = null; this._text = null; for (const x of c) { if (x.parentElement && x.parentElement !== this) x.remove(); x.parentElement = this; } this.children = [...c]; }
	insertBefore(c, ref) {
		if (c.parentElement) c.remove();
		this._text = null;
		c.parentElement = this;
		const i = ref ? this.children.indexOf(ref) : -1;
		if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
		return c;
	}
	after(n) { const p = this.parentElement; if (p) p.insertBefore(n, this.nextElementSibling); }
	remove() {
		const p = this.parentElement;
		if (p) p.children = p.children.filter((x) => x !== this);
		this.parentElement = null;
	}
	get firstElementChild() { return this.children[0] || null; }
	get firstChild() { return this.children[0] || null; }
	get lastChild() { return this.children[this.children.length - 1] || null; }
	get lastElementChild() { return this.lastChild; }
	get nextElementSibling() {
		const sibs = this.parentElement ? this.parentElement.children : [];
		const i = sibs.indexOf(this);
		return i < 0 ? null : sibs[i + 1] || null;
	}
	contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
	closest(sel) { for (let x = this; x; x = x.parentElement) if (x.matchesSel?.(sel)) return x; return null; }
	querySelector(sel) {
		for (const c of this.children) {
			if (c.matchesSel?.(sel)) return c;
			const deep = c.querySelector?.(sel);
			if (deep) return deep;
		}
		return null;
	}
	setAttribute(k, v) { this.attrs[k] = String(v); }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	hasAttribute(k) { return k in this.attrs; }
	addEventListener(type, fn) { ((this._handlers = this._handlers || {})[type] = (this._handlers[type] || [])).push(fn); }
	fire(type, event = {}) { for (const fn of (this._handlers && this._handlers[type]) || []) fn({ stopPropagation() {}, preventDefault() {}, ...event }); }
	click() { this.fire('click'); }
	focus() {}
	getBoundingClientRect() { return this._rect || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
	// No layout: a part counts as painted, as the UI's own rule says for this case.
	getClientRects() { return undefined; }
}

function makeContext({ pathname = '/u/1/app/80eeb4ca73c8a8fa' } = {}) {
	const body = new El('body');
	const document = {
		documentElement: new El('html'),
		body,
		hidden: false,
		title: 'A Simple Greeting - Google Gemini',
		activeElement: null,
		createElement: (tag) => new El(tag),
		createElementNS: (_ns, tag) => new El(tag),
		createTextNode: (text) => { const n = new El('#text'); n.textContent = text; return n; },
		querySelector: (sel) => (body.matchesSel(sel) ? body : body.querySelector(sel)),
		contains: (n) => body.contains(n),
		addEventListener(type, fn) { ((this._handlers = this._handlers || {})[type] = (this._handlers[type] || [])).push(fn); }
	};
	const posted = [];
	const ctx = {
		document, console, Date, Math, Object, String, Number, JSON, Array, Set, Map, RegExp,
		setTimeout, clearTimeout, isNaN, parseInt, parseFloat, Promise, URL, URLSearchParams, Error, TypeError, Symbol, Boolean,
		// The vendored tokenizer needs these.
		TextEncoder, TextDecoder,
		Blob: class { constructor(parts) { this.text = parts.join(''); } },
		// main.js starts a 1s clock; left real it would keep the process alive. Suites drive tick().
		setInterval: () => 0,
		clearInterval: () => {},
		// Nothing under test should reach the network unless the suite provides a fetch.
		fetch: () => Promise.reject(new Error('no network in tests')),
		MutationObserver: class { constructor(fn) { ctx.__observers.push(fn); } observe() {} disconnect() {} },
		__observers: [],
		__posted: posted,
		window: {
			getComputedStyle: () => ({}),
			innerWidth: 1400, innerHeight: 900,
			addEventListener(type, fn) { ((this._handlers = this._handlers || {})[type] = (this._handlers[type] || [])).push(fn); },
			postMessage(data, origin) { posted.push({ data, origin }); },
			location: { pathname, origin: 'https://gemini.google.com', href: `https://gemini.google.com${pathname}` }
		}
	};
	ctx.window.window = ctx.window;
	ctx.window.fetch = (...a) => ctx.fetch(...a);
	ctx.window.document = document;
	ctx.location = ctx.window.location;
	ctx.navigator = { userAgent: 'node' };
	ctx.globalThis = ctx;
	return vm.createContext(ctx);
}

/**
 * Load files into a fresh sandbox and return it. `globals` are installed before
 * any file runs; `setup(ctx)` can shape the document first.
 */
function loadWith(globals, ...files) {
	const { setup, pathname, ...rest } = globals;
	const ctx = makeContext({ pathname });
	Object.assign(ctx, rest);
	if (setup) setup(ctx);
	for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
	return ctx;
}

const load = (...files) => loadWith({}, ...files);

/** Run one more file in an existing sandbox, after a test has shaped it. */
const run = (ctx, file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });

/** A `chrome.storage.local` stand-in, preloaded with `items`. */
function fakeChrome(items = {}) {
	const store = { ...items };
	return {
		storage: {
			local: {
				get: (key) => Promise.resolve(typeof key === 'string' && key in store ? { [key]: store[key] } : {}),
				set: (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); return Promise.resolve(); },
				remove: (key) => { delete store[key]; return Promise.resolve(); }
			},
			onChanged: { addListener() {} }
		},
		_store: store
	};
}

/** The page shape Gemini had on 2026-10-18, as far as the extension looks at it. */
function geminiPage(ctx) {
	const el = (tag, ...sels) => new El(tag).answers(tag, ...sels);
	const topBar = el('top-bar-actions');
	// As on 2026-10-18: an empty upsell container, then the one holding the menu.
	const right = el('div', 'top-bar-actions .right-section');
	const upsell = el('div', '.buttons-container');
	const menu = el('div', '.buttons-container');
	right.append(upsell, menu);
	topBar.appendChild(right);
	const inputContainer = el('input-container');
	const container = el('div', '.input-area-container');
	// The card is a flex row; its one child is a plain block holding the field.
	const area = el('input-area-v2');
	const inner = el('div', 'input-area-v2 .input-area');
	const fieldset = el('fieldset');
	const textarea = el('rich-textarea');
	fieldset.appendChild(textarea);
	inner.appendChild(fieldset);
	area.appendChild(inner);
	container.appendChild(area);
	const disclaimer = el('hallucination-disclaimer');
	inputContainer.append(container, disclaimer);
	// The chat column: the token chip is held to its top left.
	const column = el('div', '.main-content');
	column.appendChild(inputContainer);
	ctx.document.body.append(topBar, column);
	return { topBar, right, upsell, menu, column, container, area, inner, fieldset, textarea, disclaimer, El };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let pass = 0;
let fail = 0;

function section(name) {
	console.log('\n  ' + name);
}

function t(label, cond, detail) {
	if (cond) {
		pass += 1;
		console.log('    PASS  ' + label);
	} else {
		fail += 1;
		console.log('    FAIL  ' + label);
		if (detail !== undefined) console.log('          ' + detail);
	}
}

function report(suite) {
	console.log('\n  ' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + '  ' + suite + ' (' + pass + '/' + (pass + fail) + ')');
	return fail;
}

/** Wrap an RPC answer in the batchexecute envelope Gemini sends (seen 2026-10-18). */
function envelope(rpc, inner) {
	const entry = JSON.stringify([['wrb.fr', rpc, JSON.stringify(inner), null, null, null, 'generic'], ['di', 141], ['af.httprm', 141, '5478702587613838077', 33]]);
	return `)]}'\n\n${entry.length}\n${entry}\n26\n[["e",4,null,null,${entry.length}]]\n`;
}

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

module.exports = { El, load, loadWith, run, fakeChrome, geminiPage, flush, envelope, fixture, section, t, report };
