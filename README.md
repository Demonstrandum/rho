# rho

personal [pi](https://pi.dev) dotfiles, packaged as a pi package (Bun + TypeScript).

bundles my:

- **extensions/**: TypeScript modules that add tools, commands, ui, hooks
  - `personal-rules.ts` appends my coding/writing rules to the system prompt every session
  - `spinner.ts` sets the working indicator and shimmering message from `spinners.json` + `maxims.txt` (chinese spinners by default; shimmer adapted from [pi-claude-shimmer](https://github.com/ouzhenkun/pi-claude-shimmer), MIT)
  - `startup.ts` hides pi's built-in startup block (`quietStartup`) and renders a compact bold-inline header (logo + `prompts`/`skills`/`commands`/`themes` on one line each) via `setHeader`
  - `silence-extra-usage-warning.ts` persists `warnings.anthropicExtraUsage=false` so the subscription-billing notice is not shown every session
  - `footer.ts` replaces the built-in footer to swap the token arrow glyphs
  - `cwd.ts` adds `/cwd [path]` to change the agent's working directory mid-session
  - `web.ts` adds `/web` to launch the [pi-web](https://github.com/jmfederico/pi-web) UI as a background service (and `/web status|stop|logs|...` passthrough)
  - `agentica.ts` adds an `agentica` tool (runs python that can call MCP tools via the Agentica MCP Runtime), ported from [MathisWellmann/nixos-config](https://github.com/MathisWellmann/nixos-config)'s `pi-agent.nix`. off by default: only registers when `RHO_AGENTICA_RUNTIME` points at an agentica-mcp-runtime checkout (`RHO_AGENTICA_PYTHON` overrides the interpreter, default `<runtime>/.venv/bin/python`); with the env unset it is a no-op
- **skills/**: on-demand capability packages (`SKILL.md`)
- **prompts/**: reusable prompt templates (`/name` to expand)
- **themes/**: `plan9` (light) and `plan9-dark`, plan9/acme-inspired
- **bundled packages** (installed automatically with rho, no separate install):
  - [`pi-web-access`](https://github.com/nicobailon/pi-web-access): web fetch/search
  - [`@ayulab/pi-rewind`](https://github.com/ayu-exorcist/oh-my-pi): rewind
  - [`context-mode`](https://github.com/mksglu/context-mode): context mode
  - [`token-rate-pi`](https://www.npmjs.com/package/token-rate-pi): average output tokens/sec in the footer status line

## install

1. install Bun (needed to run pi and rho):

   ```bash
   curl -fsSL https://bun.sh/install | bash
   # or on macOS: brew install oven-sh/bun/bun
   ```

2. install pi:

   ```bash
   bun install -g @earendil-works/pi-coding-agent
   # or: curl -fsSL https://pi.dev/install.sh | sh
   ```

3. install rho straight from git (no local clone needed):

   ```bash
   pi install git:github.com/Demonstrandum/rho
   ```

   this registers the package in `~/.pi/agent/settings.json`. from now on, running
   `pi` anywhere loads rho's extensions, skills, prompts, and rules automatically.

4. select the theme once (persists in settings):

   ```bash
   pi
   /settings   # theme -> plan9 (or plan9-dark)
   ```

### with a local clone

if you want a checkout to hack on, clone it and install from the path instead:

```bash
git clone git@github.com:Demonstrandum/rho ~/rho
pi install ~/rho
```

project-local instead of global (writes to `.pi/settings.json` in the current repo):

```bash
pi install -l ~/rho
```

## develop

```bash
bun install
bun run typecheck
```

`bun run link` installs the working checkout project-locally, `bun run link:global`
installs it globally. `/reload` in a session picks up changes without a restart.
use `pi config` to enable/disable individual resources.

## layout

```
extensions/   *.ts / *.js (auto-discovered)
skills/       SKILL.md folders + top-level *.md
prompts/      *.md
themes/       *.json
```

resource paths are declared in `package.json` under the `pi` key.

spinner and message content live in `extensions/spinners.json` and
`extensions/maxims.txt`. change `ENABLED_CATEGORIES` in `extensions/spinner.ts`
to switch spinner sets.
