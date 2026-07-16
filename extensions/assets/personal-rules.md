# personal rules

these apply to everything you write for me, across all projects.

## types & design

- good type annotations are everything. develop advanced annotations that maximally express what you care about.
- never demote or erase a type annotation to dodge an error. solve or extend the typing instead.
- strings used as symbols are a code smell. use enums / literal union types, not string comparison.
- hashmaps/dictionaries in place of a proper record/struct type are a huge code smell.
- hand-coding behaviour instead of coining the right data structure is a code smell (e.g. inline managing a circular buffer's size at every push site instead of defining a circular buffer type).
- prefer elegance and logical completion over ad-hoc problem solving, even when you don't happen to need the general case right now. don't write overly constrained code when the obvious generalisation is clearly better.
- do not touch other people's code or comments in a drive-by way. while doing one task, do not delete, rewrite, reformat, or refactor code a human wrote just because it looks wrong or violates these rules. leave it alone unless the task is specifically to change it, or ask first. these rules govern what you write, not a license to rewrite what others wrote.

## editing files

- never overwrite an existing file wholesale. to change a file that already exists, use the Edit tool with targeted replacements only. do not use the Write tool, `cat >`, shell redirection, or any other full-file rewrite on a file that already exists.
- the Write tool (or any create-from-scratch) is only ever for a genuinely new file that does not yet exist on disk.
- never bypass the Edit tool for an edit. if a change is awkward to express as one replacement, read the file and make several small targeted Edits. do not fall back to rewriting the whole file.
- before touching any file, assume it may be open in an editor with unsaved work. a full-file rewrite can destroy edits that are not yet saved and not in git. treat every existing file as if its on-disk copy is the only copy.

## conventions

- be concise. no preamble, no filler.
- prefer Bun over npm/Node for scripts.
- TypeScript, ESM, strict mode.
- indent with 4 spaces, never tabs.
- in languages with single-quote strings, use single quotes for symbolic strings (no spaces / identifier-like), e.g. `'session_start'`, and double quotes for human text, e.g. `"Hello, World!"`.

## tooling

- prefer `rg` (ripgrep) over `grep`, `fd` over `find`, and `fzf` for interactive filtering. they are faster, respect `.gitignore`, and have saner defaults.
- prefer `sd` over `sed` for scripted find/replace: literal-string mode and sane regex, none of the delimiter-escaping traps.
- prefer `ast-grep` (`sg`) over `rg` when the target is a code pattern rather than text (call sites, refactors): it matches syntax, not lines.
- reach for `jq` / `yq` when parsing JSON / YAML instead of grepping it, but only when there is structure to parse. not needed for every task.
- use `gh` for GitHub only when it is clearly more ergonomic than plain `git` (issues, PRs, releases); otherwise just use `git`.
- if a preferred tool is missing, do not silently fall back. tell me it is not installed and give me the install command (e.g. `brew install ripgrep fd fzf sd ast-grep jq yq gh`), then use the standard tool for that one command only.
- consider setting a timeout on long-running commands so they cannot hang the session. builds, test suites, installs, servers, and network calls all qualify.

## writing

- NEVER use em dashes. not the unicode character, not the double-hyphen `--`, not the triple-hyphen `---`. this applies everywhere: prose, comments, commit messages, json strings, code. no exceptions.
- use a period, a comma, parentheses, a colon or a semicolon instead.
- prefer all lower case, except keep names and brands stylised (TypeScript, Bun, pi, npm, GitHub, etc).
- prefer ascii over unicode, unless forcing ascii becomes illegible. examples: write `x_i` or `x[i]` not a unicode subscript, `x^i` not a superscript, `sum(x)` not a capital sigma, `sqrt(x)` not the radical sign, `->` not an arrow glyph.
- no emojis.
- keep comments and docstrings minimal. only write one when the code is non-trivial, when it adds context the code cannot show (why, not what), or as a genuine aside. do not restate the code, do not pad, do not explain the obvious.
- do not invent labels, coin cute names for things, or drop obscure jargon and references. it reads as trying to sound clever rather than being clear. use the plain existing word.
- write plainly, not performatively. do not build to a point, do not use rhetorical cadence, do not add a flourish to open or close. things i never want to see: hollow sign-offs ("done. X is gone."), fake-insight contrasts ("this isn't just X, it's Y"), escalating triads, or teasing colons that promise significance ("and here's the interesting part:"). just say what happened or what is true and stop.
