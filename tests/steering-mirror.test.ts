import { test, expect } from 'bun:test';
import { SteeringMirror } from '../extensions/lib/steering-mirror';

test('entries come back in the order pi queued them', () => {
    const mirror = new SteeringMirror();
    mirror.push('first');
    mirror.push('second');
    expect(mirror.oldest()).toBe('first');
    expect(mirror.newest()).toBe('second');
    expect(mirror.size).toBe(2);
});

test('an empty queue reports no entry either end', () => {
    const mirror = new SteeringMirror();
    expect(mirror.oldest()).toBeUndefined();
    expect(mirror.newest()).toBeUndefined();
});

test('delivery drops the entry with that text and leaves the rest', () => {
    const mirror = new SteeringMirror();
    mirror.push('first');
    mirror.push('second');
    mirror.delivered('first');
    expect(mirror.queued()).toEqual(['second']);
});

test('delivery of unqueued text changes nothing', () => {
    const mirror = new SteeringMirror();
    mirror.push('first');
    mirror.delivered('never queued');
    expect(mirror.queued()).toEqual(['first']);
});

test('duplicate texts lose one entry per delivery', () => {
    const mirror = new SteeringMirror();
    mirror.push('same');
    mirror.push('same');
    mirror.delivered('same');
    expect(mirror.queued()).toEqual(['same']);
});

test('no pending message empties the copy', () => {
    const mirror = new SteeringMirror();
    mirror.push('first');
    mirror.reconcile(false);
    expect(mirror.size).toBe(0);
});

test('a pending message leaves the copy alone', () => {
    const mirror = new SteeringMirror();
    mirror.push('first');
    mirror.reconcile(true);
    expect(mirror.queued()).toEqual(['first']);
});
