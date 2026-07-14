# rho

this repo is my personal pi dotfiles, structured as a pi package. install it on any
machine and everything below is active when i run pi. no symlinking, no manual setup.

## what's here

- `extensions/` typescript extensions (tools, commands, ui, hooks), auto-discovered
  - `personal-rules.ts` + `personal-rules.md` inject my personal rules into the system prompt on every session
  - `spinner.ts` sets the working indicator and shimmering message, driven by `spinners.json` and `maxims.txt` (both in `extensions/`); shimmer/glyphs/completion line adapted from pi-claude-shimmer (MIT)
  - `footer.ts` replaces the built-in footer to customise the token arrow glyphs
  - `cwd.ts` adds `/cwd [path]` to change the directory the agent operates in, mid-session
- `skills/` on-demand skills (`SKILL.md` folders + top-level `.md`)
- `prompts/` prompt templates, expanded with `/name`
- `themes/` color themes (`.json`)
- `extensions/spinners.json` spinner definitions keyed by name (each has `category`, `interval`, `frames`); the enabled categories live in `spinner.ts` (`chinese` by default)
- `extensions/maxims.txt` working messages, one per line, `;` comments, picked at random each turn
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
