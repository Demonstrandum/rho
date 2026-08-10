# rho

this repo is my personal pi dotfiles, structured as a pi package. install it on any
machine and everything below is active when i run pi. no symlinking, no manual setup.

## what's here

- `extensions/` typescript extensions (tools, commands, ui, hooks), auto-discovered
  - `system-prompt.ts` assembles the system prompt from `system/prompt.md` (the master template) using `lib/prompt-loader.ts`. resolves `{{include:...}}` directives, fills `{{WORDS}}`/`{{PATTERNS}}` variables from wordswap exports, caches the result, appends once in `before_agent_start`
  - `lib/prompt-loader.ts` `PromptLoader` class: reads a template, resolves includes, fills variables, caches. used by `system-prompt.ts`
  - `spinner.ts` sets the working indicator and shimmering message, driven by `assets/spinners.json`, `assets/maxims.txt`, and `assets/verbs.txt`; shimmer/glyphs/completion line adapted from pi-claude-shimmer (MIT)
  - `wordswap.ts` + `assets/wordswap.json` rewrite overused tic phrases in finalized assistant messages: the json has `words` (literal phrase -> replacement, matched case-insensitively on word boundaries with the matched text's case carried onto the replacement) and `patterns` (regex with capture groups -> replacement template, e.g. `(\w+)-adjacent` -> `$1-ish-but-not`, for coined compounds); on `message_end` it swaps matches in `text` content blocks (this mutates the stored message, so swaps also land in the transcript and in the model's later context, unlike claude code's display-only `MessageDisplay` hook). also exports swap data and formatters consumed by `system-prompt.ts` for the vocabulary section. inspired by jola's claude code `MessageDisplay` hook (https://jola.dev/posts/how-to-stop-claude-from-saying-load-bearing)
  - `startup.ts` replaces pi's built-in startup block: it persists `quietStartup=true` (idempotent global settings write) to suppress the built-in banner + bracketed `[Prompts]`-style resource listing, then draws a compact bold-inline header via `setHeader` (logo line + one line each for `prompts`/`skills`/`commands`/`themes`). resource data comes from `pi.getCommands()` (split by `source`) and `ctx.ui.getAllThemes()`; there is no API to enumerate loaded extension files, so extension-provided slash commands show under `commands` instead of an `Extensions` section
  - `silence-extra-usage-warning.ts` persists `warnings.anthropicExtraUsage=false` once, idempotently, so pi's unconditional "subscription auth ... billed per token" startup notice is suppressed; replaced by the evidence-based `extra-usage-watch.ts`
  - `extra-usage-watch.ts` monitors anthropic's unified rate-limit response headers (`representative-claim`, `overage-utilization`) on `after_provider_response` and warns once per session when requests are routed to extra-usage billing (fingerprinted as third-party or plan window exhausted); replaces the blunt startup warning suppressed by `silence-extra-usage-warning.ts`
  - `lib/settings-store.ts` shared helper (`ensureGlobalSetting`) for the idempotent nested global-settings writes used above; in a subdirectory so extension auto-discovery (top-level `*.ts` only) does not load it as an extension
  - (deleted) `personal-rules.ts`, `writer-rules.ts` replaced by `system-prompt.ts`
  - `auditor.ts` registers `/audit [audience]`, which invokes the `auditor` skill to review the last assistant prose output against the writer rules. modelled on ponytail's command-to-skill pattern (sends `/skill:auditor` via `sendUserMessage`)
  - `assets/` data files consumed by the extensions (`spinners.json`, `maxims.txt`, `verbs.txt`, `wordswap.json`); a subfolder so extension auto-discovery (top-level `*.ts` only) never treats them as extensions
  - `footer.ts` replaces the built-in footer to customise the token arrow glyphs; also flips `clearOnShrink` on live for the current session
  - `clear-on-shrink.ts` persists `terminal.clearOnShrink=true` into the global pi settings so no stale blank row is left behind when the rendered content shrinks (idempotent, written once)
  - `image-width.ts` persists `terminal.imageWidthCells=180` into the global pi settings so inline images (e.g. from `fetch_content`) render wide (idempotent, written once, same helper as `clear-on-shrink`/`silence-extra-usage-warning`)
  - `agentica.ts` ports the Agentica MCP tool from MathisWellmann/nixos-config's `pi-agent.nix`, but off by default. it registers an `agentica` tool (runs python that can call MCP tools via the Agentica MCP Runtime, launched through the helper at `assets/agentica_helper.py`) only when `RHO_AGENTICA_RUNTIME` points at an agentica-mcp-runtime checkout; with the env unset the extension is a no-op. `RHO_AGENTICA_PYTHON` overrides the interpreter (default `<runtime>/.venv/bin/python`). the nix original gated this behind a build flag; rho has no build step so the gate is runtime and explicit
  - `prompt-defingerprint.ts` rewrites the lines of pi's built-in system prompt that anthropic's server-side classifier signatures as third-party (the pi documentation section); requests carrying them are routed to extra-usage billing only, so the rewrite keeps subscription OAuth requests on plan billing. details in `../anthropic-detection-findings.md`
  - `cwd.ts` adds `/cwd [path]` to change the directory the agent operates in, mid-session
  - `context.ts` adds `/context`, a context-window readout in the spirit of Claude Code's `/context`: a chess-tile grid sized to the model's context window, coloured by category, beside a legend of estimated per-category usage (system prompt, tools, memory files, skills, messages) and free space. the total and free space come from the real count via `ctx.getContextUsage()`; the per-category split is estimated locally at pi's chars/4 ratio from `ctx.getSystemPrompt()`, `ctx.getSystemPromptOptions()`, and `pi.getAllTools()`/`pi.getActiveTools()`. it renders via a `registerEntryRenderer` CustomEntry, which draws in the transcript but does not enter the LLM context, so measuring context never pollutes it
  - `web.ts` adds `/web` to run the pi-web UI as a background service and open it in the browser: `/web` installs if needed, (re)starts, health-checks, self-heals the node-pty spawn-helper chmod, registers the current session cwd as a pi-web project, and opens the URL; `/web PORT` rewrites the config port and restarts; `/web stop|restart|status|logs|doctor|version|uninstall` pass through; `/web open` just opens the current URL
- `skills/` on-demand skills (`SKILL.md` folders + top-level `.md`)
- `prompts/` prompt templates, expanded with `/name`
- `themes/` color themes (`.json`)
- `system/` the system prompt, assembled from fragments (see `system/README.md`)
  - `prompt.md` master template; shows the full shape with `{{include:...}}` directives
  - `personal-rules.md` conventions, design, editing, tooling, writing
  - `writer-rules.md` ASD-STE100 derived prose standard (13 rule categories)
  - `vocabulary.md` sub-template for the word/pattern swap list (`{{WORDS}}`, `{{PATTERNS}}`)
- `extensions/assets/spinners.json` spinner definitions keyed by name (each has `category`, `interval`, `frames`); the enabled categories live in `spinner.ts` (`chinese` by default)
- `extensions/assets/maxims.txt` working messages, one per line, `;` comments, picked at random each turn
- `extensions/assets/verbs.txt` completion verbs, one per line, `;` comments, picked at random for the settle line (`完 <verb> for <duration>`)
- `package.json` the `pi` manifest declaring resource paths
- bundled third-party packages (in `dependencies` + `bundledDependencies`, referenced via `node_modules/...` in the `pi` manifest): `pi-web-access`, `@ayulab/pi-rewind`, `context-mode`, `token-rate-pi` (shows average output tokens/sec in the footer status line). they install and load automatically with rho.

## how it loads

everything ships with the package. `pi install <rho>` (or `bun run link` for a local
checkout) loads the extensions, skills, prompts, and themes. system prompt fragments live in `system/` and are read by extensions at
`before_agent_start`. see `system/README.md` for the injection order.

## working here

- `bun install` then `bun run typecheck`.
- `/reload` in a session picks up changes without a restart.
