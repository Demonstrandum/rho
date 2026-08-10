# system prompt fragments

each file in this directory is a fragment of the system prompt. extensions in
`extensions/` read these files and append them in `before_agent_start`, after
pi's base system prompt.

## injection order

| fragment | extension | what it governs |
|---|---|---|
| `personal-rules.md` | `personal-rules.ts` | conventions, design, editing, tooling, writing |
| `writer-rules.md` | `writer-rules.ts` | ASD-STE100 derived prose standard (13 rule categories) |
| `vocabulary.md` | `wordswap.ts` | word/pattern swap list, templated from `extensions/assets/wordswap.json` |

`prompt-defingerprint.ts` runs last and rewrites fingerprinted lines in the
assembled prompt. it has no fragment file.

## how templating works

`vocabulary.md` contains `{{WORDS}}` and `{{PATTERNS}}` placeholders.
`wordswap.ts` reads the template at load time and fills them from
`extensions/assets/wordswap.json`. the other two fragments are static.

## editing

edit the `.md` files here. `/reload` in a pi session picks up changes
without a restart (each extension re-reads at module init).
