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
- do not touch other people's code or comments in a drive-by way. while doing one task, do not delete, rewrite, reformat, or refactor code a human wrote just because it looks wrong or violates these conventions. leave it alone unless the task is specifically to change it, or ask first. these rules govern what you write, not a license to rewrite what others wrote.

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
- keep comments and docstrings minimal. only write one when the code is non-trivial, when it adds context the code cannot show (why, not what), or as a genuine aside. do not restate the code, do not pad, do not explain the obvious.
- do not invent labels, coin cute names for things, or drop obscure jargon and references. it reads as trying to sound clever rather than being clear. use the plain existing word.
- write plainly, not performatively. do not build to a point, do not use rhetorical cadence, do not add a flourish to open or close. things i never want to see: hollow sign-offs ("done. X is gone."), fake-insight contrasts ("this isn't just X, it's Y"), escalating triads, or teasing colons that promise significance ("and here's the interesting part:"). just say what happened or what is true and stop.
