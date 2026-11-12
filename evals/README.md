# prompt evals

the prompt in `system/` exists to produce particular behaviour, and how much text a model needs before it behaves that way differs by model.
this directory measures that, so the prompt can be tuned per model: text that every model already obeys is removed, and text a model ignores is rephrased or made specific to that model.

these are not tests.
whether a response honours the prompt is a judgement about prose and behaviour, so it is made by a reader: the person, in the review UI, and a judge model, whose findings the person answers.
code decides only facts about the end state (origin did not move, a file is unchanged, the tests pass).
nothing here fails a build.

## pieces

- `scenarios/` one file per scenario: a small invented project built by `setup`, one request, and what the scenario was built to observe.
  `checks` are facts about the end state, decided by code.
  `criteria` are the points the scenario centres on, shown to both reviewers; a review covers every rule regardless.
  every check and criterion names an intent.
- `lib/intents.ts` the intents: one per intention of the prompt, each naming the fragment and section that asks for it.
  the report groups grades by intent, so a row reads as "this model honours this part of the prompt".
- `lib/rules.ts` the rules a response is reviewed against, read from `system/`: numbered rules keep their ids (`8.(i)`, `o2.(iii)`), and the bullets of `personal-rules.md` get `<section>.<n>` (`risky-actions.1`).
- `lib/review.ts` a review: ratings on five dimensions, an analysis, and annotations pinned to a quoted span and a rule; `lib/review-store.ts` the runs of a directory and the summary over their reviews.
- `lib/judge.ts` the judge: pi with no extensions, given every rule, writing a review in the same shape as the person's.
- `lib/session.ts` writes a scenario's `seed` turns as a session file, so a run can continue a conversation: a bare rule number sent as a correction, a push approved one turn earlier, a substitute word left by the display filter.
- `lib/models.ts` the default model matrix, checked against `pi --list-models` before anything runs.
- `lib/runner.ts` one run, and the scheduler; `lib/report.ts` the report, built from the `result.json` files a directory holds.
- `run.ts` runs the suite. it writes `results/<stamp>/report.md` (the end-state facts), and per run `run.json` (what was asked), `events.jsonl`, `transcript.md`, `diff.patch`, `result.json`, and the judge's review in `reviews/`.
- `review.ts` and `review.html` the review UI, the judge pass over an existing directory, and the summary.
  `results/` is not committed; `FINDINGS.md` records what the runs showed.

each run is the installed pi with rho loaded, `--mode json -p`, in a fresh temporary directory outside any repository (so no `AGENTS.md` above it is read), with its own git config, and with no saved session unless the scenario is seeded.
the text the model wrote is read from the stream before `wordswap.ts` rewrites it.

## usage

```sh
bun evals/run.ts --list                                     # the scenarios and the intents each observes
bun evals/run.ts --coverage                                 # every prompt section against the scenarios that observe it
bun evals/run.ts                                            # every scenario on every model in lib/models.ts, 2 runs each
bun evals/run.ts --models anthropic/claude-haiku-5-5:low --scenarios docs-deploy --repeat 3
bun evals/run.ts --variant path/to/overlay --label lean     # a prompt variant
```

`--judge` picks the judge (default `anthropic/claude-opus-5-5:high`), `--thinking` the level for models given without one (default `medium`), `--keep` keeps the fixtures.

## running in parallel

runs share nothing on disk, so the limit is the provider.
`--concurrency` caps the runs in flight (default 12) and `--per-model` caps them for any one model (default 3), so one slow model does not hold the queue.

`--out <dir>` names the results directory, and a run whose `result.json` is already there is skipped, so an interrupted suite resumes by running the same command again.
`--shard k/n` takes every n-th job starting at the k-th, so n processes, or n machines, split the suite:

```sh
for k in 1 2 3 4; do bun evals/run.ts --out evals/results/matrix --shard $k/4 & done; wait
bun evals/run.ts --report evals/results/matrix              # one report over every shard
```

shards on separate machines merge by copying their directories into one and running `--report` on it.

## variants and per-model text

`system-prompt.ts` resolves the prompt once per model, and the template sees `model` (`{ provider, id }`).
text that one model needs and another does not goes in an `{{#if model.id.startsWith('claude-opus')}}` block, so each model pays only for its own lines.
keep such a block a whole list item: the markdown rewrite in `tests/disenshittification.test.ts` does not treat a continuation line after an `{{#if}}` line as part of the item above it.

a variant is a directory holding only the fragments it changes.
`RHO_PROMPT_OVERLAY` puts it ahead of `system/` on the search path, and `--variant` sets that for every run.
copy a fragment into the overlay, edit the copy, run, compare the report with a run of the live prompt, and then either move the change into `system/` or drop the overlay.

## reviewing

```sh
bun evals/review.ts evals/results/round-1                  # the UI, on http://localhost:4777
bun evals/review.ts evals/results/round-1 --judge          # a judge review for every run without one
bun evals/review.ts evals/results/round-1 --summary        # ratings and findings per model, as markdown
```

the UI lists the runs on the left, the conversation in the middle, and the review on the right.
select text in a reply, a command, or a tool result to annotate it with a rule, a severity, and a note.
rate each dimension from 1 to 5 (task, judgement, code, prose, format) and write an analysis.
the judge's findings are highlighted in blue beside yours in yellow; answer each with agree or disagree, or copy it as yours.
blind mode hides the model names, so a review is not coloured by which model wrote the run.

a finding counts in the summary when the person wrote it or agreed with the judge's.
the summary also gives the judge's agreement rate, which says how far its unanswered findings can be trusted.
reviews are saved as `reviews/<author>.json` beside each run.

## method

1. run the live prompt on every model, and have the judge review every run.
2. review the runs, starting where the judge's ratings are low and where models disagree on a scenario.
   a bad run is either the model or the scenario: a fixture that cannot pass, or a request the rules do not settle.
   fix the scenario first; a prompt tuned against a broken scenario is tuned to the scenario.
3. where a rule draws no findings on any model, try a variant without the text that asks for it.
   if the reviews hold, that text is not doing anything for these models on these scenarios.
4. where a model fails, try a variant that rephrases the text for that model: a concrete example of the case it got wrong, the wanted form beside the unwanted one, a block conditional on that model.
5. adopt what moved the reviews, run the live prompt again, and record the result in `FINDINGS.md`.

the scenarios are small and few, so a passing intent shows that a model behaves on those cases.
it does not show the text is safe to remove for cases the scenarios do not cover, and that matters most for the risky-action rules, where one failure costs more than the tokens saved.
