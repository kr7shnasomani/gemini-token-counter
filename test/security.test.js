// Guards for the properties that keep this extension safe to install. Each of
// these has a specific failure mode; none is decorative.
const fs = require('fs');
const path = require('path');
const { section, t, report } = require('./harness');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
// Every script that ships, from the manifest and the popup page themselves, so a
// new file is scanned without anyone remembering to list it.
const popupScripts = [...read('src/popup/popup.html').matchAll(/<script src="([^"]+)"/g)].map((m) => path.posix.join('src/popup', m[1]));
const SHIPPED = [...new Set([...manifest.content_scripts.flatMap((c) => c.js), ...popupScripts])].filter((f) => !f.startsWith('src/vendor/'));
const code = SHIPPED.map(read).join('\n');

section('no code execution primitives');
t('no eval', !/\beval\s*\(/.test(code));
t('no new Function', !/new\s+Function\s*\(/.test(code));
t('no innerHTML / outerHTML / insertAdjacentHTML', !/(inner|outer)HTML|insertAdjacentHTML/.test(code));
t('no document.write', !/document\.write/.test(code));
t('no string-bodied timers', !/set(Timeout|Interval)\s*\(\s*['"`]/.test(code));

section('least privilege');
t('storage is the only permission', JSON.stringify(manifest.permissions) === '["storage"]');
t('no install-time host permissions', !manifest.host_permissions);
t('optional host access is gemini.google.com only', JSON.stringify(manifest.optional_host_permissions) === '["https://gemini.google.com/*"]');
t('content scripts run on gemini.google.com only', manifest.content_scripts.every((c) => JSON.stringify(c.matches) === '["https://gemini.google.com/*"]'));
t('nothing is web-accessible', !manifest.web_accessible_resources);
t('nothing is externally connectable', !manifest.externally_connectable);
t('no background worker', !manifest.background);
const pageWorld = manifest.content_scripts.filter((c) => c.world === 'MAIN');
t('only the bridge runs in the page world, from document_start',
	pageWorld.length === 1 && JSON.stringify(pageWorld[0].js) === '["src/injected/bridge.js"]' && pageWorld[0].run_at === 'document_start');
t('Chrome is held to 111, where a page-world content script arrived', parseInt(manifest.minimum_chrome_version, 10) >= 111);

section('the bridge can only read');
const bridge = read('src/injected/bridge.js');
const client = read('src/content/bridge-client.js');
// The RPC ids the bridge can call, from its own handler table.
const rpcs = [...new Set([...bridge.matchAll(/call\('([A-Za-z0-9]+)'/g)].map((m) => m[1]))].sort();
t('exactly the usage and conversation reads: ' + rpcs.join(', '), JSON.stringify(rpcs) === '["hNvQHb","jSf9Qc"]');
t('the rpc id is never taken from the message', !/call\(\s*data\./.test(bridge) && !/rpcids:\s*data/.test(bridge));
t('handlers are looked up as own properties', bridge.includes('Object.prototype.hasOwnProperty.call(HANDLERS'));

section('message channel is not a broadcast');
t('bridge never posts to "*"', !/postMessage\([^)]*,\s*['"]\*['"]/.test(bridge) && !/postMessage\([^)]*,\s*['"]\*['"]/.test(client));
t('bridge targets its own origin', bridge.includes('TARGET_ORIGIN = window.location.origin'));
t('bridge only accepts same-window, same-origin messages', bridge.includes('event.source !== window || event.origin !== TARGET_ORIGIN'));
t('client checks the sender origin', client.includes('event.origin !== ORIGIN') && client.includes("ORIGIN = 'https://gemini.google.com'"));

section('ids cannot walk out of their place');
const pattern = new RegExp(bridge.match(/ID_PATTERN = \/(.+?)\/;/)[1]);
for (const bad of ['../../x', 'c_abc', 'abc?x=1', 'abc#x', 'ABCDEF12', '', 'a'.repeat(65)]) t('rejects ' + JSON.stringify(bad), !pattern.test(bad));
t('accepts a real conversation id', pattern.test('80eeb4ca73c8a8fa'));

section('no credentials, no third-party endpoints');
t('no hardcoded tokens', !/(gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|api[_-]?key\s*[:=]\s*['"])/i.test(code));
t('no Authorization headers', !/Authorization/i.test(code));
const hosts = [...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
// googleusercontent.com appears only as a pattern to strip from reply text.
const allowed = new Set(['gemini.google.com', 'github.com', 'www.w3.org', 'googleusercontent.com']);
t('only expected hosts appear: ' + [...new Set(hosts)].join(', '), hosts.every((h) => allowed.has(h)));
t('no analytics or telemetry', !/analytics|telemetry|sentry|mixpanel|segment\.io/i.test(code));

section('supply chain');
t('runtime ships no dependencies', !JSON.parse(read('package.json')).dependencies);
const vendorHash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src/vendor/o200k_base.js'))).digest('hex');
t('vendored tokenizer matches its recorded hash', read('THIRD_PARTY_NOTICES.md').includes('SHA-256 of the vendored file: `' + vendorHash + '`'));
const fontHash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src/vendor/google-sans-flex-latin.woff2'))).digest('hex');
t('vendored font matches its recorded hash', read('THIRD_PARTY_NOTICES.md').includes('SHA-256 of the vendored font: `' + fontHash + '`'));
t('the popup takes its font from the extension, not the network', !/fonts\.(googleapis|gstatic)\.com/.test(read('src/popup/popup.css') + read('src/popup/popup.html')) && read('src/popup/popup.css').includes('../vendor/google-sans-flex-latin.woff2'));
t('.npmrc disables lifecycle scripts', read('.npmrc').includes('ignore-scripts=true'));
for (const wf of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
	const s = read('.github/workflows/' + wf);
	if (s.includes('npm ci')) t(wf + ' installs with --ignore-scripts', !/npm ci(?! --ignore-scripts)/.test(s));
	const uses = [...s.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
	const loose = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u));
	t(wf + ' pins all ' + uses.length + ' actions to a commit', loose.length === 0, loose.join(', '));
}
const lock = JSON.parse(read('package-lock.json'));
const pkgs = Object.entries(lock.packages || {}).filter(([k]) => k);
t('every locked package has an integrity hash', pkgs.filter(([, v]) => v.resolved).every(([, v]) => Boolean(v.integrity)));
t('every package comes from the public registry', pkgs.filter(([, v]) => v.resolved).every(([, v]) => v.resolved.startsWith('https://registry.npmjs.org/')));

section('what leaves the machine');
const popup = read('src/popup/popup.js');
t('feedback opens a URL, never posts', !popup.includes('api.github.com') && popup.includes('window.open'));
t('feedback carries no conversation content', !/conversation|turns|prompt|transcript/i.test(popup));
const exportJs = read('src/content/export.js');
t('export stays local (blob, no upload)', exportJs.includes('URL.createObjectURL') && !/fetch\(|XMLHttpRequest/.test(exportJs));
t('the popup talks to Gemini only', [...popup.matchAll(/fetch\(\s*`([^`]+)`/g)].every((m) => m[1].startsWith('${GEMINI_ORIGIN}')));

process.exit(report('security'));
