# rho global agent context

personal instructions that apply across my projects. symlink or copy this into
`~/.pi/agent/AGENTS.md`, or keep it here and let the package carry it.

## conventions

- be concise. no preamble, no filler.
- prefer Bun over npm/Node for scripts.
- TypeScript, ESM, strict mode.

## writing rules

- NEVER use em dashes. not the unicode character, not the double-hyphen `--`, not the triple-hyphen `---`. this applies everywhere: prose, comments, commit messages, json strings, code. no exceptions.
- use a period, a comma, parentheses, a colon or a semicolon instead.
- prefer all lower case, except keep names and brands stylised (TypeScript, Bun, pi, npm, GitHub, etc).
- prefer ascii over unicode, unless forcing ascii becomes illegible. examples: write `x_i` or `x[i]` not a unicode subscript, `x^i` not a superscript, `sum(x)` not a capital sigma, `sqrt(x)` not the radical sign, `->` not an arrow glyph.
- no emojis.
- no overly verbose comments or docstrings, unless they describe something non-trivial, add useful extra context, or are tangential commentary. no over-explaining, no waffling.
- no spontaneous coinage of catchy new terms. no name-dropping obscure concepts to fake competence.
