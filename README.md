# rho

personal [pi](https://pi.dev) dotfiles, packaged as a pi package (Bun + TypeScript).

## features

- **system prompt**: ASD-STE100 derived prose standard, writing conventions, and vocabulary rules assembled from fragments and injected at startup.
- **word filter**: rewrites overused LLM phrases in finalized messages with absurd substitutes. covers all verb forms. supports random alternatives. bypass with `/noswap`.
- **billing protection**: detects and avoids Anthropic's third-party billing classifier. monitors response headers for extra-usage routing.
- **spinner**: custom working indicator with shimmer animation, random working messages, random completion lines with templated values.
- **startup and UI**: compact startup banner, custom footer, `/context` context-window visualisation.
- **prose audit**: `/audit` sends the last reply to a second model (haiku by default) to be reviewed against the writing rules, outside the conversation. findings render in the transcript; sending a correction back to the agent is offered, never automatic, with the option to edit it first.
- **commands**: `/audit` (prose review against the writing rules), `/cwd` (change directory mid-session), `/web` (launch pi-web UI).
- **settings**: auto-configures terminal and display preferences on first run.
- **bundled packages**: web browsing and librarian (pi-web-access), session rewind (pi-rewind), FTS5 knowledge base (context-mode), output speed display (token-rate-pi).
- **themes**: plan9 and plan9-dark.

## contents

bundles my:

- **extensions/**: TypeScript modules that add tools, commands, ui, hooks
  - `personal-rules.ts` appends my coding/writing rules to the system prompt every session
  - `spinner.ts` sets the working indicator and shimmering message from `spinners.json` + `maxims.txt` (chinese spinners by default; shimmer adapted from [pi-claude-shimmer](https://github.com/ouzhenkun/pi-claude-shimmer), MIT)
  - `startup.ts` hides pi's built-in startup block (`quietStartup`) and renders a compact bold-inline header (logo + `prompts`/`skills`/`commands`/`themes` on one line each) via `setHeader`
  - `silence-extra-usage-warning.ts` persists `warnings.anthropicExtraUsage=false` so the subscription-billing notice is not shown every session
  - `footer.ts` replaces the built-in footer to swap the token arrow glyphs
  - `auditor.ts` + `lib/audit.ts` add `/audit`, which reviews the last assistant reply against the writer rules with a separate model, through one forced-tool call to `ctx.modelRegistry.complete`; configured under `[audit]` in `rho.toml` (`model`, `feedback`, `timeout-ms`, `audience`)
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

rho needs bun 1.2.0 or newer and pi 0.84.0 or newer. an older bun fails partway
through the install with an error that names the wrong file, so the install
checks the version first and says what to upgrade. run `bun run doctor` at any
time for the same report.

1. install Bun (needed to run pi and rho):

   ```bash
   curl -fsSL https://bun.sh/install | bash
   # or on macOS: brew install oven-sh/bun/bun
   # already installed, but old: bun upgrade
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
bun test tests/
bun run doctor      # bun / node / pi versions and the pi package link
bun run smoke       # start pi against a mock model and check it does not crash
```

`bun run smoke` is the end-to-end check: it serves a local OpenAI-compatible
model (`ci/mock-provider.ts`), then runs pi with this checkout as a package in a
temporary config directory, once headless and once on a pseudo-terminal. it
verifies that every extension loads, the system prompt is assembled and sent,
the wordswap hook rewrites a finalized reply, a tool call completes, the startup
header renders, and pi exits cleanly. no API key and no network are used, and
nothing outside the temporary directory is read or written.

`bun run smoke:docker` runs the same checks in a clean container
(`ci/Dockerfile`), which is what `.github/workflows/ci.yml` does on every push
and once a day, so a pi release that breaks rho shows up there first.

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
