# rho

personal [pi](https://pi.dev) dotfiles, packaged as a pi package (Bun + TypeScript).

bundles my:

- **extensions/**: TypeScript modules that add tools, commands, ui, hooks
  - `personal-rules.ts` appends my coding/writing rules to the system prompt every session
  - `spinner.ts` sets the working indicator symbol and text
- **skills/**: on-demand capability packages (`SKILL.md`)
- **prompts/**: reusable prompt templates (`/name` to expand)
- **themes/**: `rho`, a plan9/acme-inspired light theme

## use it by default on a new machine

1. install pi:

   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   # or: curl -fsSL https://pi.dev/install.sh | sh
   ```

2. clone this repo:

   ```bash
   git clone git@github.com:<user>/rho ~/Git/rho
   ```

3. install it globally so every pi session picks it up:

   ```bash
   pi install ~/Git/rho
   ```

   this registers the package in `~/.pi/agent/settings.json`. from now on, running
   `pi` anywhere loads rho's extensions, skills, prompts, and rules automatically.

4. select the theme once (persists in settings):

   ```bash
   pi
   /settings   # theme -> rho
   ```

to install straight from git without a local clone:

```bash
pi install git:github.com/<user>/rho
```

project-local instead of global (writes to `.pi/settings.json` in the current repo):

```bash
pi install -l ~/Git/rho
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
