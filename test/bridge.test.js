// The page-world bridge, run as shipped against a fake fetch that answers with
// Gemini's real envelope format.
const { loadWith, envelope, fixture, flush, section, t, report } = require('./harness');

const ORIGIN = 'https://gemini.google.com';

function bridge({ answer, status = 200, signedIn = true } = {}) {
	const calls = [];
	const ctx = loadWith({
		setup(c) {
			c.window.WIZ_global_data = signedIn ? { SNlM0e: 'AT_TOKEN', cfb2h: 'boq_gemini_test', FdrFJe: '123' } : {};
			c.document.documentElement.lang = 'en';
			c.fetch = async (url, init) => {
				calls.push({ url, init, body: new URLSearchParams(init.body) });
				const rpc = new URL(url, ORIGIN).searchParams.get('rpcids');
				return { ok: status < 400, status, text: async () => answer(rpc, calls.length, JSON.parse(JSON.parse(new URLSearchParams(init.body).get('f.req'))[0][0][1])) };
			};
		}
	}, 'src/injected/bridge.js');
	const ask = async (kind, payload, origin = ORIGIN) => {
		const requestId = 'r' + Math.random();
		for (const fn of ctx.window._handlers.message) fn({ source: ctx.window, origin, data: { gc: 'GeminiCounter', type: 'gc:request', requestId, kind, payload } });
		for (let i = 0; i < 20; i++) await flush();
		return ctx.__posted.find((p) => p.data.requestId === requestId);
	};
	return { ctx, calls, ask };
}

(async () => {
	section('usage');
	{
		const b = bridge({ answer: (rpc) => envelope(rpc, fixture('usage-pro.json')) });
		const reply = await b.ask('usage', {});
		t('answered ok', reply?.data.ok === true, JSON.stringify(reply?.data).slice(0, 200));
		t('the decoded answer comes back', JSON.stringify(reply.data.payload.data) === JSON.stringify(fixture('usage-pro.json')));
		t('the build label rides along', reply.data.payload.build === 'boq_gemini_test');
		t('reply addressed to the page origin, never "*"', reply.origin === ORIGIN);
		const call = b.calls[0];
		t('the usage RPC is jSf9Qc', new URL(call.url, ORIGIN).searchParams.get('rpcids') === 'jSf9Qc');
		t('sent with the page token', call.body.get('at') === 'AT_TOKEN');
		t('on the account of the page (/u/1)', call.url.startsWith('/u/1/_/BardChatUi/data/batchexecute?'));
		t('POST with cookies', call.init.method === 'POST' && call.init.credentials === 'include');
	}

	section('conversation, paged');
	{
		const turns = fixture('hello-conversation.json')[0];
		const b = bridge({
			answer: (rpc, n) => envelope(rpc, n === 1 ? [turns, 'NEXT_PAGE', [], null, 2] : [turns, null, [], null, 2])
		});
		const reply = await b.ask('conversation', { conversationId: '80eeb4ca73c8a8fa' });
		t('both pages fetched', b.calls.length === 2);
		t('second page asked with the first page’s token', JSON.parse(JSON.parse(b.calls[1].body.get('f.req'))[0][0][1])[2] === 'NEXT_PAGE');
		t('the id is sent the way Gemini sends it, c_ prefixed', JSON.parse(JSON.parse(b.calls[0].body.get('f.req'))[0][0][1])[0] === 'c_80eeb4ca73c8a8fa');
		t('turns of both pages come back', reply.data.payload.turns.length === 2);
		t('a chat read to its end is not marked truncated', reply.data.payload.truncated === false);
	}
	{
		// The same token twice would read the same page again and count it twice.
		const turns = fixture('hello-conversation.json')[0];
		const b = bridge({ answer: (rpc) => envelope(rpc, [turns, 'SAME', [], null, 2]) });
		const reply = await b.ask('conversation', { conversationId: '80eeb4ca73c8a8fa' });
		t('a repeated page token stops the read', b.calls.length === 2 && reply.data.payload.turns.length === 2, String(b.calls.length));
	}
	{
		// A chat longer than the page ceiling comes back as what was read, marked.
		const turns = fixture('hello-conversation.json')[0];
		const b = bridge({ answer: (rpc, n) => envelope(rpc, [turns, `PAGE_${n}`, [], null, 2]) });
		const reply = await b.ask('conversation', { conversationId: '80eeb4ca73c8a8fa' });
		for (let i = 0; i < 60; i++) await flush();
		t('the page ceiling holds (40 requests)', b.calls.length === 40, String(b.calls.length));
		t('and the answer says older turns are missing', reply?.data.payload.truncated === true);
	}

	section('the popup reads answers as the bridge does');
	{
		const { load } = require('./harness');
		const GC = load('src/content/constants.js').GeminiCounter;
		const usage = fixture('usage-pro.json');
		t('a real envelope', JSON.stringify(GC.batchAnswer(envelope('jSf9Qc', usage), 'jSf9Qc')) === JSON.stringify(usage));
		const tricky = [['a "quoted ] bracket" and \\ backslash', '[not a frame']];
		t('brackets and quotes inside strings', JSON.stringify(GC.batchAnswer(envelope('jSf9Qc', tricky), 'jSf9Qc')) === JSON.stringify(tricky));
		t('another RPC’s answer is not taken', GC.batchAnswer(envelope('hNvQHb', usage), 'jSf9Qc') === null);
		t('no answer at all', GC.batchAnswer(')]}\'\n\n12\n[["e",4]]\n', 'jSf9Qc') === null);
	}

	section('refusals');
	{
		const b = bridge({ answer: (rpc) => envelope(rpc, []) });
		for (const bad of ['../../x', 'c_abc', 'ABCDEF12', '1234', 'x'.repeat(65), '', null]) {
			const reply = await b.ask('conversation', { conversationId: bad });
			t(`bad id ${JSON.stringify(bad)} refused before any request`, reply?.data.ok === false);
		}
		t('no request went out for any of them', b.calls.length === 0);
		const unknown = await b.ask('send', {});
		t('a kind it does not know is refused', unknown?.data.ok === false && b.calls.length === 0);
		const proto = await b.ask('toString', {});
		t('not even an inherited name', proto?.data.ok === false);
		const foreign = await b.ask('usage', {}, 'https://evil.example');
		t('a message from another origin is ignored', foreign === undefined && b.calls.length === 0);
	}
	{
		const b = bridge({ status: 401, answer: () => '{"error":"x"}' });
		const reply = await b.ask('usage', {});
		t('an HTTP error is a failed request, not data', reply?.data.ok === false && /401/.test(reply.data.error));
	}
	{
		const b = bridge({ signedIn: false, answer: (rpc) => envelope(rpc, []) });
		const reply = await b.ask('usage', {});
		t('signed out: no token, no request', reply?.data.ok === false && b.calls.length === 0);
	}
	{
		const b = bridge({ answer: () => ")]}'\n\n40\n[[\"wrb.fr\",\"jSf9Qc\",null,null,null,[3],\"generic\"]]\n" });
		const reply = await b.ask('usage', {});
		t('an RPC error entry (no payload) is a failure', reply?.data.ok === false);
	}
	{
		// A chunk that does not parse, before the real one, must not lose the answer.
		const b = bridge({ answer: (rpc) => `)]}'\n\n6\n[oops]\n` + envelope(rpc, fixture('usage-free.json')).slice(5) });
		const reply = await b.ask('usage', {});
		t('a malformed chunk is skipped, the answer still found', reply?.data.ok === true, JSON.stringify(reply?.data).slice(0, 120));
	}

	process.exit(report('bridge'));
})();
