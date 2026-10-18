(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	/*
	 * A Gemini turn, as `hNvQHb` returns it: positional arrays, no field names.
	 * Read off real responses on 2026-10-18 (a one-line chat, a Deep Research
	 * chat, a chat with two PDFs):
	 *
	 *   turn[0]        [conversationId, responseId]
	 *   turn[2][0][0]  the prompt text
	 *   turn[2][0][4][0][3]  uploaded files: [_, kind, name, ..., mime at 11]
	 *   turn[3][0]     reply drafts; turn[3][3] is the id of the one on screen
	 *     draft[0]     its id, draft[1][0] its text
	 *     draft[30]    documents it made (Deep Research, Canvas): [id, _, title, _, text]
	 *     draft[37][0][0]  its thinking summary
	 *   turn[3][21]    model name as Gemini shows it ("3.1 Pro")
	 *   turn[4][0]     epoch seconds
	 *
	 * Every read goes through `at`, so a moved field reads as missing, never throws.
	 */
	function at(value, ...path) {
		let v = value;
		for (const key of path) {
			if (!Array.isArray(v)) return undefined;
			v = v[key];
		}
		return v;
	}

	const str = (v) => (typeof v === 'string' ? v : '');

	function parseTurn(turn) {
		if (!Array.isArray(turn)) return null;
		const prompt = at(turn, 2, 0);
		const response = at(turn, 3);
		const drafts = Array.isArray(at(response, 0)) ? response[0] : [];
		const chosenId = at(response, 3);
		const draft = drafts.find((d) => at(d, 0) === chosenId) || drafts[0];

		const files = (at(prompt, 4, 0, 3) || []).filter(Array.isArray).map((f) => ({
			name: str(f[2]) || 'file',
			mime: str(f[11])
		}));
		const docs = (at(draft, 30) || []).filter(Array.isArray).map((d) => ({
			title: str(d[2]) || 'Document',
			text: str(d[4])
		})).filter((d) => d.text);
		const seconds = at(turn, 4, 0);

		return {
			id: str(at(turn, 0, 1)),
			prompt: str(at(prompt, 0)),
			files,
			reply: str(at(draft, 1, 0)),
			docs,
			model: str(at(response, 21)),
			createdAt: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null
		};
	}

	/** The bridge's `{ turns }` (newest first) as parsed turns, oldest first. */
	function parseConversation(data) {
		const raw = Array.isArray(data?.turns) ? data.turns : [];
		return raw.map(parseTurn).filter(Boolean).reverse();
	}

	// Inline placeholders where a document chip sits in the reply text; the document
	// itself is in draft[30].
	const CHIP = /https?:\/\/googleusercontent\.com\/immersive_entry_chip\/\d+/g;
	const cleanReply = (text) => text.replace(CHIP, '').trim();

	// Text that merely mentions a special token ("<|endoftext|>", common in chats
	// about models) is counted as text; by default the tokenizer throws on it, and
	// the whole message counted 0.
	const AS_TEXT = { disallowedSpecial: new Set() };

	function countTokens(text) {
		const tokenizer = globalThis.GPTTokenizer_o200k_base;
		if (!text) return 0;
		if (!tokenizer?.countTokens) {
			GC.noteError?.('tokenizer', 'missing');
			return 0;
		}
		try {
			return tokenizer.countTokens(text, AS_TEXT);
		} catch (e) {
			GC.noteError?.('tokenizer', e);
			return 0;
		}
	}

	/**
	 * What the model reads back on the next turn, as far as the page lets us see it:
	 * every prompt, every reply, and the documents replies made. Thinking is left out
	 * (it is a summary, and not sent back), as are uploaded files and images (their
	 * content never reaches the page) and Gemini's own system prompt and tools.
	 */
	function computeMetrics(turns) {
		let totalTokens = 0;
		for (const t of turns) {
			totalTokens += countTokens(t.prompt);
			totalTokens += countTokens(cleanReply(t.reply));
			for (const d of t.docs) totalTokens += countTokens(d.text);
		}
		return { totalTokens, turns: turns.length };
	}

	GC.conversation = { parseConversation, computeMetrics, cleanReply };
})();
