/**
 * A far side that speaks pi's rpc protocol, for testing the link without ssh.
 *
 * It is a real process reading real stdin and writing real lines, because the
 * things that broke in practice were framing and process death, and neither of
 * those is reproduced by a stub that hands objects to a listener.
 */

const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Noise on the channel: ssh, motd banners and shell warnings all land here, and
// the link has to walk past them.
if (process.argv.includes('--noise')) {
    process.stdout.write('Warning: permanently added a host\n');
    process.stdout.write('{ not json either\n');
}

let collected = "";
process.stdin.on('data', (chunk: Buffer) => {
    collected += chunk.toString();
    const lines = collected.split('\n');
    collected = lines.pop() ?? "";
    for (const line of lines) {
        if (line.trim() === '') continue;
        const command = JSON.parse(line) as { id?: string; type: string; message?: string };
        switch (command.type) {
            case 'get_state':
                say({ type: 'response', id: command.id, data: { model: { id: 'test-model' }, isStreaming: false } });
                break;
            case 'get_messages':
                say({
                    type: 'response',
                    id: command.id,
                    data: { messages: [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }] },
                });
                break;
            case 'slow':
                // Answered by nobody: the caller's deadline is the test.
                break;
            case 'prompt':
                say({ type: 'response', id: command.id, data: { accepted: true } });
                if (command.message === 'slow') {
                    // A model call that takes a while and streams nothing
                    // until it is done: the case that reads as a hang.
                    say({ type: 'agent_start' });
                    say({ type: 'turn_start' });
                    setTimeout(() => {
                        say({ type: 'message_start', message: { role: 'assistant', content: [] } });
                        say({
                            type: 'message_end',
                            message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] },
                        });
                        say({ type: 'turn_end' });
                        say({ type: 'agent_end' });
                        say({ type: 'agent_settled' });
                    }, 20000);
                    break;
                }
                say({ type: 'agent_start' });
                say({ type: 'message_start', message: { role: 'assistant', content: [] } });
                say({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
                // A line carrying U+2028, which is a line terminator to
                // JavaScript but not to JSON: splitting on anything but \n
                // tears this in half.
                say({
                    type: 'message_update',
                    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'a\u2028b' },
                });
                say({
                    type: 'message_end',
                    message: { role: 'assistant', content: [{ type: 'text', text: 'a\u2028b' }] },
                });
                say({ type: 'agent_settled' });
                break;
            case 'replay':
                say({ type: 'response', id: command.id, data: {} });
                say({ type: 'rho_replay_start' });
                say({
                    type: 'message_end',
                    message: { role: 'assistant', content: [{ type: 'text', text: 'history' }] },
                });
                say({ type: 'rho_replay_end' });
                break;
            case 'refuse':
                // A turn that ends in a refusal rather than an answer: the
                // message is empty and the reason is inside it.
                say({ type: 'response', id: command.id, data: {} });
                say({ type: 'agent_start' });
                say({
                    type: 'message_end',
                    message: { role: 'assistant', content: [], errorMessage: 'the token expired' },
                });
                say({ type: 'agent_settled' });
                break;
            case 'old_refusal':
                say({ type: 'response', id: command.id, data: {} });
                say({ type: 'rho_replay_start' });
                say({
                    type: 'message_end',
                    message: { role: 'assistant', content: [], errorMessage: 'a refusal from last week' },
                });
                say({ type: 'rho_replay_end' });
                break;
            case 'slow_turn':
                // A turn whose model call takes a while and streams nothing:
                // the case that looks like a hang.
                say({ type: 'response', id: command.id, data: {} });
                say({ type: 'agent_start' });
                say({ type: 'turn_start' });
                setTimeout(() => {
                    say({ type: 'message_start', message: { role: 'assistant', content: [] } });
                    say({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
                    say({
                        type: 'message_update',
                        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'late' },
                    });
                    say({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] } });
                    say({ type: 'turn_end' });
                    say({ type: 'agent_end' });
                    say({ type: 'agent_settled' });
                }, 25000);
                break;
            case 'die':
                process.stderr.write('the daemon fell over\n');
                process.exit(3);
                break;
            default:
                say({ type: 'response', id: command.id, data: { echoed: command.type } });
        }
    }
});
