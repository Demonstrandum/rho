---
name: marimo
description: work in a marimo notebook (a reactive Python notebook stored as a .py file with @app.cell functions) through the marimo_* tools. use when asked to open, fix, extend, build, lint, convert or pair on a marimo notebook, when a .py file imports marimo and builds marimo.App, or when the person says /colab. covers the graph rules that make marimo reject an edit, the cell conventions, UI elements, SQL cells and how to verify a notebook runs. loads the marimo_open, marimo_cells, marimo_run, marimo_edit, marimo_vars, marimo_ui, marimo_check, marimo_export and marimo_convert tools.
---

reading this file loads the `marimo_*` tools into the session; they are not carried by sessions that never touch a notebook.
a message naming marimo, a notebook, colab or an .ipynb loads them too, as does `/colab` and a `read` of a file that builds `marimo.App`.

# marimo notebooks

a marimo notebook is a Python file.
each cell is a function under `@app.cell`; the names a cell defines are its outputs, the names it reads are its inputs, and marimo builds a dataflow graph from them.
run a cell and every cell that reads what it defined runs after it.
that is the whole model, and the rules below fall out of it.

the tools act on a live kernel, not on the file.
`marimo_open` starts (or joins) a server and creates the kernel session; `marimo_edit` changes cells through the kernel and the kernel writes the file.
editing the .py with `edit` or `write` while it is open is lost when the kernel saves, so do not.
when no kernel is wanted (a quick lint, a conversion), `marimo_check` and `marimo_convert` work on files.

## the order of work

1. `marimo_open path.py`, the cell table comes back: id, status, first line, defs and refs, errors under the cells that have them.
   read it before touching anything: it says which cell owns each name.
2. look before changing: `marimo_cells ids=[...]` for the code and output of the cells in question, `marimo_vars` for what the variables hold, `marimo_run` to try an expression against the live data.
3. change with `marimo_edit`, several ops in one call.
   the result shows the touched cells with their new status, output and errors, and any other cell now erroring.
   fix what it reports before moving on.
4. finish with the table clean: `marimo_cells` with no ids, every status `idle`, no `ERROR` rows.
   a notebook that runs clean in the kernel runs clean as a script.

## the graph rules

marimo refuses an edit that breaks them and says why; nothing in that batch is applied.

- **one owner per public name.** `df = ...` in two cells is `Multiply-defined names`.
  to transform a value, give the result a new name (`clean = df.dropna()`) or edit the owning cell.
  this includes imports: `import pandas as pd` belongs in one cell, and every other cell just uses `pd`.
- **no cycles.** a cell cannot read a name that depends on what it defines.
- **no `import *`.** marimo cannot see what it defines.
- **names starting with `_` are private to their cell.** another cell reading `_df` gets `NameError`.
  use them for scratch inside a cell; use public names for anything another cell needs.
- **the last expression is the cell's output.** `df.head()` on its own line shows the table; `print` goes to the console, not the output.
  a cell that should show something ends with the thing to show.

## conventions that keep a notebook good

- imports in one cell at the top; `import marimo as mo` is always there.
  a cell named `setup` runs before everything and may hold only imports and constants that reference nothing else.
- one idea per cell: load, then transform, then show.
  expensive work upstream of presentation, so a UI change reruns the cheap cell.
- prose in `mo.md("...")` cells, not in comments.
  f-strings in `mo.md` interpolate live values: `mo.md(f"**{n}** rows")`.
- a value read by the person goes in a public name; the graph is the documentation.
- `marimo_check` after structural work: it catches what the kernel tolerates (empty cells, unused names, formatting).

## UI elements

`mo.ui.slider`, `mo.ui.number`, `mo.ui.dropdown`, `mo.ui.multiselect`, `mo.ui.text`, `mo.ui.switch`, `mo.ui.checkbox`, `mo.ui.date`, `mo.ui.table`, `mo.ui.button`, `mo.ui.form`.

- define the element in one cell and **display it there**: the cell's last expression is the element (or `mo.hstack([a, b])`).
- read `.value` **in another cell**.
  the defining cell cannot read its own element's value (it would be a cycle through the UI).
