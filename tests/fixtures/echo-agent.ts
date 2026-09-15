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

/**
 * The interface calls rpc mode makes with nobody attached.
 *
 * pi emits these when an extension touches `ctx.ui` on a machine with no
 * terminal: a notification is told once, a dialog waits for an answer carrying
 * the same id.
 */
if (process.argv.includes('--ask-at-start')) {
    process.stdout.write(
        `${JSON.stringify({ type: 'extension_ui_request', id: 'u1', method: 'notify', message: 'no checkpoints available', notifyType: 'warning' })}\n`,
    );
    process.stdout.write(
        `${JSON.stringify({ type: 'extension_ui_request', id: 'd1', method: 'select', title: 'Rewind to checkpoint:', options: ['one', 'two'] })}\n`,
    );
}

process.stdin.on('data', (chunk: Buffer) => {
    held += chunk.toString();
    const lines = held.split('\n');
    held = lines.pop() ?? '';
    for (const line of lines) {
        if (line.trim() === '') continue;
        let message = line;
        let id: string | undefined;
        let type: string | undefined;
        try {
            const parsed = JSON.parse(line) as { message?: string; id?: string; type?: string };
            message = parsed.message ?? line;
            id = parsed.id;
            type = parsed.type;
        } catch {
            // not JSON: echoed as it came
        }
        // An answer to a dialog: reported as an event, so a test can see that
        // it arrived with the id the agent asked under rather than a tagged one.
        if (type === 'extension_ui_response') {
            process.stdout.write(`${JSON.stringify({ type: 'message', text: `answered ${line}` })}\n`);
            continue;
        }
        // A command with an id gets an answer carrying that id, the way pi's
        // rpc mode does; anything else is an event.
        if (id !== undefined) {
            process.stdout.write(`${JSON.stringify({ type: 'response', id, success: true, data: { message } })}\n`);
            continue;
        }
        process.stdout.write(`${JSON.stringify({ type: 'message', text: message })}\n`);
    }
});

// Alive until killed: the broker owns the lifetime, which is the thing under
// test.
setInterval(() => {}, 1 << 30);
