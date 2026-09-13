#!/usr/bin/env bun
/**
 * A stand-in for `pi --mode rpc` in the broker tests.
 *
 * It speaks the shape the broker cares about -- JSONL in, JSONL out -- and
 * nothing else. Using pi itself here would test a model provider, a session
 * file and an API key, none of which are what the broker does.
 */

let held = '';
if (process.argv.includes('--complain')) process.stderr.write('a stack trace\nover two lines\n');

process.stdin.on('data', (chunk: Buffer) => {
    held += chunk.toString();
    const lines = held.split('\n');
    held = lines.pop() ?? '';
    for (const line of lines) {
        if (line.trim() === '') continue;
        let message = line;
        try {
            const parsed = JSON.parse(line) as { message?: string };
            message = parsed.message ?? line;
        } catch {
            // not JSON: echoed as it came
        }
        process.stdout.write(`${JSON.stringify({ type: 'message', text: message })}\n`);
    }
});

// Alive until killed: the broker owns the lifetime, which is the thing under
// test.
setInterval(() => {}, 1 << 30);
