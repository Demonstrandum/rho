# rho

personal [pi](https://pi.dev) dotfiles, packaged as a pi package (Bun + TypeScript).

bundles my:

- **extensions/**: TypeScript modules that add tools, commands, ui, hooks
- **skills/**: on-demand capability packages (`SKILL.md`)
- **prompts/**: reusable prompt templates (`/name` to expand)
- **themes/**: color themes

## install

project-local (this repo, for team sharing):

```bash
bun run link          # pi install -l $(pwd)
```

global (all projects):

```bash
bun run link:global   # pi install $(pwd)
```

or install from git once pushed:

```bash
pi install git:github.com/<user>/rho
```

## develop

```bash
bun install
bun run typecheck
```

enable/disable individual resources with `pi config`. reload without restart via
`/reload` in an interactive session.

## layout

```
extensions/   *.ts / *.js (auto-discovered)
skills/       SKILL.md folders + top-level *.md
prompts/      *.md
themes/       *.json
```

resource paths are declared in `package.json` under the `pi` key.
