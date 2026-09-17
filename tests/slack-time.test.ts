import { describe, expect, test } from 'bun:test';
import { scheduleTime } from '../extensions/lib/slack-api';

const NOW = Date.parse('2026-09-17T12:00:00Z');

describe('when to send', () => {
    test('a relative time counts from now', () => {
        expect(scheduleTime('+90m', NOW)).toEqual({ ok: true, at: Date.parse('2026-09-17T13:30:00Z') / 1000 });
        expect(scheduleTime('2h', NOW)).toEqual({ ok: true, at: Date.parse('2026-09-17T14:00:00Z') / 1000 });
        expect(scheduleTime('3 days', NOW)).toEqual({ ok: true, at: Date.parse('2026-09-20T12:00:00Z') / 1000 });
    });

    test('an ISO timestamp is absolute', () => {
        expect(scheduleTime('2026-09-18T08:30:00Z', NOW)).toEqual({
            ok: true,
            at: Date.parse('2026-09-18T08:30:00Z') / 1000,
        });
    });

    test('epoch seconds pass through', () => {
        const at = Math.floor(Date.parse('2026-09-18T08:30:00Z') / 1000);
        expect(scheduleTime(String(at), NOW)).toEqual({ ok: true, at });
    });

    test('what Slack would refuse is refused here, with a reason', () => {
        expect(scheduleTime('2020-01-01T00:00:00Z', NOW).ok).toBe(false);
        expect(scheduleTime('400d', NOW).ok).toBe(false);
        expect(scheduleTime('soon', NOW).ok).toBe(false);
        expect(scheduleTime('', NOW).ok).toBe(false);
    });
});
