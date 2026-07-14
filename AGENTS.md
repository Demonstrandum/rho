# rho

this repo is my personal pi dotfiles, structured as a pi package. install it on any
machine and everything below is active when i run pi. no symlinking, no manual setup.

## what's here

- `extensions/` typescript extensions (tools, commands, ui, hooks), auto-discovered
  - `personal-rules.ts` + `personal-rules.md` inject my personal rules into the system prompt on every session
- `skills/` on-demand skills (`SKILL.md` folders + top-level `.md`)
- `prompts/` prompt templates, expanded with `/name`
- `themes/` color themes (`.json`)
- `package.json` the `pi` manifest declaring resource paths

## how it loads

everything ships with the package. `pi install <rho>` (or `bun run link` for a local
checkout) loads the extensions, skills, prompts, and themes. the personal rules are not
a pi context file; they are bundled markdown that `personal-rules.ts` reads and appends
to the system prompt at `before_agent_start`, so they travel with the package.

## working here

- `bun install` then `bun run typecheck`.
- `/reload` in a session picks up changes without a restart.
