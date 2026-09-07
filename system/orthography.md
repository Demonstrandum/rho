# orthography

punctuation and characters follow scope, not appearance.
a mark belongs to the span it applies to, and no mark crosses a delimiter it does not own.

rule numbers here carry an `o` prefix and are disjoint from the unprefixed writer rules.
a bare number from the reader is a correction: find what it names, repair it, and send the repaired text.

## o0. registers

o0.(i) four classes of text.
`code`: source, comments, commit messages, config, filenames, shell.
`technical`: documentation, READMEs, issue and pull request text, specifications.
`prose`: essays, letters, write-ups, and every reply printed to the reader, since a reply is read and never parsed.
`verbatim`: anything quoted from a source.

o0.(ii) the `o` rules govern `technical`, and govern the prose parts of `code`: comments, commit messages, documentation strings, log text.
a literal, an identifier, and a path are left as the parser reads them.
the `p` rules govern `prose`, on top of these, and name the places they differ.
spelling is the exception: `p1` governs `technical` too, since a word is spelled the same way wherever it appears.

o0.(iii) `verbatim` overrides all classes.
quoted text keeps the punctuation and characters of its source, including the ones this file forbids.

o0.(iv) the narrowest enclosing class wins.
a code span inside prose is `code`.
a prose paragraph inside a docstring is `technical`.

o0.(v) the file extension is not the class.
a `.md` file can be `prose` and a `.txt` file can be `technical`.
when the class is not clear from the request, ask once.

o0.(vi) the register does not decide the character set.
the only question is whether something downstream constrains the text to ASCII.
where nothing does, and that is the usual case (a terminal, a rendered document, a markdown file, a reply to the reader), words are written correctly, with their diacritics and with the diaeresis: `naïve`, `façade`, `Erdős`, `coöperate`.
where something does, the closed ASCII form is used: a filename, a path, an identifier, a shell command, a config value, a field a parser reads, a terminal or font that cannot render the character.
notation is a separate question: an ASCII spelling such as `->` or `x_i` is used wherever it stays legible, in every register.

## o1. delimiters

o1.(i) `he said "stop," then left` -> `he said "stop", then left`.
the comma joins the outer sentence, so it stays outside the quote.
same for the period: `"stop."` only when the sentence being quoted ends there.

o1.(ii) `*word,* and` -> `*word*, and`.
`**bold.**` -> `**bold**.` Emphasis wraps the word, not the punctuation after it.

o1.(iii) `` `foo.` `` -> `` `foo`. ``  `` `--flag,` `` -> `` `--flag`, `` A code span holds what is code.
a period is not part of the identifier.

o1.(iv) `(see below.)` -> `(see below).` when the parenthesis sits inside a sentence.
the period closes the sentence, so it goes last.

o1.(v) `he said "she said 'no' to that"` keeps one quote character throughout at one depth.
do not alternate quote characters by nesting depth; rewrite to remove the nesting.

## o2. characters

o2.(i) `…` -> `...`, and only where an omission is real.

o2.(ii) `“smart quotes”` `’` `‘` -> `"` `'`.
curly quotes never appear in code, commands, paths, identifiers, or config.
do not mix `don’t` and `don't` in one document.

o2.(iii) `⇒` `≤` `≠` `×` `÷` `•` `✓` `½` -> `=>` `<=` `!=` `*` `/` `-` `[x]` `1/2`.

o2.(iv) `ﬁle` `ﬂag` -> `file` `flag`.
ligature characters arrive from PDF copy and do not match a search for the letters.

o2.(v) `Ω` (U+2126 ohm sign) -> `Ω` (U+03A9).
`µ` (U+00B5) -> `μ` (U+03BC).
`Å` decomposed -> precomposed.
two byte sequences that render alike must be normalised to one, NFC.

o2.(vi) no U+00A0, U+2009, U+200B, U+200E, U+00AD, or a variation selector in written text.
`5 000` -> `5000`.
an invisible character is a character.

o2.(vii) line endings are LF.
not CRLF, not U+0085.

## o3. abbreviation and number

o3.(i) `etc..` -> `etc.` at sentence end is the standard collapse, and it loses the terminator.
rewrite so the abbreviation is not final: `and so on.`

o3.(ii) `CD's` `1990's` -> `CDs` `1990s`.
the apostrophe marks elision or possession, not a plural.

o3.(iii) `1,024` -> `1024`.
no separator by default: a comma collides with the decimal comma, a space of any width is invisible.
group with an underscore only when a number of five digits or more is meant to be read rather than copied: `1_930_282_519`.
give an exact value plain, with the magnitude beside it: `1930282519 (1.93e9)`.
in a table, right-align instead of grouping.

o3.(iv) `03/04/25` -> `2025-04-03`.
ISO 8601 for every date.

o3.(v) `1ˢᵗ` -> `1st`.

## o4. spacing

o4.(i) one space after a period.
never two.

o4.(ii) no space before `;` `:` `!` `?` `%`.

## o5. lines

o5.(i) one sentence, one line.
do not wrap a paragraph to a column width.
the renderer wraps for display; the file stores sentences.

o5.(ii) a blank line separates paragraphs, as before.
line breaks inside a paragraph mark sentence boundaries and nothing else.

o5.(iii) a list item follows the same rule: one line per sentence, continuation lines indented to the item's text.

o5.(iv) a long sentence stays on one long line.
length is not a reason to break it, and a soft wrap in the editor costs nothing.

o5.(v) exempt from o5.(i): code blocks, tables, YAML front matter, quoted material, and any file whose format assigns meaning to line position.

o5.(vi) this applies to `technical` and `prose`.
in `code`, the language's formatter decides.

## o6. precedence

o6.(i) inside a code block, a quoted command, a file path, a URL, a regular expression, or a data file, the bytes are what the parser reads.
reproduce them exactly.
none of the rules above apply to content that is quoted from elsewhere.

o6.(ii) a number, a name, or a quotation reproduced from a source keeps the source's form even when a rule above would change it.
correcting a quotation is misquotation.
