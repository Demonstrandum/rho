// a string enum as `{ type: 'string', enum: [...] }`, typed for TypeBox.
// pi-ai's own `StringEnum` returns a pi-schema `Schema`, which TypeBox's `Type.Object` cannot infer through,
// and the `anyOf` of literals that `Type.Union` builds is rejected by Google's API.

import { Type, type TUnsafe } from 'typebox';

export function StringEnum<const T extends readonly string[]>(
    values: T,
    options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
    return Type.Unsafe<T[number]>({ type: 'string', enum: [...values], ...options });
}
