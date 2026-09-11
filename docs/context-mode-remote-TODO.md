# making context-mode's tools work on an attached environment

the state today: `ctx_execute`, `ctx_execute_file` and `ctx_batch_execute` are refused while `/environment` has a machine attached.
they are an MCP server spawned once on the laptop, so they run here while `bash`, `read`, `write` and `edit` run there, and their output looks authoritative while describing the wrong machine.
blocking is correct for now and is not the end state.

## what was learned by reading their build output

this is all from `node_modules/context-mode/build`, which is compiled output rather than API, and can change under us without notice.

`build/runtime.js` honours the `SHELL` environment variable when the basename matches `bash|sh|zsh|dash|pwsh|powershell|cmd` and the path is a real executable.
a script named `bash` is therefore accepted as their command runner without patching anything.

`build/executor.js` writes the code to a temporary file on the laptop and runs `<runtime> <path>` with `cwd` set to a local sandbox directory.
interpreters for other languages are found with `which`, so only the shell path goes through `SHELL`.

the MCP bridge is spawned once, with `spawn(runtime, [serverScript])` and `runtimeOverride` set in code rather than from the environment.
it cannot be told about a later `/environment connect`.

## three ways to do it, worst to best

**a shim on `SHELL`.** a script named `bash` that reads the current environment from a file `environment.ts` writes, then either execs the real shell or forwards to the executor.
it has to copy the temporary script across and rewrite the working directory, or the far side gets a path that does not exist.
covers shell only.
depends on an allowlist and a temp-file convention in compiled output, neither of which is promised.

**replacing the three tools.** registering `ctx_execute`, `ctx_execute_file` and `ctx_batch_execute` at connect time overrides theirs, because a runtime registration lands after every extension has loaded.
the work is small: write the code to a file on the far side, run the interpreter there, keep the output there, and return a head, a tail and a byte count, which is what the executor already does.
the cost is reimplementing three of someone else's tools, and drifting from them at every release.

**upstream.** ask for a documented way to point the bridge at another runner: a command template, or a hook that receives the command and returns the output.
this is a smaller change to their code than to ours, and it is the only version that does not depend on reading compiled output.

## what stays local either way

`ctx_index`, `ctx_search`, `ctx_fetch_and_index` and the knowledge base.
the index is about the work, not about the machine, and moving it would scatter one project's memory across every node that is ever rented.
output comes back and is indexed here, as it is now.

## the test that decides whether it worked

attach an environment, run a batch, and check that the hostname in the output is the remote one.
then switch to another environment mid-session and run the same batch: the answer has to follow the switch, which is the case the once-spawned bridge fails today.
