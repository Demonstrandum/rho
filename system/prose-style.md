# prose style

For the `prose` register only, per `o0` in `orthography.md`: text meant to be
read rather than parsed. Derived from New Yorker house style, with the
typesetting habits removed and the spelling made British.

Rule numbers carry a `p` prefix. They are disjoint from the `o` rules and from
the writer rules. Where a `p` rule and an `o` rule conflict, the `p` rule wins
in this register and nowhere else.

## p1. Spelling

British throughout, Oxford variant. The `-ise` / `-ize` choice follows etymology
and is decidable from the word, not from a list.

p1.(i) `-ize` where `-ize` is the Greek verb-forming suffix `-izein` attached to
a stem that stands alone: `organize`, `normalize`, `serialize`, `realize`,
`recognize`, `criticize`. Remove the suffix and a word remains: organ, normal.

p1.(ii) `-ise` where the letters belong to the stem and are not that suffix:
`advertise`, `comprise`, `despise`, `disguise`, `exercise`, `improvise`,
`revise`, `supervise`, `surprise`, `televise`. Remove `-ise` and nothing
remains. These come through French `-iser` from Latin, not from Greek.

p1.(iii) `-yse`, never `-yze`: `analyse`, `paralyse`, `catalyse`, `dialyse`,
`electrolyse`. These are back-formations from `analysis`, `paralysis`,
`catalysis`. The `-lys-` is Greek `lysis`, a loosening, and no `-izein` suffix
is present, so the `z` has no source. `paralyze` is an American respelling by
analogy, not an etymological form.

p1.(iv) Noun `-ce`, verb `-se`: `a practice` and `to practise`, `a licence` and
`to license`, `advice` and `to advise`, `a prophecy` and `to prophesy`.
`defence`, `offence`, and `pretence` are nouns.

p1.(v) `-our` and `-re`: `colour`, `behaviour`, `favour`, `theatre`, `centre`,
`fibre`. `metre` is the length, `meter` the instrument.

p1.(vi) Double a final `l` before a vowel suffix: `travelled`, `labelled`,
`modelling`, `cancelled`. Do not double other final consonants: `focused`,
`biased`, `benefited`. The New Yorker's `focussed` is house style, not British
practice, and is not carried over.

p1.(vii) `program` for software, `programme` for anything else. `disk` for
storage, `disc` for the physical object. `analogue` except in `analog-digital`
compounds.

## p2. Diaeresis

p2.(i) Two dots over a vowel that follows another vowel and begins a new
syllable: `coöperate`, `reëlect`, `preëxisting`, `reëxamination`, `coördinate`,
`zoölogy`, `naïve`, `Laocoön`. Most cases are a repeated vowel across a prefix
boundary, but the rule is the syllable break, not the repetition.

p2.(ii) Not where the vowel pair is one sound: `cool`, `been`, `feed`, `noise`,
`aid`.

p2.(iii) Not a hyphen and not a closed form. `coöperate`, not `co-operate` and
not `cooperate`.

p2.(iv) This register only. In `code` and `technical` the closed form is used,
because the diacritic breaks a search for the plain letters.

## p3. Numbers

Replaces the New Yorker rule that spells out round numbers of any size.

p3.(i) Spell out an inexact value: `two million parameters`, `about three
hundred lines`, `half the corpus`, `a dozen cases`.

p3.(ii) Digits for an exact value that was counted or measured: `2000301
parameters`, `47 files`, `8.3 seconds`.

p3.(iii) Spelling out an exact number is an error. It asserts an approximation
the source does not have. To round, say so: `about two million (2000301)`.

p3.(iv) Digits always for versions, ports, addresses, page and section
citations, and any figure carrying a unit symbol.

p3.(v) No sentence opens with a digit. Recast the sentence; do not spell the
number out to satisfy the rule.

p3.(vi) `per cent` spelled out in this register. `%` elsewhere.

## p4. Agreement

p4.(i) A collective noun takes a plural verb when the members act as
individuals: `the team are divided`, `the government have announced`, `the
committee disagree among themselves`.

p4.(ii) Singular when the group acts as one body: `the committee has twelve
members`, `the government is a coalition`, `the jury was dismissed`.

p4.(iii) Pronouns follow the verb. `the team are divided among themselves`, not
`among itself`.

p4.(iv) Fixed within a passage. Once a group is plural, it stays plural for as
long as it is under discussion.

## p5. Punctuation

p5.(i) Serial comma.

p5.(ii) Close punctuation: commas around parenthetical elements that other
guides leave open. `Before Atwater died, of brain cancer, in 1991`. The commas
mark the boundaries of the interruption, which is information the reader needs.

p5.(iii) Comma and period placement stays logical, per `o1.(i)`. This is the
largest departure from the source style, which puts them inside the closing
quote.

p5.(iv) No em dashes, per the personal rules. The New Yorker uses them heavily;
the ban holds here.

p5.(v) No full stop after a contraction ending in the last letter of the word:
`Mr`, `Mrs`, `Dr`, `St`, `Ltd`. A full stop only after a true truncation:
`Prof.`, `vol.`, `ed.`, `Jan.`.

p5.(vi) `e.g.` and `i.e.` keep their stops and take no comma after them.

p5.(vii) Dates as `3 April 2025`: no ordinal suffix, no comma. ISO 8601 belongs
to the other registers.

## p6. Emphasis and titles

p6.(i) Italics for interior thought.

p6.(ii) Italics for books, films, journals, albums, and ships. Quotation marks
for articles, chapters, short poems, and songs. The source style quotes book
titles as well, a legacy of a magazine without italic display type; the
distinction is kept here.

p6.(iii) No capitals on offices or bodies: `the president`, `the
administration`, `the department`. Capitals only on proper names.

## p7. Typography

p7.(i) The source text is ASCII: straight quotes, straight apostrophes, `...`.
The diaeresis in p2 is the single exception, because it carries pronunciation.

p7.(ii) Curly quotes, true ellipses, non-breaking spaces, and ligatures are
produced by the renderer, never typed.

p7.(iii) A prose file that cannot be searched with plain ASCII has failed p7.(i)
somewhere.
