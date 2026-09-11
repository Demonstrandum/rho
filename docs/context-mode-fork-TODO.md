# forking context-mode into rho

context-mode is a dependency whose tools run on the laptop.
with an environment attached, `bash`, `read`, `write` and `edit` act on another machine while `ctx_execute` and `ctx_batch_execute` do not, so they are refused there today.
refusing is a stopgap.
the plan is to fork the plugin into rho, rewrite it in rho's own style, and give it the executor as its runner, so one code path decides where a command runs and everything follows an `/environment` switch.

## what is being taken

the tools worth having, in the order they are used:

- `ctx_execute`: code in a named language, only what it prints comes back.
- `ctx_execute_file`: the same with one file's bytes bound to a variable.
- `ctx_batch_execute`: labelled commands, run together, output addressed by.
  label.
- `ctx_index`, `ctx_fetch_and_index`, `ctx_search`: the knowledge base.
- `ctx_stats`: what the session has spent.

`ctx_doctor`, `ctx_upgrade` and `ctx_purge` describe the package's own installation and do not survive the fork: rho is the installation.

## what changes

**the runner.** today their executor writes a temporary file, picks an interpreter with `which`, and spawns it with a local sandbox directory as `cwd`.
in the fork that is one call into `extensions/lib/remote/client.ts`: write the file where the work happens, run the interpreter there, keep the output there, and read back a head, a tail and a byte count.
local is the same path with a connection to this machine, so there is no second implementation to keep honest.

**lazy output.** their tools truncate and say so.
the executor already holds output on the far side and serves ranges, so a 40 MB log is a byte count until something asks for a range of it.
the tools should return that rather than a truncated string.

**the knowledge base.** stays on the laptop, and stays SQLite.
the index is about the work, not about the machine, and one project's memory must not scatter across every node that is ever rented.
output crosses back and is indexed here, which is what already happens.

**the prompt.** their system prompt states a hierarchy and is injected on every request.
in rho it belongs in a skill, loaded when a tool is wanted, like `skills/remote`.

**style.** rho's conventions: one sentence per line in markdown, comments that say why, no compiled output in the tree, tests that drive the real path rather than a mock of it.

## the order to do it in

1. take the executor and the tool definitions, drop the MCP bridge: rho loads.
   extensions directly, so the second process and its lifecycle go away.
2. point the runner at `lib/remote/client.ts`, with a local connection as the.
   default.
3. port the knowledge base as it is, since it works and is not the interesting.
   part.
4. move the prompt into a skill.
5. delete the dependency, and with it `ctx_doctor` and `ctx_upgrade`.

## how it is known to have worked

attach an environment, run a batch, and the hostname in the output is the remote one.
switch environment mid-session, run the same batch, and the answer follows the switch.
detach, run it again, and it is local.
none of those three pass today.