- `marimo_ui element=slider value=8` sets a value as a person would, and the readers rerun.
  a dropdown takes the option as shown; a multiselect a list; a switch a boolean.
- `mo.ui.table(list_of_dicts)` or `mo.ui.table(df)` shows a table; a bare dataframe shows too, without selection.
- `mo.stop(condition, mo.md("waiting..."))` halts a cell until an input is given.

## SQL

`mo.sql(f"SELECT ... FROM df")` queries dataframes in the namespace by name (duckdb under it; needs the `marimo[sql]` extra).
the result is a dataframe; assign it (`top = mo.sql(...)`) to use it downstream.
the f-string is how marimo recognises the cell as SQL in the browser.

## plots

matplotlib: end the cell with the axes or figure (`ax`, or `plt.gca()`); the output arrives as an image and `marimo_cells` attaches it, so you can see what the person sees.
altair: `mo.ui.altair_chart(chart)` makes it selectable; a bare `chart` displays too.
plotly, seaborn, bokeh display the same way: last expression.
a chart with no image form (altair, plotly, a table, a widget) is seen with `marimo_cells ids=[...] screenshot=true`, which renders it in a headless browser; it needs `playwright` and its chromium in the kernel environment (`marimo_edit` install op, then `python -m playwright install chromium` once), and says so when they are missing.
when asked what a chart looks like, look: do not describe it from the code.

## packages

`marimo_edit ops=[{op: "install", packages: ["polars"]}]` installs into the kernel's environment (and into the inline metadata of a sandboxed notebook), with the kernel's own package manager.
combine it with the cell that needs the package in the same batch; packages go first.
some libraries cache what they found at import time; if a fresh install is not seen, say so rather than looping.

## environments

- a notebook with a `# /// script` header (PEP 723) is self-contained: `marimo_open` starts it with `--sandbox`, which builds its environment from that header.
  add dependencies through `ctx.packages.add`, which updates the header.
- a project with `pyproject.toml` naming marimo runs with its `.venv`; `marimo_open` finds it.
- `marimo_open` with no path lists the notebooks here and the servers already running, with what each has open.
  a server the person started (`marimo edit --no-token`) is joined, not duplicated; what you change, they see.
- a server with a token, or one the registry does not know (another machine through `ssh -L`), is opened by url: `marimo_open http://localhost:2718/?access_token=...&file=nb.py`.
- with an environment attached (another machine), the marimo tools still act on this one; say so rather than opening a notebook there by file path.

## when things look wrong

- **stale cells** after joining a session someone left: `marimo_edit ops=[{op: "run", id: "stale"}]`.
- **a cell errors with `NameError` on a name another cell defines**: that cell errored or has not run; look up the table.
- **`Ancestor raised`** is not the cell's own fault: fix the ancestor.
- **an edit is rejected**: the message names the rule; re-read the owning cell's defs, do not add `_` or a new import to sidestep it.
- **outputs missing right after an edit**: the kernel may still be running; `marimo_cells ids=[...]` a moment later shows them.
- **a cell runs long**: the table says `running for 1m 20s` beside it; the kernel is one thread, so nothing else runs until it ends.
  `marimo_run interrupt=true` stops it; then fix the cell and run again.
  a batch whose cells are still running after the configured wait answers early and says so; look again later.
- **the person is in the browser too**: tool results say `meanwhile, edited in the browser: ...` when they changed a cell between your calls.
  read that cell again before editing it.

## converting and creating

- `marimo_convert legacy.ipynb` writes `legacy.py`; Jupyter's reassignments come out renamed (`data_1`, `data_2`), which run but read badly: give them names that say what they are.
- a new notebook: `marimo_open new.py` creates one with an import cell and opens it; build it with `marimo_edit` creates.
- `marimo_export html` renders the notebook with outputs; `script` flattens it to plain Python in run order; `ipynb` for people who need Jupyter.
- `python notebook.py` runs it top to bottom as a script; `marimo run notebook.py` serves it as an app.
