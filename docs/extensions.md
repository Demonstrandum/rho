# extensions

why each extension is built the way it is.
moved out of `AGENTS.md` so it is read on demand rather than loaded into every prompt.
where an entry here duplicates the header comment of its file, the file is the source of truth.

## system prompt

`system-prompt.ts` assembles the system prompt from `system/prompt.md` (the master template) using `lib/prompt-loader.ts`.
resolves `{{include:...}}` directives, fills `{{WORDS}}`/`{{PATTERNS}}` variables from wordswap exports, caches the result, appends once in `before_agent_start`.

`lib/prompt-loader.ts` `PromptLoader` class: reads a template, resolves includes, fills variables, caches.

`env-block.ts` appends an `<env>` block stating the working directory, whether it is a git work tree, the platform and its release, the date, and the active model with its thinking level.
pi gives the working directory and then says the agent can inspect `PI_*` environment variables for the rest, which is a shell call for something a line of text can carry.
the date is the one that matters most: with no date in the prompt a model reasons from its training cutoff and dates every recent release wrongly.
the block is built once and reused, because it sits in the cached prefix of every request and a byte that changes between turns invalidates the cache from that point on; a session running past midnight would otherwise pay a full re-read for a date nobody asked for.
the working directory and the model can change mid-session (`/cwd`, `ctrl+l`), and those do rebuild it, since one cache miss is cheaper than a prompt that names the wrong model.
every line is switchable from `[env]`.

`git-snapshot.ts` + `lib/git-snapshot.ts` append a `<git>` block: the branch and its divergence from upstream, the dirty files, and the last few commit subjects.
without it a session opens with the agent running `git status` and `git log` by hand to learn what it is standing in, and an agent that skips those edits from a wrong picture of the tree.
the read starts at `session_start` and is awaited at the first turn: `git status` on a large work tree is not instant and `session_start` is awaited during startup, so blocking there delays the first paint, while by the time a prompt has been typed the read has finished.
a read that has not finished is dropped rather than waited on, and so is a directory that is not a work tree.
the dirty list is capped by `[git] max-files` and what is dropped is reported as a count, because a truncated list read as complete asserts a cleanliness that is not there.
the block states that it does not update, which is the part that matters on a resume: the read runs again for every session, so the text is at worst one session old, and the agent is told to look again before acting on it.
`lib/git-snapshot.ts` holds the parsing and the rendering, so both are testable without a repository.

`scratchpad.ts` + `lib/scratchpad.ts` give the session one directory for intermediate files, name it in a `<scratch>` block, and export it as `RHO_SCRATCH` so a bash call reaches it without the path being retyped.
the alternative is what happened before it: temporary work goes to `/tmp`, mixed with every other process's files, surviving the session, and refused by any tool confined to the workspace.
context-mode rejects a read outside the project root, so a `/tmp` file written by bash cannot then be summarised by `ctx_execute_file`.
that refusal decides the default location: `.rho/scratch/<session>/` inside the working tree is readable by every tool and needs one `.gitignore` line.
`[scratch] location = data-dir` moves it under the rho data directory for a working tree that must stay untouched, and `off` registers nothing.
a session id keeps two concurrent sessions in one project apart, and an in-memory session shares one directory, which is the choice `lib/state-store.ts` makes for the same case.
directories untouched for `[scratch] keep-days` are removed when a session opens.
a working tree that cannot be written to yields no scratch directory rather than a failed session.

`prompt-defingerprint.ts` rewrites the lines of pi's built-in system prompt that anthropic's server-side classifier signatures as third-party (the pi documentation section); requests carrying them are routed to extra-usage billing only, so the rewrite keeps subscription OAuth requests on plan billing.
details in `../anthropic-detection-findings.md`.
its patterns ignore case and its replacements are written in the house style, so it holds whichever side of `prompt-disenshittify.ts` it runs on.

