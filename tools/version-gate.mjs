// the first thing that runs on install. it exists so an old runtime produces a
// sentence instead of a parse error from somewhere else.
//
// plain JavaScript, ES2015 syntax only, no imports, no TypeScript, no Bun APIs.
// every other file in rho assumes a current bun; this one assumes nothing, so
// it can be the file that reports the version.
//
//   bun tools/version-gate.mjs   exit 0 when the runtime is new enough

var MIN_BUN = '1.2.0';
var MIN_NODE = '20.0.0';

function parse(text) {
    var match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function older(found, wanted) {
    for (var i = 0; i < 3; i++) {
        if (found[i] > wanted[i]) return false;
        if (found[i] < wanted[i]) return true;
    }
    return false;
}

function fail(lines) {
    var bar = '─────────────────────────────────────────────────────────────';
    console.error('\n' + bar);
    for (var i = 0; i < lines.length; i++) console.error(lines[i]);
    console.error(bar + '\n');
    process.exit(1);
}

var bun = process.versions && process.versions.bun ? parse(process.versions.bun) : null;
var node = parse(process.versions.node);

if (!bun) {
    if (node && older(node, parse(MIN_NODE))) {
        fail([
            'rho: node ' + process.versions.node + ' is too old (needs ' + MIN_NODE + ' or newer).',
            '',
            'rho is built for bun. install it, then install rho with bun:',
            '  curl -fsSL https://bun.sh/install | bash',
            '  bun install',
        ]);
    }
    fail([
        'rho: this ran under node, not bun.',
        '',
        'rho\'s scripts use bun. install bun, then use it for every step:',
        '  curl -fsSL https://bun.sh/install | bash',
        '  bun install',
    ]);
}

if (older(bun, parse(MIN_BUN))) {
    fail([
        'rho: bun ' + bun.join('.') + ' is too old (needs ' + MIN_BUN + ' or newer).',
        '',
        'an old bun fails later, inside rho\'s TypeScript, with an error that',
        'names the wrong thing. upgrade first:',
        '  bun upgrade',
        '',
        'if bun came from a package manager, upgrade it there instead, e.g.',
        '  brew upgrade oven-sh/bun/bun',
    ]);
}
