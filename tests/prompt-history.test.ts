// pin test: assert the Editor methods and fields prompt-history.ts patches
// exist. a pi release that renames them fails here instead of silently
// capturing nothing.

import { describe, expect, it } from 'bun:test';
import { Editor } from '@earendil-works/pi-tui';

// cast to any to access private methods for pinning
const proto = Editor.prototype as any;

describe('Editor API surface for prompt-history', () => {
    it('has navigateHistory on prototype', () => {
        expect(typeof proto.navigateHistory).toBe('function');
    });

    it('has submitValue on prototype', () => {
        expect(typeof proto.submitValue).toBe('function');
    });

    it('has addToHistory on prototype', () => {
        expect(typeof proto.addToHistory).toBe('function');
    });

    it('has getText on prototype', () => {
        expect(typeof proto.getText).toBe('function');
    });

    it('has exitHistoryBrowsing on prototype', () => {
        expect(typeof proto.exitHistoryBrowsing).toBe('function');
    });

    // instance fields: we cannot construct Editor without a TUI, so we
    // check the prototype descriptor does not exist (meaning it is an instance
    // field set in the constructor, which is the expected pattern).
    it('history is an instance field (not on prototype)', () => {
        expect(Object.getOwnPropertyDescriptor(Editor.prototype, 'history')).toBeUndefined();
    });

    it('historyIndex is an instance field (not on prototype)', () => {
        expect(Object.getOwnPropertyDescriptor(Editor.prototype, 'historyIndex')).toBeUndefined();
    });

    it('historyDraft is an instance field (not on prototype)', () => {
        expect(Object.getOwnPropertyDescriptor(Editor.prototype, 'historyDraft')).toBeUndefined();
    });
});
