import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { dispatcherFor, rulesFrom } from '../extensions/http-sockets';

/**
 * A machine behind NAT loses the record of an idle flow after a few minutes
 * and then answers nothing. undici holds a connection for as long as the
 * server's keep-alive hint allows, ten minutes by default, so the next request
 * went into a connection the network had forgotten and hung until pi's own
 * response timeout: one turn took 300.0 seconds, prompt to answer.
 */

describe('the rules a connection is kept under', () => {
    test('a server hint cannot push reuse far past the window we chose', () => {
        const rules = rulesFrom({ keepAliveMs: 15_000, responseMs: 120_000 });
        expect(rules.keepAliveMs).toBe(15_000);
        expect(rules.keepAliveCeilingMs).toBe(30_000);
        expect(rules.responseMs).toBe(120_000);
    });

    test('the system probes a held connection well before the window is out', () => {
        expect(rulesFrom({ keepAliveMs: 15_000, responseMs: 1 }).probeAfterMs).toBe(7_500);
        // and never so often that a short window means a probe per second
        expect(rulesFrom({ keepAliveMs: 500, responseMs: 1 }).probeAfterMs).toBe(1_000);
    });
});

/**
 * Measured in node, not here: bun answers a request with its own http stack,
 * so a dispatcher installed for undici is not the thing under test. The probe
 * is the same shape the extension installs.
 */
describe('against a server that asks for a long keep-alive', () => {
    const probe = (keepAliveMs: number, idleMs: number): string => {
        const script = `
            const undici = require('undici');
            const { createServer } = require('node:http');
            const { dispatcherFor, rulesFrom } = { dispatcherFor: null, rulesFrom: null };
            let opened = 0;
            const server = createServer((_q, res) => { res.setHeader('Keep-Alive', 'timeout=120'); res.end('ok'); });
            server.keepAliveTimeout = 120000;
            server.on('connection', () => { opened += 1; });
            server.listen(0, async () => {
                const port = server.address().port;
                const agent = new undici.Agent({
                    keepAliveTimeout: ${keepAliveMs},
                    keepAliveMaxTimeout: ${keepAliveMs * 2},
                    connect: { keepAlive: true, keepAliveInitialDelay: 1000 },
                });
                const hit = async () => { const r = await undici.request('http://127.0.0.1:' + port + '/', { dispatcher: agent }); await r.body.text(); };
                await hit();
                const before = opened;
                await new Promise((r) => setTimeout(r, ${idleMs}));
                await hit();
                console.log(String(opened - before));
                server.close();
                process.exit(0);
            });
        `;
        return spawnSync('node', ['-e', script], { cwd: join(import.meta.dir, '..'), encoding: 'utf8' }).stdout.trim();
    };

    test('a connection idle past the window is not reused', () => {
        expect(probe(600, 1_800)).toBe('1');
    }, 20_000);

    test('and a connection well inside it is', () => {
        expect(probe(30_000, 100)).toBe('0');
    }, 20_000);
});