`prompt-disenshittify.ts` rewrites the assembled system prompt into the house style on `before_agent_start`, through `lib/disenshittification.ts`.
the text it changes is pi's own head and the tool snippets the bundled packages contribute: an em dash between clauses becomes the mark the sentence needs, characters and spacing follow `../system/orthography.md`, a sentence-initial capital falls, and a list item is punctuated `x; y; z.`
every markdown file in rho is a fixed point of the transform, which `../tests/disenshittification.test.ts` asserts over the whole repository, so nothing written here is touched.

three properties make that safe to run over a prompt.
protected spans first: fenced and inline code, urls, absolute and relative paths, bare filenames, `{{template}}` directives, and xml tags are masked before any substitution and restored after, since o6 says the bytes inside them are what a parser reads.
a path is a name on disk, so its case is not the writer's to choose, and `<location>/Users/Sam/...` survives intact.
line structure second: reflow does not cross a tag, so an `<env>` listing or a multi-line skill `<description>` keeps the breaks its writer set, and a list item arriving on one line leaves on one line.
idempotence third: every transform and the pipeline satisfy `f(f(x)) = f(x)`, which the tests hold, because the rewrite runs on every session start and the same text also reaches a human through `bun run unshitty`.

case is the one rule that cannot be made complete.
only a sentence-initial capital falls, because a capital inside a sentence is a name, an acronym, or deliberate, and no list distinguishes them: `Erdős` and every product released next year would need an entry.
names spelled `Like This` at a sentence start are kept by a small list in the module, and a word with an internal capital or one written in capitals throughout is a name by its shape and needs no entry.

`[prompt] disenshittify = false` turns the rewrite off.
`RHO_DISENSHITTIFY_OFF=1` disables it for one process, which is how `../tools/unshitty.ts` captures the prompt as it stands before the rewrite in order to diff it.
the anthropic block (`You are Claude Code, ...`) is never in this text: the transport adds it as a separate system block at request time, and it is what keeps an oauth request on plan billing.

`skill-listing.ts` undoes the xml escaping pi applies to every skill name, description, and path before putting them in the `<available_skills>` block (`formatSkillsForPrompt` in `dist/core/skills.js`).
nothing parses that block as xml: the tags group the listing and the model reads the text, so a description reading `Triggers: "analyze logs"` arrives as `&quot;analyze logs&quot;` and the model is shown a spelling of the trigger word that is not the trigger word.
`&quot;`, `&apos;`, `&#39;`, and `&amp;` are undone on `before_agent_start`, ampersand last so an escaped entity survives as an entity; `&lt;` and `&gt;` are left alone, since an unescaped angle bracket in a description would look like a tag boundary.
88 entities in this checkout, 440 characters.
the indentation goes with them.
pi indents `<skill>` by two spaces and its children by four, but a description carrying its own newlines puts every line after the first at column zero, so the listing is ragged rather than nested, and most skill descriptions are written that way.
the tags already show the nesting, so the leading spaces are dropped and each description is trimmed, which also brings `</description>` back onto the last line of its text instead of a line of its own: another 169 characters here.

## writing

