import { describe, expect, test } from 'bun:test';
import { UiRelay, asUiRequest, answerFrame, isAnswerable, unanswerable } from '../extensions/lib/remote/ui-relay';
import type { UiRequest } from '../extensions/lib/remote/ui-relay';

/**
 * The far side's interface, carried to the machine with a screen.
 *
 * What is being tested is that nothing is dropped: a request that arrives
 * before the interface has loaded is held, a dialog is answered exactly once,
 * and a method this build does not know is cancelled rather than left to park
 * the extension that asked.
 */

describe('reading a request off the wire', () => {
    test('a notification carries its level', () => {
        expect(
            asUiRequest({ type: 'extension_ui_request', id: '1', method: 'notify', message: 'no checkpoints', notifyType: 'warning' }),
        ).toEqual({ method: 'notify', id: '1', message: 'no checkpoints', level: 'warning' });
    });

    test('a missing level is information, not an error', () => {
        const request = asUiRequest({ type: 'extension_ui_request', id: '1', method: 'notify', message: 'done' });
        expect(request?.method).toBe('notify');
        expect(request).toMatchObject({ level: 'info' });
    });

    test('a dialog keeps its options and its deadline', () => {
        expect(
            asUiRequest({
                type: 'extension_ui_request',
                id: 'd1',
                method: 'select',
                title: 'Rewind to checkpoint:',
                options: ['one', 'two'],
                timeout: 30_000,
            }),
        ).toEqual({ method: 'select', id: 'd1', title: 'Rewind to checkpoint:', options: ['one', 'two'], timeoutMs: 30_000 });
    });

    test("pi's name for setting the editor becomes this one's", () => {
        expect(asUiRequest({ type: 'extension_ui_request', id: '2', method: 'set_editor_text', text: 'hello' })).toEqual({
            method: 'setEditorText',
            id: '2',
            text: 'hello',
        });
    });

    test('anything that is not a request reads as none', () => {
        expect(asUiRequest({ type: 'message_end' })).toBeNull();
        expect(asUiRequest(null)).toBeNull();
        expect(asUiRequest({ type: 'extension_ui_request', method: 'notify', message: 'no id' })).toBeNull();
    });

    test('a method this build does not know is named, so it can be cancelled', () => {
        expect(unanswerable({ type: 'extension_ui_request', id: 'x', method: 'hologram' })).toBe('x');
        expect(unanswerable({ type: 'extension_ui_request', id: 'x', method: 'notify', message: 'hi' })).toBeNull();
        expect(unanswerable({ type: 'agent_end' })).toBeNull();
    });

    test('which methods block the extension that called them', () => {
        expect(isAnswerable('select')).toBe(true);
        expect(isAnswerable('editor')).toBe(true);
        expect(isAnswerable('notify')).toBe(false);
        expect(isAnswerable('setWidget')).toBe(false);
    });
});

const notify = (id: string, message: string): UiRequest => ({ method: 'notify', id, message, level: 'info' });
const select = (id: string): UiRequest => ({ method: 'select', id, title: 'pick', options: ['a'], timeoutMs: undefined });

describe('the relay', () => {
    test('what arrives before the interface does is held, not dropped', () => {
        const relay = new UiRelay(() => {});
        relay.deliver(notify('1', 'first'));
        relay.deliver(notify('2', 'second'));
        const seen: string[] = [];
        relay.onRequest((request) => seen.push(request.method === 'notify' ? request.message : request.method));
        expect(seen).toEqual(['first', 'second']);
    });

    test('once something is drawing, requests go straight through', () => {
        const relay = new UiRelay(() => {});
        const seen: string[] = [];
        relay.onRequest((request) => seen.push(request.id));
        relay.deliver(notify('1', 'live'));
        expect(seen).toEqual(['1']);
    });

    test('an answer goes back once, and a second is ignored', () => {
        const sent: Record<string, unknown>[] = [];
        const relay = new UiRelay((frame) => sent.push(frame));
        relay.onRequest(() => {});
        relay.deliver(select('d1'));
        relay.answer('d1', { value: 'a' });
        relay.answer('d1', { value: 'a' });
        expect(sent).toEqual([{ type: 'extension_ui_response', id: 'd1', value: 'a' }]);
    });

    test('an answer to something never asked is not sent', () => {
        const sent: Record<string, unknown>[] = [];
        const relay = new UiRelay((frame) => sent.push(frame));
        relay.answer('never', { cancelled: true });
        expect(sent).toHaveLength(0);
    });

    test('a request this interface cannot draw is cancelled, so the far side is not parked', () => {
        const sent: Record<string, unknown>[] = [];
        const relay = new UiRelay((frame) => sent.push(frame));
        relay.cancel('d9');
        expect(sent).toEqual([{ type: 'extension_ui_response', id: 'd9', cancelled: true }]);
    });

    test('a dialog is still open until it is answered', () => {
        const relay = new UiRelay(() => {});
        relay.onRequest(() => {});
        relay.deliver(select('d1'));
        relay.deliver(notify('n1', 'beside it'));
        expect(relay.pending).toEqual(['d1']);
        relay.answer('d1', { cancelled: true });
        expect(relay.pending).toEqual([]);
    });

    test("the client's own words travel the same channel", () => {
        const relay = new UiRelay(() => {});
        const seen: string[] = [];
        relay.onRequest((request) => {
            if (request.method === 'notify') seen.push(`${request.level}: ${request.message}`);
        });
        relay.say('the session did not take that', 'error');
        expect(seen).toEqual(['error: the session did not take that']);
    });

    test('an answer frame is the shape pi reads', () => {
        expect(answerFrame('d1', { confirmed: false })).toEqual({
            type: 'extension_ui_response',
            id: 'd1',
            confirmed: false,
        });
    });
});
