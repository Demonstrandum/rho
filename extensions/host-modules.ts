// plain .js extensions get pi's own modules, not a second copy of pi.
//
// pi 1.x runs from one bundled file, dist/bundle/cli.js. it loads extensions
// through jiti, and for a .ts extension jiti maps `@earendil-works/pi-coding-agent`
// and its siblings to the modules the bundle already holds (pi's
// VIRTUAL_MODULES). a .js extension is handed to bun's native import unchanged
// (`[jiti] [native] [import]` under JITI_DEBUG=1), and bun resolves those
// specifiers through node_modules: here, the symlinks tools/link-pi-packages.ts
// makes to the global install, whose `main` is the unbundled dist/index.js.
// that is about 255 modules plus chalk, proper-lockfile and cross-spawn, loaded
// a second time: 1-2.5 s at startup for @ayulab/pi-rewind alone, measured with
// PI_TIMING=1 PI_STARTUP_BENCHMARK=1. the second copy is also a different
// instance, so pi-rewind's `SessionManager` was not the session's.
//
// a Bun runtime plugin registered here maps each of those specifiers to the
// module this file received from jiti, which is the bundle's. it is registered
// at import time, and rho's extensions load before the packages listed after
// ./extensions in package.json, so it is in place before the first .js package
// imports anything. the symlinks stay: typecheck reads them.
//
// outside bun (`Bun` undefined) there is nothing to register; bun-runtime.ts
// ends that session anyway.

import * as piAgentCore from '@earendil-works/pi-agent-core';
import * as piAiCompat from '@earendil-works/pi-ai/compat';
import * as piAiModels from '@earendil-works/pi-ai/models';
import * as piAiOauth from '@earendil-works/pi-ai/oauth';
import * as piAiProviders from '@earendil-works/pi-ai/providers/all';
import * as piCodingAgent from '@earendil-works/pi-coding-agent';
import * as piTui from '@earendil-works/pi-tui';
import * as typebox from 'typebox';
import * as typeboxCompile from 'typebox/compile';
import * as typeboxValue from 'typebox/value';

type ModuleNamespace = Record<string, unknown>;

// the scopes pi has published under; each takes the same subpaths.
const PI_SCOPES = ['@earendil-works', '@mariozechner'] as const;

const PI_PACKAGES: Readonly<Record<string, ModuleNamespace>> = {
    'pi-agent-core': piAgentCore,
    'pi-tui': piTui,
    // pi resolves the pi-ai root to compat, a superset of the core entry.
    'pi-ai': piAiCompat,
    'pi-ai/compat': piAiCompat,
    'pi-ai/models': piAiModels,
    'pi-ai/oauth': piAiOauth,
    'pi-ai/providers/all': piAiProviders,
    'pi-coding-agent': piCodingAgent,
};

const TYPEBOX: Readonly<Record<string, ModuleNamespace>> = {
    typebox,
    'typebox/compile': typeboxCompile,
    'typebox/value': typeboxValue,
    '@sinclair/typebox': typebox,
    '@sinclair/typebox/compile': typeboxCompile,
    '@sinclair/typebox/value': typeboxValue,
};

export const HOST_MODULES: ReadonlyMap<string, ModuleNamespace> = new Map([
    ...PI_SCOPES.flatMap((scope) =>
        Object.entries(PI_PACKAGES).map(([name, mod]) => [`${scope}/${name}`, mod] as const),
    ),
    ...Object.entries(TYPEBOX),
]);

if (typeof Bun !== 'undefined') {
    Bun.plugin({
        name: 'rho-host-modules',
        setup(build) {
            for (const [specifier, exports] of HOST_MODULES) {
                build.module(specifier, () => ({ exports, loader: 'object' }));
            }
        },
    });
}

export default function () {}