`wordswap.ts` + `assets/wordswap.json` rewrite overused tic phrases in finalized assistant messages: the json has `words` (literal phrase -> replacement, matched case-insensitively on word boundaries with the matched text's case carried onto the replacement) and `patterns` (regex with capture groups -> replacement template, e.g. `(\w+)-adjacent` -> `$1-ish-but-not`, for coined compounds); on `message_end` it swaps matches in `text` content blocks (this mutates the stored message, so swaps also land in the transcript and in the model's later context, unlike claude code's display-only `MessageDisplay` hook).
`/noswap` writes what it set into session-scoped state (`[wordswap] remember-toggle`, on by default), so a resume comes back with the filter as it was left instead of back at `[wordswap] enabled`.
the swap is the only thing written into the message, and it is written as plain text: styling (red background on a swapped span, dim on the `/noswap` marker) is applied at render through `pi.registerMarkdownTransformer`, which pi runs on the markdown before rendering and never stores.
an escape written into message text does not survive the round trip into the model's context, where the ESC byte is dropped and its printable tail is read as characters and copied forward, so `stripAnsi` also cleans escapes and their orphaned tails out of every text block on the way through.
also exports swap data and formatters consumed by `system-prompt.ts` for the vocabulary section.
inspired by jola's claude code `MessageDisplay` hook (https://jola.dev/posts/how-to-stop-claude-from-saying-load-bearing).

`auditor.ts` + `lib/audit.ts` review assistant prose against the writer rules with a second model, outside the conversation, so the model that wrote the text is not the one grading it.
`lib/audit.ts` makes one constrained call through `ctx.modelRegistry.complete` (which resolves auth, headers, and baseUrl itself): system prompt is `system/writer-rules.md` plus the `auditor` skill body plus the configured audience, one user message holds the text, and a single forced `report_findings` tool returns `{location, token, rule, prerequisite, repair}` per violation, so the verdict is structured rather than prose.
`auditor.ts` registers `/audit`, which reviews the last assistant message on the branch that carries prose.
on demand only: there is no per-message hook, because a call on every reply would put a report beside every message and a correction into the history of every turn (a haiku call takes about 8 seconds and costs about $0.013 on a few hundred words; a footer status shows which model is running while it does).
findings render to a `custom` entry in the transcript, per `[audit] feedback` (`transcript` or `both`; `context` shows nothing).
nothing reaches the agent unattended: with `context` or `both`, a nonzero result offers a select dialog (send as-is, edit first in `ctx.ui.editor`, or discard), and only on send does a `custom_message` go in as feedback for the agent's next reply.
the finalized message is never replaced: pi's `message_end` fires before persistence, so a replacement would erase the original instead of branching it, and `ctx.sessionManager` is documented read-only.
mechanism borrowed from everettmorgan's `pi-agent-review`, not from ponytail, whose `/ponytail-review` sends `/skill:...` back into the same session.

## input and editing

`stash.ts` parks prompts: `ctrl+s` pushes the editor text onto a stack (blank text is ignored) and clears the editor, `ctrl+r` pops, a second `ctrl+s` within 500ms (or `/stash`) opens a `SelectList` picker over the whole stack, `/stash clear` drops everything, `/stash undo` puts it back.
in the picker: up/down move, enter takes, `d` deletes the highlighted entry, `ctrl+c` clears the stack (no confirmation; the cleared view offers `u` to undo, closes itself after 600ms, and then names `/stash undo`), `u` undoes the last delete or clear, esc cancels.
one level of undo is kept, and it is retired by any push, pop, or take, so an undo can never restore a stack the user has since changed.
picker keys are compared with `matchesKey`, not raw bytes, because ctrl+c arrives as a CSI-u sequence under the kitty keyboard protocol.
`ctrl+s` and `ctrl+r` are also built-in keys for picker-only actions (`app.models.save`, `app.session.toggleSort`, `app.session.rename`), and pi reports every shared key at startup even under `quietStartup`; on `session_start` the extension reads the resolved bindings (`getKeybindings().getResolvedBindings()`, via `lib/keybindings-store.ts`), finds every action holding a claimed key, and moves each to the next key of the `[stash] demote-to` pool in `rho.toml` (`f2`..`f6` by default) that nothing else uses.
it never writes over an id already in `keybindings.json`, it runs at `session_start` because pi installs the keybindings manager during startup, and an empty pool skips the move and keeps the report.
every binding is ctrl+letter because an alt binding never arrives on macOS unless the terminal sends option as meta.
the pop key cycles: the first press parks whatever is in the editor and shows the newest entry, each further press with the text untouched shows the next entry rather than parking another copy, and the cycle returns to the text it started from.
`lib/stash.ts` holds the state machine: a cycle keeps a snapshot of the stack taken when it began and recomputes the stack from that snapshot at every step, so repeated pops never reorder or duplicate entries.
an edit to the editor text ends the cycle (detected by comparing against the text the last pop wrote), as does sending the message, since the editor is then empty.
the stack is on disk through `lib/state-store.ts`, so it survives an exit, a resume, and a crash: `[stash] persist` in `rho.toml` keys it to the working directory (`project`, the default), the session (`session`), everything (`global`), or nothing (`off`).
`Stash` takes the restored state and an `onChange` callback in its constructor and routes every change to the stack through one private method, so no mutation can skip the write; the state holds the entries and the id counter, and a counter stored behind its stack is raised past the highest id on parse so a restored stash cannot hand out an id the picker is already keyed on.
the cycle and the undo are not stored, since both refer to an editor the next process does not have.
the store is opened at `session_start`, where the cwd and the session id are available; the footer status shows `stash N` plus the cycle position.

`send-now.ts` cuts into a running turn.
pi's two ways in while the agent works both wait: enter queues a steering message for the end of the current assistant turn's tool calls, alt+enter queues a follow-up for the end of all work, and escape stops the run while keeping the editor text (`restoreQueuedMessagesToEditor`), so escape then enter is already the impatient path.
`ctrl+enter` is that pair in one press.
`ctx.abort()` in a shortcut context is escape itself (interactive-mode binds it to `restoreQueuedMessagesToEditor({ abort: true })`), so it writes the queued messages into the editor ahead of the typed text and clears pi's queue; the handler therefore reads the editor after the abort and sends queue-then-typed as one turn, with no way to deliver an entry twice.
`ctrl+shift+enter` sends the newest queued message alone and puts the rest back in the editor; that one needs the entry text, and `ExtensionContext` exposes only `hasPendingMessages()`, so `lib/steering-mirror.ts` rebuilds the queue from the three events that change it: an `input` event with `streamingBehavior` `'steer'` (pi pushed), a user `message_start` whose text matches an entry (pi delivered, and splices by text match), and `hasPendingMessages()` false (pi cleared both queues, which escape and alt+up do together).
a stopped run does not settle synchronously and an extension cannot await it (`waitForIdle` is on the command context), so polling `ctx.isIdle()` in the handler read a stop that had not happened and reported a false timeout; the send is armed instead and delivered from `agent_settled`.
while it is armed the footer carries the elapsed wait and a widget line names the held text, in `warning` colour once `[send-now] stall-warn-ms` passes, so a run that will not stop is distinguishable from a run that is working; pressing either key again puts the held text back in the editor.
`[send-now] log` appends a timestamped line per key press, agent event, and send to `<data dir>/rho/send-now.log`, for locating where a run that will not stop is stuck.
keys come from `[send-now]` in `rho.toml`; `ctrl+enter` and `ctrl+shift+enter` carry no built-in binding, so nothing is demoted, but a terminal without the kitty keyboard protocol sends a bare CR for all three of enter, ctrl+enter, and ctrl+shift+enter.

`prompt-history.ts` + `lib/prompt-history.ts` persistent prompt history that survives across sessions.
patches `Editor.prototype.submitValue` to capture sent prompts and `Editor.prototype.navigateHistory` to capture unsent drafts before they are overwritten.
on first arrow-key use, stored entries are appended to pi's own history array, so they become reachable through standard navigation.
`/history` opens a picker over the full log with delete support.
the log is stored via `lib/state-store.ts` and scoped by `[history] persist` in `rho.toml` (`project` default, like stash).
`[history] max-entries` caps the log (default 500), `[history] save-drafts` toggles draft capture (default true), `[history] debounce-ms` controls how often the in-progress draft is snapshotted while typing (default 750ms).
`lib/prompt-history.ts` is the testable state machine: append-only log with deduplication, capping, and search.
`tests/prompt-history.test.ts` pins the Editor prototype method names, so a pi-tui rename fails the test rather than silently capturing nothing.

`input-field.ts` patches `CustomEditor.prototype.render` to style the input field: half-block edge characters (▄/▀) replace the thin ─ borders, content rows get a dark background derived from `userMessageBg`, and the edge rows can carry a horizontal gradient.
all three behaviours are independently switched from `[input]` in `rho.toml`.
colours are sampled live from `borderColor` (tracks bash mode, thinking levels) and the theme's `userMessageBg`, so they follow theme and mode changes with no state tracking.
falls back to pi's rows untouched in 256-colour mode.

`cwd.ts` adds `/cwd [path]` to change the directory the agent operates in, mid-session.
the target is stored per session (`lib/state-store.ts`, `[cwd] remember`, on by default), so a resume chdirs back and re-registers the tools against it; a stored directory that no longer exists is dropped without a message and the session keeps the directory pi started it in.

## rendering

`spinner.ts` sets the working indicator and shimmering message, driven by `assets/spinners.json`, `assets/maxims.txt`, and `assets/verbs.txt`; shimmer, glyphs, and completion line adapted from pi-claude-shimmer (MIT).

`startup.ts` replaces pi's built-in startup block: it persists `quietStartup=true` (idempotent global settings write) to suppress the built-in banner and the bracketed `[Prompts]`-style resource listing, then draws a compact bold-inline header via `setHeader` (logo line plus one line each for `prompts`, `skills`, `commands`, `themes`).
resource data comes from `pi.getCommands()` (split by `source`) and `ctx.ui.getAllThemes()`; there is no API to enumerate loaded extension files, so extension-provided slash commands show under `commands` instead of an `Extensions` section.

`footer.ts` replaces the built-in footer to customise the token arrow glyphs; also flips `clearOnShrink` on live for the current session.

`clear-on-shrink.ts` persists `terminal.clearOnShrink=true` into the global pi settings so no stale blank row is left behind when the rendered content shrinks (idempotent, written once).
the flag is required: without it stale rows pile up under the footer.
pi also reacts to it by parking a 2-line `IdleStatus` in the dock, which `halfblock-boxes.ts` skips.

`halfblock-boxes.ts` four independent rendering patches, each switched by a key in `[render]` of `rho.toml`; a patch is only installed when its key is true, so a disabled behaviour costs nothing at render time.
`half-blocks` replaces the blank `paddingY` rows of every `Box` with half-height block characters (`▄` on top, `▀` on the bottom, drawn in the box's own background colour), so a tool bubble costs no blank rows.
`tight-tool-rows` drops the blank lines a tool row wraps itself in.
`tight-after-tool-rows` drops the leading `Spacer(1)` of an assistant message when a tool row is what precedes it (the same blank line is kept after a user bubble, so it is decided by adjacency in `Container.render`).
`hide-idle-status` skips pi's `IdleStatus`, two reserved dock rows, matched on constructor name since pi exports neither the class nor a subpath to it.
every trim skips a block holding an inline image: an image reserves its height as blank rows (after the escape sequence under kitty, before it under iterm2) and the terminal draws over them regardless, so dropping them leaves the transcript shorter than the picture and the input field and footer are drawn on top of it.
matched on the kitty and iterm2 prefixes, since pi-tui's `isImageLine` is not re-exported through the package index; an iterm2 line also has to be recognised before OSC stripping, which would leave it looking blank.

`ctx-exec-preview.ts` + `lib/exec-preview.ts` shorten the tool rows context-mode draws for `ctx_execute`, `ctx_execute_file`, and `ctx_batch_execute`: a highlighted one-line command, a status tag and output digest, and full detail on expand.
gated by `[render] exec-preview`.
`lib/exec-preview.demo.ts` renders the variants without a session.

`image-width.ts` persists `terminal.imageWidthCells` (from `[images] width` in `rho.toml`, default 60) into the global pi settings, so inline images (e.g. from `fetch_content`) have a set width (idempotent, same helper as `silence-extra-usage-warning`).

`image-size.ts` patches `Image.prototype.render` in pi-tui to pass `maxHeightCells`, capped at `[images] max-height-fraction` of the current terminal height (default 0.4; 1 disables the patch).
pi supplies a width only and lets the rows follow the aspect ratio, so a 640x537 png at 60 cells is 26 rows: taller than a 24-row window, and the text after it is then drawn over it.
`maxHeightCells` also shrinks the width to keep the ratio, so one number is enough.
the cap is read from `process.stdout.rows` at render time, so a resize needs no state, and the render cache (keyed on width alone) is dropped whenever the cap changes.
`tests/image-size.test.ts` pins the option name, since a rename in pi-tui would silently disable the cap.

`lib/pi-logo.ts` the pi wordmark intro animation, as pure functions of elapsed time.
`lib/tetris-logo.ts` the tetris intro: four tetrominoes drop onto an 8x9 board, the bottom row fills and clears, and what remains is the pi glyph, ported from pi.dev.

## billing and provider payloads

`silence-extra-usage-warning.ts` persists `warnings.anthropicExtraUsage=false` once, idempotently, so pi's unconditional "subscription auth ... billed per token" startup notice is suppressed; replaced by the evidence-based `extra-usage-watch.ts`.

`extra-usage-watch.ts` monitors anthropic's unified rate-limit response headers (`representative-claim`, `overage-utilization`) on `after_provider_response` and warns once per session when requests are routed to extra-usage billing (fingerprinted as third-party or plan window exhausted).

`merge-thinking-blocks.ts` collapses each run of adjacent `thinking` blocks in the outgoing anthropic payload into one block, holding the concatenated text and the last signature.
a turn whose response held two thinking blocks side by side is replayed by pi as two blocks, and the api rejects that with `messages.N.content.1: thinking or redacted_thinking blocks in the latest assistant message cannot be modified`, which strands the session: every later request repeats the pair.
`tools/thinking-replay-probe.ts` replays a stored turn's blocks against the api in variants (each block alone, both, reordered, signatures swapped, a text block between them, merged, signature emptied or truncated) and is what established that the rule is adjacency rather than block content: either block alone is accepted, both together are not in either order, and both a text block between them and the merged block are.

## session and tooling

`rewind-guard.ts` writes `ayu.checkpoint.enabled` before the session starts, so pi-rewind takes a per-turn checkpoint only where one can finish.
the checkpoint engine snapshots the working directory into a shadow git repo every turn whatever the directory is, so a session started from home runs `git add -A -- .` with `--work-tree=$HOME` and is killed at the engine's own two-minute timeout (`Warning: Checkpoint failed: Command timed out after 120000ms`).
`[rewind] auto-checkpoint` in `rho.toml`: `git` (default) requires a git work tree and excludes the home directory even when it is one, since a dotfiles repo there is the same snapshot; `always` and `never` are fixed.
it writes in the extension factory rather than on `session_start`, because pi-rewind re-reads `~/.pi/agent/settings.json` and `<cwd>/.pi/settings.json` in its own `session_start` handler, and every factory runs before any handler.
a directory the guard admits can still fail every turn: a work tree holding a path this process cannot read fails `git add -A -- .` with `fatal: adding files failed`, and one too large to stage fails through the two-minute timeout, both on every turn for the whole session.
`[rewind] on-failure` (`disable-session`, the default) reports the first failure and stops: `lib/checkpoint-breaker.ts` patches `RepoManager.prototype.stageAll` to throw at once while the breaker is tripped, so no later turn spawns git or waits, and the wrapper `rewind-guard.ts` puts around `ctx.ui.notify` drops the repeated `Checkpoint failed:` notifications.
the class is not exported, so the instance whose prototype is patched comes from `resolveSessionCheckpointStorage` (side-effect free, and the storage directory exists by the time a checkpoint has failed), imported by file path from the chunk pi-rewind's own entry imports, since node keys the module cache on the resolved file url.
that export name is minified; `tests/checkpoint-breaker.test.ts` pins it, because a rename would leave every turn waiting on a checkpoint that cannot succeed.
`keep-trying` restores pi-rewind's behaviour of one attempt and one warning per turn.

`search.ts` adds `/search <words>` and a `pi_search` tool over pi's own commands and documentation.
pi's `/` completion fuzzy-matches command names only (pi-tui's `CombinedAutocompleteProvider` filters with `fuzzyFilter(items, prefix, (item) => item.name)` and attaches the description afterwards, for display), nothing searches the docs, and the agent can reach neither, so `/export` is unreachable from the word "jsonl".
`lib/pi-docs.ts` builds one index over three sources: the built-in commands parsed out of `<pi>/dist/core/slash-commands.js` (that array is not re-exported and the package `exports` map has only `.`, `./rpc-entry`, `./client`, so a deep import does not resolve; a release that moves the file yields zero built-ins and a warning line rather than an exception), the session commands from `pi.getCommands()` (extension commands, prompt templates, skills, with provenance; built-in interactive commands are documented as excluded, which is why the first source exists), and every heading section of `<pi>/README.md` and `<pi>/docs/*.md` plus any path in `[search] doc-roots`.
ranking is term frequency weighted by inverse document frequency, so "session" (in half the records) decides nothing and "machine" (in five) decides everything; a match inside a longer word scores a fifth of a whole-word match, so `gist` returns `/share` rather than every mention of `registerProvider`; a query term that is no substring of a command name still matches it as a subsequence, so `expot` finds `/export`.
results render as a `registerEntryRenderer` CustomEntry, which draws in the transcript without entering the LLM context.
the index is built on first use and held for the session, so `/reload` is what picks up a pi upgrade.

`context.ts` adds `/context`, a context-window readout in the spirit of Claude Code's `/context`: a chess-tile grid sized to the model's context window, coloured by category, beside a legend of estimated per-category usage (system prompt, tools, memory files, skills, messages) and free space.
the total and free space come from the real count via `ctx.getContextUsage()`; the per-category split is estimated locally at pi's chars/4 ratio from `ctx.getSystemPrompt()`, `ctx.getSystemPromptOptions()`, and `pi.getAllTools()`/`pi.getActiveTools()`.
it renders via a `registerEntryRenderer` CustomEntry, which draws in the transcript but does not enter the LLM context, so measuring context never pollutes it.

`web.ts` adds `/web` to run the pi-web UI as a background service and open it in the browser: `/web` installs if needed, restarts, health-checks, self-heals the node-pty spawn-helper chmod, registers the current session cwd as a pi-web project, and opens the URL; `/web PORT` rewrites the config port and restarts; `/web stop|restart|status|logs|doctor|version|uninstall` pass through; `/web open` just opens the current URL.

`agentica.ts` ports the Agentica MCP tool from MathisWellmann/nixos-config's `pi-agent.nix`, but off by default.
it registers an `agentica` tool (runs python that can call MCP tools via the Agentica MCP Runtime, launched through the helper at `assets/agentica_helper.py`) only when `RHO_AGENTICA_RUNTIME` points at an agentica-mcp-runtime checkout; with the env unset the extension is a no-op.
`RHO_AGENTICA_PYTHON` overrides the interpreter (default `<runtime>/.venv/bin/python`).
the nix original gated this behind a build flag; rho has no build step so the gate is runtime and explicit.

`rho.ts` `/rho config` shows the live config as TOML, `/rho config overwrite` writes it to the XDG path, `/rho config write PATH` writes it elsewhere.

## shared libraries

`lib/config.ts` the `rho.toml` loader: every `[section] key` named in these entries resolves through it.

`lib/state-store.ts` `PersistedState<T>`, the store for extension state that used to die with the process (the stash stack, the `/noswap` toggle, the `/cwd` target, the prompt history).
one json file per scope under `<data dir>/rho/state/<scope>/`: `global` (one file), `project` (one file per working directory, named `<basename>-<sha256 prefix>` so two projects sharing a basename stay separate), `session` (one file per session uuid, so a resume finds its own state).
a `StateSpec<T>` carries the file name, the scope, and a `parse` validator, so a file from an older version, a truncated file, or a hand-edited one reads as no state rather than a value of the wrong shape.
writes go to a temp file and a rename, so a kill mid-write leaves the previous file intact.
opening a session-scoped store prunes files of that name not written to for 30 days.
an in-memory session (no uuid) gets no file and every call is a no-op.

`lib/settings-store.ts` shared helper (`ensureGlobalSetting`) for the idempotent nested global-settings writes.
it lives in a subdirectory because extension auto-discovery loads top-level `*.ts` only.

`lib/template.ts` the shared `{{...}}` evaluator.
`lib/source-str.ts` a String subclass carrying source provenance through template interpolation, used by the prompt explorer.
`lib/utils.ts` small helpers moved verbatim out of `startup.ts` and `spinner.ts`.
`lib/keybindings-store.ts` reads and writes pi's resolved keybindings, for the stash demotion.
`lib/steering-mirror.ts` rebuilds pi's steering queue from the events that change it.
`lib/audit.ts`, `lib/stash.ts`, `lib/prompt-history.ts`, `lib/pi-docs.ts`, `lib/checkpoint-breaker.ts`, `lib/prompt-loader.ts` are described with the extensions that use them, above.

## ci and tooling

`ci/mock-provider.ts` a local openai-completions server standing in for a model: it speaks the subset pi uses (streaming `POST /v1/chat/completions`, `GET /v1/models`), scripts its reply by turn (first a `bash` tool call whose arguments are built from the advertised schema, then text), and keeps the system prompt it was sent so the caller can assert on it.
the reply text carries a word from the wordswap list.

`ci/smoke.ts` (`bun run smoke`) the end-to-end check.
it builds a temporary tree and points `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `XDG_CONFIG_HOME`, and `HOME` at it, writes a `settings.json` holding this checkout as a package plus a `models.json` for the mock, and runs pi against it: `--version`, `--list-models`, a headless `-p --mode json` turn, and a session on a pseudo-terminal.
it asserts the tool loop completed, wordswap rewrote the finalized reply, the assembled system prompt was sent, `rho.toml` generation works, the startup header rendered, and pi exited on ctrl+d, and it fails on any crash string in either stream.
the pty comes from `script(1)` (argument order differs between util-linux and BSD) with keystrokes written by a subshell on a timetable, since the TUI must still be running when each arrives; ctrl+d is what exits, ctrl+c only clears the editor.
nothing outside the temporary tree is read or written, and no API key or network is needed.

`ci/Dockerfile` (`bun run smoke:docker`) node 24 slim plus bun, pi installed from npm (`PI_VERSION` build arg), rho installed as a user package at build time so the install path is itself covered, `ci/smoke.ts` as the entrypoint.

`.github/workflows/ci.yml` `checks` (typecheck plus `bun test`) and `smoke` (docker build, then run), on push, pull request, manual dispatch, and a daily schedule, because pi releases often and a break should surface before a session hits it.
`checks` sets up node as well as bun: bundled context-mode depends on better-sqlite3, which has no prebuild for bun's node ABI and falls back to a source build, so `bun install` exits 1 on a machine with bun but no node.

`tools/version-gate.mjs` runs first in `postinstall`.
plain ES2015 JavaScript with no imports and no Bun APIs, so it parses on any runtime and can be the file that reports the runtime version.
it fails with the upgrade command when bun is older than 1.2.0, or when the install ran under node.

`tools/preflight.ts` (`bun run doctor`) checks bun, node, pi, git, and that pi's `@earendil-works` package directory is findable.
`--install` is the postinstall form, where a missing pi is a warning rather than an error, since installing rho before pi is a normal order.

`tools/pi-location.ts` finds pi's install, shared by `preflight.ts` and `link-pi-packages.ts`.
it strips `node_modules/.bin` from `PATH` before asking for pi, because `bun run` prepends it and rho's devDependency copy of pi would answer instead of the installed one, and it walks up from the resolved cli entry to the directory named `@earendil-works` rather than counting `..` steps, since pi's entry path has moved between releases (`dist/cli.js`, `dist/bundle/cli.js`).
both traps had fired: `link-pi-packages.ts` had linked rho's packages to themselves, and a self-referential link resolves to nothing, so every import of `pi-tui` or `pi-coding-agent` failed.
it now refuses to create such a link.

`tools/prompt-explorer.ts` (`bun run prompt`, `prompt:cli`, `prompt:preview`, `prompt:plain`) resolves the same template `system-prompt.ts` does and shows it with per-fragment provenance, or prints it plain.

`tools/prompt-full.ts` (`bun run prompt:full`, `prompt:full:json`) runs pi headlessly with an extension that dumps the provider payload from `before_provider_request` and exits before the request is sent, so the printed prompt is what a real session would send, including pi's own text, `AGENTS.md`, and the skill listing.

`tools/reflow.ts` rewrites markdown to one sentence per line, per `o5` in the orthography rules, and normalises to NFC.
run it after editing any markdown here.
