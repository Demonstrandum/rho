# system prompt fragments

`prompt.md` is the master template. open it to see the full shape.

`extensions/system-prompt.ts` reads it once at load, resolves includes,
fills variables, caches the result, and appends it in `before_agent_start`.

## master template (prompt.md)

uses two directive types:

- `{{include:file.md}}` inlines a fragment file from this directory.
- `{{VARIABLE}}` is filled from code (see variables below).

resolution order: includes first, then variables, then blank-line cleanup.

## fragments

| file | what it governs |
|---|---|
| `personal-rules.md` | conventions, design, editing, tooling, writing |
| `writer-rules.md` | ASD-STE100 derived prose standard (13 rule categories) |
| `vocabulary.md` | word/pattern swap list (sub-template) |

## variables

| variable | source | filled by |
|---|---|---|
| `{{WORDS}}` | `extensions/assets/wordswap.json` `.words` | `system-prompt.ts` via `wordswap.ts` exports |
| `{{PATTERNS}}` | `extensions/assets/wordswap.json` `.patterns` | `system-prompt.ts` via `wordswap.ts` exports |

when `PATTERNS` is empty (no pattern swaps in the json), the variable
resolves to an empty string and the cleanup pass collapses the blank lines.

## other prompt-time extensions

`prompt-defingerprint.ts` runs after this and rewrites fingerprinted lines
in the assembled prompt. it has no fragment file.

## editing

edit the `.md` files here. `/reload` in a pi session picks up changes
(module init re-runs, which creates a fresh `PromptLoader` instance and
re-resolves the template).
