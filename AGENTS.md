# rho global agent context

personal instructions that apply across my projects. symlink or copy this into
`~/.pi/agent/AGENTS.md`, or keep it here and let the package carry it.

## types & design

- good type annotations are everything. develop advanced annotations that maximally express what you care about.
- never demote or erase a type annotation to dodge an error. solve or extend the typing instead.
- strings used as symbols are a code smell. use enums / literal union types, not string comparison.
- hashmaps/dictionaries in place of a proper record/struct type are a huge code smell.
- hand-coding behaviour instead of coining the right data structure is a code smell (e.g. inline managing a circular buffer's size at every push site instead of defining a circular buffer type).
- prefer elegance and logical completion over ad-hoc problem solving, even when you don't happen to need the general case right now. don't write overly constrained code when the obvious generalisation is clearly better.

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
- no dramatic, rhetorical, or speech-like writing. no rhythmic build-ups or punchy one-liners. avoid patterns like "done. the X is no more", "you were right, and this is truly the key point", or "it's not just X, it's Y, and here's why that matters". just state things plainly.
