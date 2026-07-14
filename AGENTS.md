# rho global agent context

Personal instructions that apply across my projects. Symlink or copy this into
`~/.pi/agent/AGENTS.md`, or keep it here and let the package carry it.

## Conventions

- Be concise. No preamble, no filler.
- Prefer bun over npm/node for scripts.
- TypeScript, ESM, strict mode.

## Writing rules

- NEVER use em dashes. Not the unicode character, not the double-hyphen `--`, not the triple-hyphen `---`. This applies everywhere: prose, comments, commit messages, JSON strings, code. No exceptions.
- Use a period, a comma, parentheses, a colon or a semicolon instead.
- Prefer all lower case.
- Prefer ascii over unicode, unless forcing ascii becomes illegible. Examples: write `x_i` or `x[i]` not a unicode subscript, `x^i` not a superscript, `sum(x)` not a capital sigma, `sqrt(x)` not the radical sign, `->` not an arrow glyph.
