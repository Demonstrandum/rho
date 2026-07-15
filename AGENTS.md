# rho

this repo is my personal pi dotfiles, structured as a pi package. install it on any
machine and everything below is active when i run pi. no symlinking, no manual setup.

## what's here

- `extensions/` typescript extensions (tools, commands, ui, hooks), auto-discovered
  - `personal-rules.ts` + `personal-rules.md` inject my personal rules into the system prompt on every session
  - `spinner.ts` sets the working indicator and shimmering message, driven by `spinners.json`, `maxims.txt`, and `verbs.txt` (all in `extensions/`); shimmer/glyphs/completion line adapted from pi-claude-shimmer (MIT)
  - `startup.ts` replaces pi's built-in startup block: it persists `quietStartup=true` (idempotent global settings write) to suppress the built-in banner + bracketed `[Prompts]`-style resource listing, then draws a compact bold-inline header via `setHeader` (logo line + one line each for `prompts`/`skills`/`commands`/`themes`). resource data comes from `pi.getCommands()` (split by `source`) and `ctx.ui.getAllThemes()`; there is no API to enumerate loaded extension files, so extension-provided slash commands show under `commands` instead of an `Extensions` section
  - `silence-extra-usage-warning.ts` persists `warnings.anthropicExtraUsage=false` once, idempotently, so pi's "subscription auth ... billed per token" notice is not shown every session
  - `lib/settings-store.ts` shared helper (`ensureGlobalSetting`) for the idempotent nested global-settings writes used above; in a subdirectory so extension auto-discovery (top-level `*.ts` only) does not load it as an extension
  - `footer.ts` replaces the built-in footer to customise the token arrow glyphs; also flips `clearOnShrink` on live for the current session
  - `clear-on-shrink.ts` persists `terminal.clearOnShrink=true` into the global pi settings so no stale blank row is left behind when the rendered content shrinks (idempotent, written once)
  - `cwd.ts` adds `/cwd [path]` to change the directory the agent operates in, mid-session
  - `web.ts` adds `/web` to run the pi-web UI as a background service and open it in the browser: `/web` installs if needed, (re)starts, health-checks, self-heals the node-pty spawn-helper chmod, registers the current session cwd as a pi-web project, and opens the URL; `/web PORT` rewrites the config port and restarts; `/web stop|restart|status|logs|doctor|version|uninstall` pass through; `/web open` just opens the current URL
- `skills/` on-demand skills (`SKILL.md` folders + top-level `.md`)
- `prompts/` prompt templates, expanded with `/name`
- `themes/` color themes (`.json`)
- `extensions/spinners.json` spinner definitions keyed by name (each has `category`, `interval`, `frames`); the enabled categories live in `spinner.ts` (`chinese` by default)
- `extensions/maxims.txt` working messages, one per line, `;` comments, picked at random each turn
- `extensions/verbs.txt` completion verbs, one per line, `;` comments, picked at random for the settle line (`完 <verb> for <duration>`)
- `package.json` the `pi` manifest declaring resource paths
- bundled third-party packages (in `dependencies` + `bundledDependencies`, referenced via `node_modules/...` in the `pi` manifest): `pi-web-access`, `@ayulab/pi-rewind`, `context-mode`. they install and load automatically with rho.

## how it loads

everything ships with the package. `pi install <rho>` (or `bun run link` for a local
checkout) loads the extensions, skills, prompts, and themes. the personal rules are not
a pi context file; they are bundled markdown that `personal-rules.ts` reads and appends
to the system prompt at `before_agent_start`, so they travel with the package.

## working here

- `bun install` then `bun run typecheck`.
- `/reload` in a session picks up changes without a restart.
