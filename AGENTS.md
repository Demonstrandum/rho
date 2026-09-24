# rho

this repo is my personal pi dotfiles, structured as a pi package.
install it on any machine and everything below is active when i run pi.
no symlinking, no manual setup.

this file is loaded into the system prompt of every session in every project, so its length is paid for on every request.
keep it an index: one line per file, naming what the file does and the `rho.toml` section that configures it.
reasoning, mechanism, and the traps behind a design go in `docs/extensions.md` or in the header comment of the file itself, both of which are read only when someone opens them.
if an entry here is growing past two lines, that is the signal to move it.

## what's here

- `extensions/` typescript extensions (tools, commands, ui, hooks), auto-discovered from top-level `*.ts` and from `<name>/index.ts` one level down, which is how an extension with private modules of its own is a directory.
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
  - `prompt-inspect/` `/prompt` browses the provider payloads and the system prompt, and dumps either to disk; `log.ts` the bounded payload log, `outline.ts` the payload as a tree, `pager.ts` the scrolling view.
  - `sample-session.ts` `pi --sample-session` and `/sample-session` open a made-up session: tool calls, thinking, branches, every entry kind.
  - `session-tree/` patches `/tree` (and esc esc, and shift+ctrl+t) into an edit surface: select a span, delete, summarise, prune or rewrite it, commit as a copy; `/session-copy`, `/session-backup`.
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
  - `slack/` `/slack <app>` puts a Slack DM in front of this session: socket in-session, read mark, typing status, `[slack]`; `index.ts` the session side, `api.ts` the Web calls and the socket, `config.ts` the app store and lock, `row.ts` the tool rows.
  - `context.ts` `/context` context-window readout.
  - `syntax.ts` `/syntax [name]` sets the colours code is drawn in, over any theme; `/syntax none` restores the theme's own, `[syntax]`
  - `theme.ts` `/theme [name]` previews each theme as the completion menu passes over it; `/theme-picker` picks one against a sample session, `[theme]`
  - `web.ts` `/web` runs the pi-web UI as a background service.
  - `colab.ts` `/colab <notebook.py>` and the `marimo_*` tools: the agent and the person in one live marimo kernel; headless sessions, cell edits through the kernel, lint, export, convert, `[colab]`
  - `rho.ts` `/rho config` shows and writes the live `rho.toml`
  - `update.ts` `/update [pi|rho]` updates pi, the packages, and an rho checkout, then reloads the session.
  - `agentica.ts` an `agentica` MCP tool, registered only when `RHO_AGENTICA_RUNTIME` is set.
  - `lib/` shared modules, in a subdirectory so auto-discovery does not load them, one directory per concern.
    a module lives with the extension that owns it while one extension imports it, and moves here when a second one wants it.
    - `core/` `config.ts` (`rho.toml`), `state-store.ts` (on-disk extension state, scoped global/project/session), `settings-store.ts` (idempotent settings writes), `keybindings-store.ts`, `rho-root.ts` (rho's own directory, found rather than counted), `bun-launcher.ts` (locate and repair pi's launcher shebang), `text.ts` (the string primitives: escapes, fitting, plurals, counts, durations, names), `template.ts`, `source-str.ts`, `shorthand.ts`, `utils.ts`
    - `tui/` `picker.ts` (a list that stays on screen while an action runs), `choice.ts` (a short list of named outcomes, picked by arrow or by first letter), `side-by-side.ts` (a list beside what it is choosing between), `preview-hold.ts` (put back what a preview replaced), `autocomplete-focus.ts` (which completion item is under the cursor), `complete-words.ts`, `colour-spec.ts` (a configured colour against the live theme), `box-edges.ts` (blank edges of a rendered block, and what an image reserves), `leave-terminal.ts` (ending this process with the terminal put back), `waiting.ts`
    - `chrome/` `intro-card.ts` (one playing of the wordmark intro), `startup-header.ts` (the block a session opens with), `footer-mirror.ts` (the footer as last drawn), `working-status.ts` (which surface the working indicator is drawn on), `widget-spinner.ts` (the wait shown for an out-of-turn model call), `command-usage.ts` (what each slash command takes), `command-hint.ts` (where that form goes in the row, and what colour each character is), `syntax-palette.ts` (the code colours, laid over any theme), `theme-sample.ts` (a sample session drawn by pi's own components), `pi-logo.ts`, `tetris-logo.ts`
    - `session/` `sample-session.ts` (the made-up session, entry by entry), `session-file.ts` (a whole tree written to a new session file), `stash.ts`, `prompt-history.ts`, `scratchpad.ts`, `steering-mirror.ts`, `checkpoint-breaker.ts`
    - `files/` `file-store.ts` (one machine's files: stat, digest, copy, trash), `acting-file.ts` (which machine a tool's path argument names), `undo-journal.ts` (one record per file mutation, and putting one back).
    - `git/` `run-git.ts`, `git-snapshot.ts`, `where-note.ts`
    - `prose/` `disenshittification.ts` (the house-style rewrite), `reflow.ts` (one sentence per line), `prompt-loader.ts`, `personality.ts`
    - `model/` `goal.ts` (the goal judge and its transcript rendering), `audit.ts`, `billing.ts` (which pool anthropic billed a response to, and what extra usage has cost), `pi-docs.ts`
    - `tool-row/` `title.ts`, `preview.ts`, `exec.ts`, `theme.ts`, `notes.ts`
    - `remote/` the machines, the broker, and the session that runs on another one; imported by `remote.ts`, `environment.ts`, `detach.ts`, `project.ts`, `remote-ui.ts`
    - `colab/` `client.ts` the marimo http api, `session.ts` a notebook's kernel session and its live feed, `mirror.ts` the notebook as seen from that feed, `server.ts` finding and starting servers, `marimo-cli.ts` which marimo to run, `helper.ts` the python side, `format.ts` how cells are described to the model, `project.ts` a project's own layer over marimo.
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
- `extensions/assets/colab_helper.py` the python run in a notebook's scratchpad by the `marimo_*` tools: cells, variables, edits, ui values, as json.
- `extensions/assets/syntax.json` syntax palettes for `/syntax`, keyed by name (`origin`, `colors` by role).
- `extensions/assets/spinners.json` spinner definitions keyed by name (`category`, `interval`, `frames`); enabled categories live in `spinner.ts` (`chinese` by default).
- `extensions/assets/maxims.txt` working messages, one per line, `;` comments, picked at random each turn.
- `extensions/assets/verbs.txt` completion verbs, one per line, `;` comments, picked at random for the settle line (`完 <verb> for <duration>`)
- `rho.toml` generated output, never hand-edited: the schema in `extensions/lib/config.ts` printed with its docs.
  change the schema, then run `bun run config`; `tests/config.test.ts` fails while the two disagree.
- `package.json` the `pi` manifest declaring resource paths.
- `.npmrc` turns off npm peer resolution for the install `pi install` runs; pi's own packages are symlinked from the installed pi by `tools/link-pi-packages.ts`, never fetched.
- bundled third-party packages (in `dependencies` + `bundledDependencies`, referenced via `node_modules/...` in the `pi` manifest): `pi-web-access`, `@ayulab/pi-rewind`, `context-mode`, `token-rate-pi` (shows average output tokens/sec in the footer status line), `pi-subagents` (subagent delegation; also contributes its own skills and prompts).
  they install and load automatically with rho.

## ci and tooling

one line each; the detail is in `docs/extensions.md`.

- `ci/mock-provider.ts` a local openai-completions server standing in for a model, scripted by turn.
- `ci/smoke.ts` (`bun run smoke`) end-to-end check in a temporary tree: no api key, no network, nothing written outside it.
- `ci/install-check.ts` (`bun run install:check`) runs `npm install --omit=dev` on a tree with no `node_modules`, which is what `pi install` does and what the smoke test cannot see.
- `ci/Dockerfile` (`bun run smoke:docker`) node 24 slim plus bun, rho installed as a user package so the install path is covered.
- `.github/workflows/ci.yml` `checks` (typecheck + `bun test`), `install` (`ci/install-check.ts`), and `smoke`, on push, pull request, dispatch, and daily.
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
