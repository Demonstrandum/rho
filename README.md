# rho

My personal [pi](https://pi.dev) dotfiles, packaged as a pi package (bun + TypeScript).

Bundles my:

- **extensions/**: TypeScript modules that add tools, commands, UI, hooks
- **skills/**: on-demand capability packages (`SKILL.md`)
- **prompts/**: reusable prompt templates (`/name` to expand)
- **themes/**: color themes

## Install

Project-local (this repo, for team sharing):

```bash
bun run link          # pi install -l $(pwd)
```

Global (all projects):

```bash
bun run link:global   # pi install $(pwd)
```

Or install from git once pushed:

```bash
pi install git:github.com/<user>/rho
```

## Develop

```bash
bun install
bun run typecheck
```

Enable/disable individual resources with `pi config`. Reload without restart via
`/reload` in an interactive session.

## Layout

```
extensions/   *.ts / *.js (auto-discovered)
skills/       SKILL.md folders + top-level *.md
prompts/      *.md
themes/       *.json
```

Resource paths are declared in `package.json` under the `pi` key.
