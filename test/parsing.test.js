// What the two RPC answers turn into. Usage from real Pro and free responses; the
// conversation from a real one-turn chat plus turns built to the recorded shapes.
const { load, fixture, section, t, report } = require('./harness');

const ctx = load('src/content/constants.js', 'src/vendor/o200k_base.js', 'src/content/conversation.js');
const GC = ctx.GeminiCounter;

section('usage: real responses');
const pro = GC.parseUsage(fixture('usage-pro.json'));
t('Pro: kind 1 is the 5-hour window, as a percentage', pro.session.utilization === 67, JSON.stringify(pro.session));
t('Pro: kind 2 is the weekly window', Math.abs(pro.weekly.utilization - 23.2) < 0.01, JSON.stringify(pro.weekly));
t('Pro: reset is epoch seconds turned ISO', pro.session.resets_at === new Date(1792284410 * 1000).toISOString());
const free = GC.parseUsage(fixture('usage-free.json'));
t('free: windows are reported, at 0%', free.session.utilization === 0 && free.weekly.utilization === 0);

section('usage: shapes that must not render');
t('no list is no usage', GC.parseUsage([2, null]) === null);
t('a ratio out of range is skipped', GC.parseUsage([2, [[1, 1.5, 1, [[1, 0]]]]]) === null);
t('a ratio that is not a number is skipped', GC.parseUsage([2, [[1, 'x', 1, [[1, 0]]]]]) === null);
t('an unknown kind is ignored', GC.parseUsage([2, [[1, 0.5, 4, [[1, 0]]]]]) === null);
const noReset = GC.parseUsage([2, [[1, 0.5, 1, null]]]);
t('a window without a reset time keeps its figure', noReset.session.utilization === 50 && noReset.session.resets_at === null);
t('windowEnded: past reset', GC.windowEnded({ resets_at: new Date(Date.now() - 1000).toISOString() }));
t('windowEnded: no reset time has not ended', !GC.windowEnded({ resets_at: null }));
{
	// Gemini's windows are a fixed grid: the one after an ended window started at its end.
	const H5 = 5 * 3600e3;
	const endedAt = Date.now() - 2 * H5 - 60e3;
	const next = GC.currentWindow({ utilization: 80, resets_at: new Date(endedAt).toISOString() }, 'session');
	t('currentWindow: an ended window gives the one running now, empty', next.utilization === 0 && Date.parse(next.resets_at) === endedAt + 3 * H5);
	const live = { utilization: 30, resets_at: new Date(Date.now() + 60e3).toISOString() };
	t('currentWindow: a running window is left as it is', GC.currentWindow(live, 'session') === live);
	const week = GC.currentWindow({ utilization: 50, resets_at: new Date(Date.now() - 1000).toISOString() }, 'weekly');
	t('currentWindow: the weekly one rolls by a week', Math.abs(Date.parse(week.resets_at) - (Date.now() - 1000 + 7 * 24 * 3600e3)) < 50);
}

section('account from the path');
t('/u/1/app is account 1', GC.accountFromPath('/u/1/app/abc') === '1');
t('/app is account 0', GC.accountFromPath('/app') === '0');
t('/u/12 is account 12', GC.accountFromPath('/u/12') === '12');

section('conversation: real one-turn chat');
const real = GC.conversation.parseConversation({ turns: fixture('hello-conversation.json')[0] });
t('one turn', real.length === 1);
t('prompt text', real[0].prompt === 'Reply with just the word: hello', real[0].prompt);
t('reply text', real[0].reply === 'hello', real[0].reply);
t('model name as Gemini shows it', real[0].model === '3.1 Pro');
t('created at, in ms', real[0].createdAt === 1792267777000);
const realMetrics = GC.conversation.computeMetrics(real);
// "Reply with just the word: hello" + "hello", not the thinking.
const expected = ctx.GPTTokenizer_o200k_base.countTokens('Reply with just the word: hello') + ctx.GPTTokenizer_o200k_base.countTokens('hello');
t('count is prompt + reply, thinking left out', realMetrics.totalTokens === expected, `${realMetrics.totalTokens} vs ${expected}`);

section('conversation: drafts, documents, files, order');
function draft(id, text, extra = {}) {
	const d = new Array(38).fill(null);
	d[0] = id;
	d[1] = [text];
	for (const [k, v] of Object.entries(extra)) d[k] = v;
	return d;
}
function turn({ id, prompt, drafts, chosen, model = '', seconds, files }) {
	const response = new Array(32).fill(null);
	response[0] = drafts;
	response[3] = chosen;
	response[21] = model;
	const p = [prompt, null, null, null, files ? [[null, null, null, files]] : [[]]];
	return [['c_x', id], null, [p, 2], response, [seconds, 0]];
}
const docText = '# Report\n\nLong findings here.';
const turns = GC.conversation.parseConversation({
	turns: [
		// newest first, as the RPC sends them
		turn({ id: 'r_2', prompt: 'second', drafts: [draft('rc_a', 'draft A'), draft('rc_b', 'draft B')], chosen: 'rc_b', model: '3.1 Flash', seconds: 20 }),
		turn({
			id: 'r_1', prompt: 'first',
			drafts: [draft('rc_x', "I've completed your research.\n\nhttp://googleusercontent.com/immersive_entry_chip/0", { 30: [['im_1', null, 'Job Research', 'task', docText]] })],
			chosen: 'rc_x', model: '3.1 Pro', seconds: 10,
			files: [[null, 11, 'report.pdf', null, null, 'tok', null, [], 1, [1, 0], null, 'application/pdf']]
		})
	]
});
t('oldest first', turns[0].prompt === 'first' && turns[1].prompt === 'second');
t('the draft on screen, not the first one', turns[1].reply === 'draft B');
t('Deep Research document read', turns[0].docs.length === 1 && turns[0].docs[0].title === 'Job Research' && turns[0].docs[0].text === docText);
t('uploaded file: name and type', turns[0].files[0]?.name === 'report.pdf' && turns[0].files[0]?.mime === 'application/pdf');
t('document chip placeholder is not counted or exported', GC.conversation.cleanReply(turns[0].reply) === "I've completed your research.");
const m = GC.conversation.computeMetrics(turns);
{
	// Text that only mentions a special token counted 0 before: the tokenizer threw on it.
	const special = GC.conversation.computeMetrics([{ prompt: 'what does <|endoftext|> mean?', reply: 'It ends a document.', docs: [], files: [] }]);
	t('a message mentioning <|endoftext|> is still counted', special.totalTokens > 5, String(special.totalTokens));
}
const count = (s) => ctx.GPTTokenizer_o200k_base.countTokens(s);
t('documents count toward the total', m.totalTokens === count('first') + count("I've completed your research.") + count(docText) + count('second') + count('draft B'), String(m.totalTokens));

section('conversation: a moved field reads as missing, never throws');
let threw = false;
let odd;
try {
	odd = GC.conversation.parseConversation({ turns: [null, 'x', [1, 2, 3], [[], null, 'nope', { a: 1 }]] });
} catch {
	threw = true;
}
t('no throw on garbage', !threw);
t('garbage turns are empty, not invented', odd.every((x) => x.prompt === '' && x.reply === ''));
t('nothing at all is no turns', GC.conversation.parseConversation(null).length === 0);

process.exit(report('parsing'));
