# prose style

for the `prose` register: text meant to be read rather than parsed.
british spelling, close punctuation, and a small set of conventions that print style gets right.
spelling is the exception: a word is spelled the same way wherever it appears, so `p1` holds in `technical` too.

rule numbers carry a `p` prefix and are disjoint from the other numbered rules.

## p1. spelling

British throughout, Oxford variant.
the `-ise` / `-ize` choice follows etymology and is decidable from the word, not from a list.

p1.(i) `-ize` where `-ize` is the Greek verb-forming suffix `-izein` attached to a stem that stands alone: `organize`, `normalize`, `serialize`, `realize`, `recognize`, `criticize`.
remove the suffix and a word remains: organ, normal.

p1.(ii) `-ise` where the letters belong to the stem and are not that suffix: `advertise`, `comprise`, `despise`, `disguise`, `exercise`, `improvise`, `revise`, `supervise`, `surprise`, `televise`.
remove `-ise` and nothing remains.
these come through French `-iser` from Latin, not from Greek.

p1.(iii) `-yse`, never `-yze`: `analyse`, `paralyse`, `catalyse`, `dialyse`, `electrolyse`.
these are back-formations from `analysis`, `paralysis`, `catalysis`.
the `-lys-` is Greek `lysis`, a loosening, and no `-izein` suffix is present, so the `z` has no source.
`paralyze` is an American respelling by analogy, not an etymological form.

p1.(iv) noun `-ce`, verb `-se`: `a practice` and `to practise`, `a licence` and `to license`, `advice` and `to advise`, `a prophecy` and `to prophesy`.
`defence`, `offence`, and `pretence` are nouns.

p1.(v) `-our` and `-re`: `colour`, `behaviour`, `favour`, `theatre`, `centre`, `fibre`.
`metre` is the length, `meter` the instrument.

p1.(vi) double a final `l` before a vowel suffix: `travelled`, `labelled`, `modelling`, `cancelled`.
do not double other final consonants: `focused`, `biased`, `benefited`.
`focussed` with two esses is not British practice.

p1.(vii) `program` for software, `programme` for anything else.
`disk` for storage, `disc` for the physical object.
`analogue` except in `analog-digital` compounds.

## p2. diaeresis

p2.(i) two dots over a vowel that follows another vowel and begins a new syllable: `coöperate`, `reëlect`, `preëxisting`, `reëxamination`, `coördinate`, `zoölogy`, `naïve`, `Laocoön`.
most cases are a repeated vowel across a prefix boundary, but the rule is the syllable break, not the repetition.

p2.(ii) not where the vowel pair is one sound: `cool`, `been`, `feed`, `noise`, `aid`.

p2.(iii) not a hyphen and not a closed form.
`coöperate`, not `co-operate` and not `cooperate`.

p2.(iv) the closed form is used only where the text is constrained to ASCII: an identifier, a filename, a path, a shell command, a config value.
prose, documentation, and a reply to the reader are not constrained, so they take the diaeresis.

## p3. numbers

p3.(i) spell out an inexact value: `two million parameters`, `about three hundred lines`, `half the corpus`, `a dozen cases`.

p3.(ii) digits for an exact value that was counted or measured: `2000301 parameters`, `47 files`, `8.3 seconds`.

p3.(iii) spelling out an exact number is an error.
it asserts an approximation the source does not have.
to round, say so: `about two million (2000301)`.

p3.(iv) digits always for versions, ports, addresses, page and section citations, and any figure carrying a unit symbol.

p3.(v) no sentence opens with a digit.
recast the sentence; do not spell the number out to satisfy the rule.

p3.(vi) `per cent` spelled out in this register.
`%` elsewhere.

## p4. agreement

p4.(i) a collective noun takes a plural verb when the members act as individuals: `the team are divided`, `the government have announced`, `the committee disagree among themselves`.

p4.(ii) singular when the group acts as one body: `the committee has twelve members`, `the government is a coalition`, `the jury was dismissed`.

p4.(iii) pronouns follow the verb.
`the team are divided among themselves`, not `among itself`.

p4.(iv) fixed within a passage.
once a group is plural, it stays plural for as long as it is under discussion.

## p5. punctuation

p5.(i) serial comma.

p5.(ii) close punctuation: commas around parenthetical elements that other guides leave open.
`Before Atwater died, of brain cancer, in 1991`.
the commas mark the boundaries of the interruption, which is information the reader needs.

p5.(iii) a comma or a period goes outside the closing quote unless it belongs to the quoted sentence.
`he said "stop", then left`, because the comma joins the outer sentence.

p5.(iv) no em dash in exposition.
in dialogue, a transcript, or reported speech, it is the correct mark and is used.
an em dash between clauses of an explanation is a tic, and a comma, a colon, or a semicolon is what the sentence needs.

p5.(v) no full stop after a contraction ending in the last letter of the word: `Mr`, `Mrs`, `Dr`, `St`, `Ltd`.
a full stop only after a true truncation: `Prof.`, `vol.`, `ed.`, `Jan.`.

p5.(vi) `e.g.` and `i.e.` keep their stops and take no comma after them.

p5.(vii) dates as `3 April 2025`: no ordinal suffix, no comma.
ISO 8601 belongs to the other registers.

## p6. emphasis and titles

p6.(i) italics for interior thought.

p6.(ii) italics for books, films, journals, albums, and ships.
quotation marks for articles, chapters, short poems, and songs.
a style that quotes book titles as well loses the distinction between a whole work and a part of one.

p6.(iii) no capitals on offices or bodies: `the president`, `the administration`, `the department`.
capitals only on proper names.

## p7. character set

p7.(i) words are written correctly, with the diacritics they carry and with the diaeresis: `naïve`, `façade`, `Erdős`, `coöperate`.
this holds wherever nothing constrains the text to ASCII, which covers a terminal, a rendered document, a markdown file, and a reply to the reader.

p7.(ii) where something downstream reads the text as ASCII, the closed form is used: `cooperate`.
that covers a filename, a path, a URL, an identifier, a shell command, a config value, a field a parser reads, and a terminal or font that cannot render the character.

p7.(iii) straight quotes, straight apostrophes, and `...` in the stored text.
curly quotes, true ellipses, non-breaking spaces, and ligatures come from the renderer, never from the keyboard.
the diaeresis is not typography: it marks pronunciation, so it is stored.

p7.(iv) nothing decorative in either case: no arrows, dingbats, emoji, box glyphs, or symbols standing in for words.

p7.(v) grep and diff read UTF-8, so neither is a reason to drop a diacritic.
the reason to drop one is a destination that cannot carry it.
