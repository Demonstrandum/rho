// a colour written as configuration, resolved against the live theme.
//
// the spec is one string, so a TOML value can name a theme colour and adjust
// it in the same breath:
//
//   "border"            a theme foreground or background colour, by name
//   "#3366aa"           a hex code
//   "dim@l+20"          either of those, with HSL filters after the @
//   "border@l=80,s*0.4" several filters, comma separated
//
// the theme is passed in rather than held here: an extension captures it at
// session_start and again when it changes, and this file stays a function of
// its arguments.

import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent';
import {
    type Rgb,
    applyHslFilters,
    hslToRgb,
    parseHex,
    rgbToHsl,
    themeBgRgb,
    themeRgb,
} from './utils';

export function resolveColour(theme: Theme | undefined, spec: string): Rgb | undefined {
    if (!spec || !theme) return undefined;

    let colourPart = spec;
    let filters: string[] | undefined;
    const at = spec.indexOf('@');
    if (at !== -1) {
        colourPart = spec.slice(0, at);
        filters = spec.slice(at + 1).split(',');
    }

    let rgb: Rgb | undefined;
    if (colourPart.startsWith('#')) {
        rgb = parseHex(colourPart);
    } else {
        // a name can be either a foreground or a background colour, and the
        // theme throws on a name it does not hold rather than returning
        // undefined, so both lookups are guarded.
        try { rgb = themeRgb(theme, colourPart as ThemeColor); } catch {}
        if (!rgb) { try { rgb = themeBgRgb(theme, colourPart); } catch {} }
    }
    if (!rgb) return undefined;

    if (filters && filters.length > 0) {
        rgb = hslToRgb(applyHslFilters(rgbToHsl(rgb), filters));
    }
    return rgb;
}
