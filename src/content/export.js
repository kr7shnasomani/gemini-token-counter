(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});

	function formatDateTime(ms) {
		if (!Number.isFinite(ms)) return '';
		return new Date(ms).toLocaleString(undefined, {
			day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
		});
	}

	function slugify(name) {
		const base = String(name || 'gemini-conversation')
			.toLowerCase()
			// Letters and digits of any script: a Chinese or Hindi title is still a name.
			.replace(/[^\p{L}\p{N}]+/gu, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60);
		return base || 'gemini-conversation';
	}

	// How each format lays out a conversation. Every entry returns lines.
	const MARKDOWN = {
		head: (title, meta) => [`# ${title}`, '', `*${meta}*`, ''],
		turn: (who, when) => ['---', '', when ? `## ${who} · ${when}` : `## ${who}`, ''],
		file: (f) => [`\u{1F4CE} *Attachment: ${f.name}${f.mime ? ` (${f.mime})` : ''}*`, ''],
		doc: (d) => [`**Document: ${d.title}**`, '', d.text, '']
	};

	const RULE = '='.repeat(60);
	const THIN = '-'.repeat(60);
	const PLAIN = {
		head: (title, meta) => [title, meta, RULE, ''],
		turn: (who, when) => [when ? `${who.toUpperCase()}  (${when})` : who.toUpperCase(), THIN],
		file: (f) => [`[attachment: ${f.name}${f.mime ? ` (${f.mime})` : ''}]`, ''],
		doc: (d) => [`--- document: ${d.title} ---`, d.text, `--- end of ${d.title} ---`, '']
	};

	function render(turns, title, layout, truncated) {
		const models = [...new Set(turns.map((t) => t.model).filter(Boolean))];
		// A chat longer than one read can take (the bridge's page and time ceilings)
		// is exported from its newest turns, and says so.
		const count = `${turns.length}${truncated ? '+' : ''} turn${turns.length === 1 && !truncated ? '' : 's'}`;
		const meta = [`Exported ${formatDateTime(Date.now())}`, count, ...(truncated ? ['older turns not included'] : []), ...models];
		const out = layout.head(title || 'Gemini conversation', meta.join(' · '));

		for (const t of turns) {
			out.push(...layout.turn('You', formatDateTime(t.createdAt)));
			if (t.prompt.trim()) out.push(t.prompt.trim(), '');
			for (const f of t.files) out.push(...layout.file(f));

			out.push(...layout.turn('Gemini', ''));
			const reply = GC.conversation.cleanReply(t.reply);
			if (reply) out.push(reply, '');
			for (const d of t.docs) out.push(...layout.doc(d));
		}

		// One blank line between blocks at most, decided on the blocks rather than the
		// joined text, so a reply or document keeps every blank line it was written with.
		return out.filter((line, i) => line !== '' || out[i - 1] !== '').join('\n').trimEnd() + '\n';
	}

	const FORMATS = {
		md: { layout: MARKDOWN, ext: 'md', mime: 'text/markdown' },
		txt: { layout: PLAIN, ext: 'txt', mime: 'text/plain' }
	};

	function buildFile(turns, title, format, truncated = false) {
		const spec = FORMATS[format] || FORMATS.md;
		// Local date, not UTC, so the filename agrees with the date inside the file.
		const now = new Date();
		const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
		return {
			filename: `${slugify(title)}-${stamp}.${spec.ext}`,
			mime: spec.mime,
			content: render(turns, title, spec.layout, truncated)
		};
	}

	/** Hand the file to the browser. A blob URL, so no `downloads` permission. */
	function download(turns, title, format, { truncated = false } = {}) {
		const file = buildFile(turns, title, format, truncated);
		const url = URL.createObjectURL(new Blob([file.content], { type: `${file.mime};charset=utf-8` }));
		const link = document.createElement('a');
		link.href = url;
		link.download = file.filename;
		link.style.display = 'none';
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
		return file.filename;
	}

	GC.exportChat = { download };
})();
