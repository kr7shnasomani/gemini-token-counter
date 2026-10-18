(() => {
	'use strict';

	const GC = (globalThis.GeminiCounter = globalThis.GeminiCounter || {});
	const TAG = 'GeminiCounter';
	const ORIGIN = 'https://gemini.google.com';

	/**
	 * The content script's end of the channel to bridge.js. The two worlds share only
	 * `window.postMessage`; requests are matched to replies by id.
	 */
	class BridgeClient {
		constructor() {
			this._pending = new Map();
			window.addEventListener('message', (event) => {
				if (event.source !== window || event.origin !== ORIGIN) return;
				const data = event.data;
				if (!data || data.gc !== TAG || data.type !== 'gc:response') return;
				const pending = this._pending.get(data.requestId);
				if (!pending) return;
				this._pending.delete(data.requestId);
				clearTimeout(pending.timer);
				if (data.ok) pending.resolve(data.payload);
				else pending.reject(new Error(data.error || 'bridge request failed'));
			});
		}

		request(kind, payload, timeoutMs = 20000) {
			const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					this._pending.delete(requestId);
					reject(new Error(`bridge timed out (${kind})`));
				}, timeoutMs);
				this._pending.set(requestId, { resolve, reject, timer });
				window.postMessage({ gc: TAG, type: 'gc:request', requestId, kind, payload }, ORIGIN);
			});
		}

		requestUsage() {
			return this.request('usage', {}, 15000);
		}

		requestConversation(conversationId) {
			// A long chat is several pages, one round trip each.
			return this.request('conversation', { conversationId }, 60000);
		}
	}

	GC.bridge = new BridgeClient();
})();
