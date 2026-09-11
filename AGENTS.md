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
  - `prompt-history.ts` prompt history that survives a restart, `/history`, `[history]`
  - `cwd.ts` `/cwd [path]` changes the agent's working directory mid-session, `[cwd]`
  - `input-field.ts` styles the input field: half-block edges, background, gradient, `[input]`
  - `spinner.ts` working indicator and shimmering message, from `assets/spinners.json`, `maxims.txt`, `verbs.txt`
  - `startup.ts` replaces pi's startup block with a compact header.
  - `footer.ts` replaces the footer to customise the token arrow glyphs.
  - `halfblock-boxes.ts` four render patches (half-block padding, tighter tool rows, no idle status), `[render]`
  - `tool-rows.ts` names every tool row and gives it its subject; the exec rows keep their command preview, `[tools]`
  - `clear-on-shrink.ts` persists `terminal.clearOnShrink=true`
  - `image-width.ts` persists `terminal.imageWidthCells`, `[images] width`
  - `image-size.ts` caps inline image height at a fraction of the terminal, `[images] max-height-fraction`
  - `silence-extra-usage-warning.ts` persists `warnings.anthropicExtraUsage=false`
  - `extra-usage-watch.ts` warns once when response headers show extra-usage billing.
  - `merge-thinking-blocks.ts` merges adjacent thinking blocks in the anthropic payload, which the api rejects.
  - `rewind-guard.ts` gates pi-rewind's per-turn checkpoint to directories where it can finish, `[rewind]`
  - `search.ts` `/search` and a `pi_search` tool over pi's commands and docs, `[search]`
  - `slack.ts` `/slack <app>` puts a Slack DM in front of this session: socket in-session, read mark, typing status, `[slack]`
  - `context.ts` `/context` context-window readout.
  - `theme.ts` `/theme [name]` previews each theme as the completion menu passes over it; `/theme-picker` picks one against a sample session, `[theme]`
  - `web.ts` `/web` runs the pi-web UI as a background service.
  - `rho.ts` `/rho config` shows and writes the live `rho.toml`
  - `agentica.ts` an `agentica` MCP tool, registered only when `RHO_AGENTICA_RUNTIME` is set.
  - `lib/` shared modules, in a subdirectory so auto-discovery does not load them: `config.ts` (`rho.toml`), `bun-launcher.ts` (locate and repair pi's launcher shebang), `state-store.ts` (on-disk extension state, scoped global/project/session), `settings-store.ts` (idempotent settings writes), `prompt-loader.ts`, `goal.ts` (the goal judge and its transcript rendering), `widget-spinner.ts` (the wait shown for an out-of-turn model call), `disenshittification.ts` (the house-style rewrite), `reflow.ts` (one sentence per line), `template.ts`, `source-str.ts`, `utils.ts`, `audit.ts`, `stash.ts`, `prompt-history.ts`, `pi-docs.ts`, `slack-api.ts` (Slack calls and the Socket Mode client), `slack-config.ts` (the app store and the per-app lock), `steering-mirror.ts`, `keybindings-store.ts`, `checkpoint-breaker.ts`, `text.ts` (the string primitives: escapes, fitting, plurals, counts, durations, names), `tool-row/` (`title.ts`, `preview.ts`, `exec.ts`, `theme.ts`, `notes.ts`), `intro-card.ts` (one playing of the wordmark intro), `startup-header.ts` (the block a session opens with), `footer-mirror.ts` (the footer as last drawn), `theme-sample.ts` (a sample session drawn by pi's own components), `autocomplete-focus.ts` (which completion item is under the cursor), `preview-hold.ts` (put back what a preview replaced), `pi-logo.ts`, `tetris-logo.ts`
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
- `extensions/assets/spinners.json` spinner definitions keyed by name (`category`, `interval`, `frames`); enabled categories live in `spinner.ts` (`chinese` by default).
- `extensions/assets/maxims.txt` working messages, one per line, `;` comments, picked at random each turn.
- `extensions/assets/verbs.txt` completion verbs, one per line, `;` comments, picked at random for the settle line (`完 <verb> for <duration>`)
- `package.json` the `pi` manifest declaring resource paths.
- bundled third-party packages (in `dependencies` + `bundledDependencies`, referenced via `node_modules/...` in the `pi` manifest): `pi-web-access`, `@ayulab/pi-rewind`, `context-mode`, `token-rate-pi` (shows average output tokens/sec in the footer status line).
  they install and load automatically with rho.

## ci and tooling

one line each; the detail is in `docs/extensions.md`.

- `ci/mock-provider.ts` a local openai-completions server standing in for a model, scripted by turn.
- `ci/smoke.ts` (`bun run smoke`) end-to-end check in a temporary tree: no api key, no network, nothing written outside it.
- `ci/Dockerfile` (`bun run smoke:docker`) node 24 slim plus bun, rho installed as a user package so the install path is covered.
- `.github/workflows/ci.yml` `checks` (typecheck + `bun test`) and `smoke`, on push, pull request, dispatch, and daily.
- `tools/version-gate.mjs`, `tools/preflight.ts` (`bun run doctor`), `tools/pi-location.ts` install-time checks and pi discovery.
- `tools/bun-shebang.ts` (`bun run bun-shebang`) points pi's launcher at bun; runs from `postinstall`, since `pi update` restores the node shebang.
- `tools/prompt-explorer.ts` (`bun run prompt`, `prompt:cli`, `prompt:preview`, `prompt:plain`) shows the assembled prompt.
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
- `/reload` in a session picks up changes without a restart.
- after editing any markdown here, run `bun tools/reflow.ts --write <files>`.
- when documenting a change, put it in the file's header comment or `docs/extensions.md`, not here.
