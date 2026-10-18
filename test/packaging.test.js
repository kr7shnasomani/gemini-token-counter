// The build is the repo: what the manifest names must exist, and the version must
// agree everywhere it is written.
const fs = require('fs');
const path = require('path');
const { section, t, report } = require('./harness');

const ROOT = path.join(__dirname, '..');
const json = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const manifest = json('manifest.json');
const pkg = json('package.json');
const lock = json('package-lock.json');

section('one version');
t('manifest and package.json agree', manifest.version === pkg.version, `${manifest.version} vs ${pkg.version}`);
t('package-lock agrees, top and root package', lock.version === pkg.version && lock.packages[''].version === pkg.version);
t('lockfile is for this package', lock.name === pkg.name && lock.packages[''].name === pkg.name);
t('lockfile has the same devDependencies', JSON.stringify(lock.packages[''].devDependencies) === JSON.stringify(pkg.devDependencies));

section('every declared file exists');
const declared = [
	...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
	manifest.action.default_popup,
	...Object.values(manifest.icons),
	...Object.values(manifest.action.default_icon)
];
for (const f of [...new Set(declared)]) t(f, fs.existsSync(path.join(ROOT, f)));

section('load order');
const order = manifest.content_scripts.find((c) => !c.world).js;
const before = (a, b) => order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b);
t('constants first', order[0] === 'src/content/constants.js');
t('tokenizer before the counter', before('src/vendor/o200k_base.js', 'src/content/conversation.js'));
t('main last', order[order.length - 1] === 'src/content/main.js');

process.exit(report('packaging'));
