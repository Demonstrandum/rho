# orthography

Punctuation and characters follow scope, not appearance.
A mark belongs to the span it applies to, and no mark crosses a delimiter it does not own.

Rule numbers here carry an `o` prefix and are disjoint from the writer rules, which are numbered `1.` to `13.` with no prefix.
A bare `o2.(ii)` from the reader cites this file; a bare `2.(ii)` cites the writer rules.
Handle both as corrections, per Citation there.

## o0. Registers

o0.(i) Four classes of text.
`code`: source, comments, commit messages, config, filenames, shell.
`technical`: documentation, READMEs, issue and pull request text, specifications.
`prose`: essays, letters, write-ups meant to be read rather than parsed.
`verbatim`: anything quoted from a source.

o0.(ii) Every rule below applies to `code` and `technical`.
In `prose`, the `p` rules in `prose-style.md` override where they conflict, and every rule they do not name still holds.

o0.(iii) `verbatim` overrides all classes.
Quoted text keeps the punctuation and characters of its source, including the ones this file forbids.

o0.(iv) The narrowest enclosing class wins.
A code span inside prose is `code`.
A prose paragraph inside a docstring is `technical`.

o0.(v) The file extension is not the class.
A `.md` file can be `prose` and a `.txt` file can be `technical`.
When the class is not clear from the request, ask once.

## o1. Delimiters

o1.(i) `he said "stop," then left` -> `he said "stop", then left`.
The comma joins the outer sentence, so it stays outside the quote.
Same for the period: `"stop."` only when the sentence being quoted ends there.

o1.(ii) `*word,* and` -> `*word*, and`.
`**bold.**` -> `**bold**.` Emphasis wraps the word, not the punctuation after it.

o1.(iii) `` `foo.` `` -> `` `foo`. ``  `` `--flag,` `` -> `` `--flag`, `` A code span holds what is code.
A period is not part of the identifier.

o1.(iv) `(see below.)` -> `(see below).` when the parenthesis sits inside a sentence.
The period closes the sentence, so it goes last.

o1.(v) `he said "she said 'no' to that"` keeps one quote character throughout at one depth.
Do not alternate quote characters by nesting depth; rewrite to remove the nesting.

## o2. Characters

o2.(i) `…` -> `...`, and only where an omission is real.

o2.(ii) `“smart quotes”` `’` `‘` -> `"` `'`.
Curly quotes never appear in code, commands, paths, identifiers, or config.
Do not mix `don’t` and `don't` in one document.

o2.(iii) `⇒` `≤` `≠` `×` `÷` `•` `✓` `½` -> `=>` `<=` `!=` `*` `/` `-` `[x]` `1/2`.

o2.(iv) `ﬁle` `ﬂag` -> `file` `flag`.
Ligature characters arrive from PDF copy and do not match a search for the letters.

o2.(v) `Ω` (U+2126 ohm sign) -> `Ω` (U+03A9).
`µ` (U+00B5) -> `μ` (U+03BC).
`Å` decomposed -> precomposed.
Two byte sequences that render alike must be normalised to one, NFC.

o2.(vi) No U+00A0, U+2009, U+200B, U+200E, U+00AD, or a variation selector in written text.
`5 000` -> `5000`.
An invisible character is a character.

o2.(vii) Line endings are LF.
Not CRLF, not U+0085.

## o3. Abbreviation and number

o3.(i) `etc..` -> `etc.` at sentence end is the standard collapse, and it loses the terminator.
Rewrite so the abbreviation is not final: `and so on.`

o3.(ii) `CD's` `1990's` -> `CDs` `1990s`.
The apostrophe marks elision or possession, not a plural.

o3.(iii) `1,024` -> `1024`.
No separator by default: a comma collides with the decimal comma, a space of any width is invisible.
Group with an underscore only when a number of five digits or more is meant to be read rather than copied: `1_930_282_519`.
Give an exact value plain, with the magnitude beside it: `1930282519 (1.93e9)`.
In a table, right-align instead of grouping.

o3.(iv) `03/04/25` -> `2025-04-03`.
ISO 8601 for every date.

o3.(v) `1ˢᵗ` -> `1st`.

## o4. Spacing

o4.(i) One space after a period.
Never two.

o4.(ii) No space before `;` `:` `!` `?` `%`.

## o5. Lines

o5.(i) One sentence, one line.
Do not wrap a paragraph to a column width.
The renderer wraps for display; the file stores sentences.

o5.(ii) A blank line separates paragraphs, as before.
Line breaks inside a paragraph mark sentence boundaries and nothing else.

o5.(iii) A list item follows the same rule: one line per sentence, continuation lines indented to the item's text.

o5.(iv) A long sentence stays on one long line.
Length is not a reason to break it, and a soft wrap in the editor costs nothing.

o5.(v) Exempt from o5.(i): code blocks, tables, YAML front matter, quoted material, and any file whose format assigns meaning to line position.

o5.(vi) This applies to `technical` and `prose`.
In `code`, the language's formatter decides.

## o6. Precedence

o6.(i) Inside a code block, a quoted command, a file path, a URL, a regular expression, or a data file, the bytes are what the parser reads.
Reproduce them exactly.
None of the rules above apply to content that is quoted from elsewhere.

o6.(ii) A number, a name, or a quotation reproduced from a source keeps the source's form even when a rule above would change it.
Correcting a quotation is misquotation.
