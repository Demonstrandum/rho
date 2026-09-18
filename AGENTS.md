# rho

this repo is my personal pi dotfiles, structured as a pi package.
install it on any machine and everything below is active when i run pi.
no symlinking, no manual setup.

this file is loaded into the system prompt of every session in every project, so its length is paid for on every request.
keep it an index: one line per file, naming what the file does and the `rho.toml` section that configures it.
reasoning, mechanism, and the traps behind a design go in `docs/extensions.md` or in the header comment of the file itself, both of which are read only when someone opens them.
if an entry here is growing past two lines, that is the signal to move it.

## what's here

- `extensions/` typescript extensions (tools, commands, ui, hooks), auto-discovered from top-level `*.ts`.
  one line each below; the reasoning is in `docs/extensions.md` and in each file's header comment
  - `system-prompt.ts` assembles `system/prompt.md` and appends it in `before_agent_start`
  - `bun-runtime.ts` stops a node session: patches pi's shebang to bun, re-runs under bun, else exits with a note, `[runtime]`
  - `env-block.ts` appends an `<env>` block: cwd, git work tree, platform, date, model, `[env]`
  - `git-snapshot.ts` appends a `<git>` block: branch, upstream divergence, dirty files, recent commits, `[git]`
  - `personality.ts` `/personality <name|path|off>` sets the session's voice; system prompt before the first turn, a message after, `[personality]`
  - `scratchpad.ts` gives the session a scratch directory, names it in the prompt and in `RHO_SCRATCH`, `[scratch]`
  - `prompt-defingerprint.ts` rewrites the lines of pi's prompt that anthropic classifies as third-party, keeping OAuth requests on plan billing.
  - `prompt-disenshittify.ts` rewrites the whole system prompt into the house style: dashes, characters, case, list punctuation, `[prompt]`.
  - `skill-listing.ts` flattens pi's `<available_skills>` block: xml escapes undone, indentation dropped.
  - `wordswap.ts` swaps overused phrases in finalized messages, from `assets/wordswap.json`; `/noswap` per message, `[wordswap]`
  - `auditor.ts` `/audit` reviews the last reply against the writer rules with a second model, `[audit]`
  - `goal.ts` `/goal <condition>` keeps the session working until a second model judges the condition met, `[goal]`
  - `stash.ts` `ctrl+s` parks the editor text, `ctrl+r` pops, `/stash` opens the picker, `[stash]`
  - `send-now.ts` `ctrl+enter` cuts into a running turn, `ctrl+shift+enter` sends the newest queued message alone, `[send-now]`
  - `prompt-history.ts` prompt history that survives a restart, `/history`, incremental search on `ctrl+f`, `[history]`
  - `cwd.ts` `/cwd [path]` changes the agent's working directory mid-session, `[cwd]`
  - `quit.ts` `/exit`, and the bare words `quit` / `exit`, end the session, `[quit]`
  - `prompt-inspect.ts` `/prompt` browses the provider payloads and the system prompt, and dumps either to disk.
  - `sample-session.ts` `pi --sample-session` and `/sample-session` open a made-up session: tool calls, thinking, branches, every entry kind.
  - `session-tree.ts` patches `/tree` (and esc esc, and shift+ctrl+t) into an edit surface: select a span, delete, summarise, prune or rewrite it, commit as a copy; `/session-copy`, `/session-backup`.
  - `input-field.ts` styles the input field: half-block edges, background, gradient, `[input]`
  - `command-hint.ts` shows the form of the command being typed at the right of the field, fading out as the typed line approaches it, `[hint]`
  - `spinner.ts` working indicator and shimmering message, from `assets/spinners.json`, `maxims.txt`, `verbs.txt`; `[spinner] placement` puts it on its own row below the input field or in the field's border.
  - `startup.ts` replaces pi's startup block with a compact header.
  - `footer.ts` replaces the footer: custom token arrow glyphs, and spend as what is charged with the api price beside it.
  - `halfblock-boxes.ts` four render patches (half-block padding, tighter tool rows, no idle status), `[render]`
  - `tool-rows.ts` names every tool row and gives it its subject; the exec rows keep their command preview, `[tools]`
  - `clear-on-shrink.ts` persists `terminal.clearOnShrink=true`
  - `image-width.ts` persists `terminal.imageWidthCells`, `[images] width`
  - `image-size.ts` caps inline image height at a fraction of the terminal, `[images] max-height-fraction`
  - `silence-extra-usage-warning.ts` persists `warnings.anthropicExtraUsage=false`
  - `extra-usage-watch.ts` warns once when response headers show extra-usage billing.
  - `merge-thinking-blocks.ts` merges adjacent thinking blocks in the anthropic payload, which the api rejects.
  - `rewind-guard.ts` gates pi-rewind's per-turn checkpoint to directories where it can finish, `[rewind]`
  - `remove.ts` blocks a `write` that would replace a file holding bytes, and adds a `remove` tool that uses the machine's trash, `[files]`
  - `undo.ts` journals every write, edit and remove with a copy of the file as it was, and adds an `undo` tool that puts one back, `[files]`
  - `search.ts` `/search` and a `pi_search` tool over pi's commands and docs, `[search]`
  - `slack.ts` `/slack <app>` puts a Slack DM in front of this session: socket in-session, read mark, typing status, `[slack]`
  - `context.ts` `/context` context-window readout.
  - `syntax.ts` `/syntax [name]` sets the colours code is drawn in, over any theme; `/syntax none` restores the theme's own, `[syntax]`
  - `theme.ts` `/theme [name]` previews each theme as the completion menu passes over it; `/theme-picker` picks one against a sample session, `[theme]`
  - `web.ts` `/web` runs the pi-web UI as a background service.
  - `rho.ts` `/rho config` shows and writes the live `rho.toml`
  - `update.ts` `/update [pi|rho]` updates pi, the packages, and an rho checkout, then reloads the session.
  - `agentica.ts` an `agentica` MCP tool, registered only when `RHO_AGENTICA_RUNTIME` is set.
  - `lib/` shared modules, in a subdirectory so auto-discovery does not load them: `config.ts` (`rho.toml`), `bun-launcher.ts` (locate and repair pi's launcher shebang), `state-store.ts` (on-disk extension state, scoped global/project/session), `settings-store.ts` (idempotent settings writes), `prompt-loader.ts`, `goal.ts` (the goal judge and its transcript rendering), `widget-spinner.ts` (the wait shown for an out-of-turn model call), `working-status.ts` (which surface the working indicator is drawn on, and what must not paint over it), `disenshittification.ts` (the house-style rewrite), `reflow.ts` (one sentence per line), `template.ts`, `source-str.ts`, `utils.ts`, `audit.ts`, `stash.ts`, `prompt-history.ts`, `pi-docs.ts`, `slack-api.ts` (Slack calls and the Socket Mode client), `slack-config.ts` (the app store and the per-app lock), `steering-mirror.ts`, `keybindings-store.ts`, `checkpoint-breaker.ts`, `file-store.ts` (one machine's files: stat, digest, copy, trash), `acting-file.ts` (which machine a tool's path argument names), `undo-journal.ts` (one record per file mutation, and putting one back), `billing.ts` (which pool anthropic billed a response to, and what extra usage has cost), `box-edges.ts` (blank edges of a rendered block, and what an image reserves), `text.ts` (the string primitives: escapes, fitting, plurals, counts, durations, names), `command-usage.ts` (what each slash command takes, and which form the typed text is on its way to), `command-hint.ts` (where that form goes in the row, and what colour each character is), `colour-spec.ts` (a configured colour against the live theme), `tool-row/` (`title.ts`, `preview.ts`, `exec.ts`, `theme.ts`, `notes.ts`), `intro-card.ts` (one playing of the wordmark intro), `startup-header.ts` (the block a session opens with), `footer-mirror.ts` (the footer as last drawn), `theme-sample.ts` (a sample session drawn by pi's own components), `syntax-palette.ts` (the code colours, laid over any theme), `side-by-side.ts` (a list beside what it is choosing between), `autocomplete-focus.ts` (which completion item is under the cursor), `preview-hold.ts` (put back what a preview replaced), `choice.ts` (a short list of named outcomes, picked by arrow or by first letter), `leave-terminal.ts` (ending this process with the terminal put back, and the lines that say how to come back), `sample-session.ts` (the made-up session, entry by entry), `session-edit.ts` (the tree edit buffer and its surgery), `session-file.ts` (a whole tree written to a new session file), `tree-keys.ts` (the tree view's modal keys), `tree-gutter.ts` (the selection band and the relative row numbers), `pi-logo.ts`, `tetris-logo.ts`
  - `assets/` data files (`spinners.json`, `maxims.txt`, `verbs.txt`, `wordswap.json`, `agentica_helper.py`)
- `personalities/` pre-authored personalities, one `.md` each, picked by name with `/personality`; a file of the same name in `<rho config dir>/personalities/` shadows one here.
- `skills/` on-demand skills (`SKILL.md` folders + top-level `.md`)
- `prompts/` prompt templates, expanded with `/name`
- `themes/` color themes (`.json`)
- `system/` the system prompt, assembled from fragments (see `system/README.md`)
  - `prompt.md` master template; shows the full shape with `{{include:...}}` directives.
  - `personal-rules.md` conventions, design, editing, tooling, risky actions, writing.
  - `writer-rules.md` ASD-STE100 derived prose standard (13 rule categories).
  - `orthography.md` `o` rules: the four registers (`code`, `technical`, `prose`, `verbatim`) and which rules each takes, punctuation placed by scope rather than by appearance, character substitutions, numbers, and one sentence per line.
  - `prose-style.md` `p` rules, for the `prose` register: British spelling with the `-ise`/`-ize` split stated by etymology, the diaeresis, exact numbers in digits and inexact ones spelled out, collective plurals, and close punctuation with the comma outside the closing quote.
  - `vocabulary.md` sub-template for the word/pattern swap list (`{{WORDS}}`, `{{PATTERNS}}`)
- `docs/extensions.md` why each extension is built the way it is; read it before changing one.
- `extensions/assets/syntax.json` syntax palettes for `/syntax`, keyed by name (`origin`, `colors` by role).
- `extensions/assets/spinners.json` spinner definitions keyed by name (`category`, `interval`, `frames`); enabled categories live in `spinner.ts` (`chinese` by default).
- `extensions/assets/maxims.txt` working messages, one per line, `;` comments, picked at random each turn.
- `extensions/assets/verbs.txt` completion verbs, one per line, `;` comments, picked at random for the settle line (`完 <verb> for <duration>`)
- `rho.toml` generated output, never hand-edited: the schema in `extensions/lib/config.ts` printed with its docs.
  change the schema, then run `bun run config`; `tests/config.test.ts` fails while the two disagree.
- `package.json` the `pi` manifest declaring resource paths.
- bundled third-party packages (in `dependencies` + `bundledDependencies`, referenced via `node_modules/...` in the `pi` manifest): `pi-web-access`, `@ayulab/pi-rewind`, `context-mode`, `token-rate-pi` (shows average output tokens/sec in the footer status line), `pi-subagents` (subagent delegation; also contributes its own skills and prompts).
  they install and load automatically with rho.

## ci and tooling

one line each; the detail is in `docs/extensions.md`.

- `ci/mock-provider.ts` a local openai-completions server standing in for a model, scripted by turn.
- `ci/smoke.ts` (`bun run smoke`) end-to-end check in a temporary tree: no api key, no network, nothing written outside it.
- `ci/Dockerfile` (`bun run smoke:docker`) node 24 slim plus bun, rho installed as a user package so the install path is covered.
- `.github/workflows/ci.yml` `checks` (typecheck + `bun test`) and `smoke`, on push, pull request, dispatch, and daily.
- `tools/init-config.ts` (`bun run config`, `bun run init`) writes `rho.toml` from the schema; the repo copy is regenerated, never edited.
- `tools/version-gate.mjs`, `tools/preflight.ts` (`bun run doctor`), `tools/pi-location.ts` install-time checks and pi discovery.
- `tools/bun-shebang.ts` (`bun run bun-shebang`) points pi's launcher at bun; runs from `postinstall`, since `pi update` restores the node shebang.
- `tools/prompt-explorer.ts` (`bun run prompt`, `prompt:cli`, `prompt:preview`, `prompt:plain`) shows the assembled prompt.
- `tools/slack-preview.ts` (`bun run slack:preview`) draws every Slack tool row and the arriving-message box, collapsed and expanded, through the renderers a session uses.
- `tools/prompt-full.ts` (`bun run prompt:full`) shows the prompt as the provider receives it, pi's text included.
- `tools/reflow.ts` (cli over `extensions/lib/reflow.ts`) rewrites markdown to one sentence per line; run it after editing markdown here.
- `tools/unshitty.ts` (`bun run unshitty`, `unshitty:head`) diffs the live system prompt against its rewritten form; `$DIFF` picks the differ.
- `tools/thinking-replay-probe.ts`, `tools/box-mockup.ts`, `tools/init-config.ts`, `tools/link-pi-packages.ts` one-off probes and setup.

## how it loads

everything ships with the package.
`pi install <rho>` (or `bun run link` for a local checkout) loads the extensions, skills, prompts, and themes.
system prompt fragments live in `system/` and are read by extensions at `before_agent_start`.
see `system/README.md` for the injection order.

## working here

- `bun install` then `bun run typecheck`.
- never edit `rho.toml`.
  it is generated from `extensions/lib/config.ts` by `bun run config`, which is what to run after adding or changing a field.
- `/reload` in a session picks up changes without a restart.
- after editing any markdown here, run `bun tools/reflow.ts --write <files>`.
- when documenting a change, put it in the file's header comment or `docs/extensions.md`, not here.
