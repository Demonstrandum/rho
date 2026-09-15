import { describe, expect, test } from 'bun:test';
import { modelFlags, withoutModelFlags } from '../extensions/lib/remote/pi-args';

describe('the model a remote session starts on', () => {
    test('the interface hands over what it is running', () => {
        expect(modelFlags({ provider: 'anthropic', id: 'claude-opus-4-8', thinking: 'medium' })).toEqual([
            '--model',
            'anthropic/claude-opus-4-8',
            '--thinking',
            'medium',
        ]);
    });

    test('an interface with no model named leaves the far side to resolve one', () => {
        expect(modelFlags(null)).toEqual([]);
    });

    test('a name that is not a name is not put in a shell command', () => {
        // The flags become words in an unquoted command over ssh.
        expect(modelFlags({ provider: 'anthropic; rm -rf ~', id: 'x', thinking: 'off' })).toEqual([]);
        expect(modelFlags({ provider: 'anthropic', id: 'x', thinking: '$(id)' })).toEqual([]);
    });

    test('a session that is being continued keeps the model it was left on', () => {
        const given = ['--model', 'anthropic/claude-opus-4-8', '--thinking', 'high', '--session', '/p/s.jsonl'];
        expect(withoutModelFlags(given)).toEqual(['--session', '/p/s.jsonl']);
    });

    test('nothing else the interface sent is dropped with it', () => {
        expect(withoutModelFlags(['--approve', '--name', 'overnight'])).toEqual(['--approve', '--name', 'overnight']);
    });
});
