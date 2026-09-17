# Remote sessions and remote environments

three machines, with different lifetimes:

- the laptop, switched off at will, holds nothing.
- dev-box, always up, cheap, holds the agent and its history.
- a rented GPU node, expensive and temporary, holds nothing that must survive it.

the agent runs on the middle one.
the laptop draws it.
the GPU node does the work the agent asks for.
nothing valuable is on a machine that disappears.

## Stage one: the session runs elsewhere

```
/remote create mysesh samuel@dev-box
/remote connect mysesh
```

`create` starts pi as a daemon behind a unix socket on that machine and returns.
`connect` hands this terminal to a client that draws the session with pi's own interface: the rows, the streaming and the rendering are pi's, unmodified, because it is reading what it always reads.
the local session stands aside while the client has the terminal, the same way pi stands aside for an external editor, and comes back when the client exits.

the client draws on the alternate screen, so the session underneath is untouched and comes back exactly as it was left: two conversations scrolled into one another lose both.
leaving the client gives the terminal back and the session carries on.
reattaching draws the conversation as it stands, including tool calls and their output.
ctrl+d leaves.

**One conversation, either machine.** connecting to a session that has never been used hands it this conversation, and leaving it brings back everything said there.
the unit is pi's own session file: a header line naming the session and the directory it works in, then one line per entry, which is all an agent needs to continue.
so carrying the context is copying the file and telling the other side to open it, with no message translation and no partial history; compaction entries and abandoned branches travel because they are entries like any other.

two things change on the way, in `lib/remote/transfer.ts`.
the header names a directory on the machine that wrote it, and pi refuses a session whose cwd does not exist, so the header is rehomed to the directory the receiving session works in.
and the destination may already hold a file of that name from an earlier crossing, so a free name is chosen rather than writing over a file another pi has open, which is what pi's own `/import` does and for the same reason.

the session id is not changed, and that is what makes the whole thing decidable.
two files with one id are one conversation held on two machines, so connect has three cases and needs no state of its own to tell them apart: a session whose id is this one is a continuation, and what was said there comes back on exit; a session with no messages at all is fresh, and is given this conversation before the terminal is handed over; a session with a conversation of its own is somebody's work and is left alone, exactly as before.
a mid-turn session is in the last case too, for the same reason attaching does not restart one.

the far side does the receiving, because it is the side that knows where its own files go: `rho-session adopt <name>` reads a session file on stdin, rehomes it, writes it beside that session's own files and sends pi `switch_session`.
`rho-session carry <name>` is the other direction and prints the file.
`rho-session state <name>` is what connect reads first: the id, the message count, whether a turn is running, and the directory, which only the broker knows.
all three go through the session's socket as ordinary rpc commands, as an origin connection rather than an interface, so asking does not empty the queue of things the agent said while nobody was attached.
`[remote] carry-context` turns it off, and then a remote session is a separate conversation as it was before.

**Wire protocol.** pi already speaks it: rpc mode is jsonl over stdin and stdout, `prompt` and `steer` in, agent events out, with strict lf framing.
so the far side is `pi --mode rpc` and the client is a consumer of that stream.
one thing has to be rebuilt on the way in: the json protocol drops the cumulative assistant message on purpose and sends deltas, and the interface redraws the whole message on every update, so `event-shape.ts` rebuilds it from the deltas rather than asking for a round trip per token.

**The agent's own two tools.** `remote_session` creates and lists; `remote_connect` attaches.
both are described by the `remote` skill and defined only when something asks for them, since neither belongs in the prompt of a session that never leaves this machine.
the gate used to lose the request it was answering: the `input` handler added the tools and the `before_agent_start` handler that hides them at session start ran straight after, so on the first message of a session the one turn that asked for them was the one turn without them.
it now hides only when nothing asked.

the gate reads the person's message, which is the wrong reading on the far side twice over: a session held by a runner is a remote session by construction, and what reaches it is often a carried conversation rather than a request that says the word.
an agent there that knew about `remote_connect` from the conversation it arrived with called it and was told the tool does not exist.
the broker names the session in the environment of the agent it holds, so a session that is itself a remote session keeps both tools without asking.

`remote_connect disconnect` is the other direction, and it exists because the decision that the work is finished is made on the far side while the terminal is on the near one.
it writes a `rho_leave` frame to the session's own socket, the broker hands it to whoever is attached, and the client leaves the way ctrl+d leaves: the agent stays behind its socket, the terminal goes back, and the interface that spawned the client carries the conversation home.
the route is the one origin frames already use, for the same reason: the connection is there, and a session that wants the person back on their own machine has no other way to say so.

`remote_connect` does not hand the terminal over itself.
a tool call runs inside a turn, and drawing another session's interface over a turn still running here is the smaller half of the problem: replacing this session's conversation underneath a streaming agent would mean the file it is appending to stops being the file it is reading.
so the tool records what was asked for and `agent_settled` dispatches `/remote connect <name> <host>`, which is a command handler, is the only thing that can open a different conversation here, and runs with the interface idle.

**Which machine answers.** the client wraps a real local session and replaces only the members that belong to the far side.
the settings, the editor, the theme and the session file are local; the model, the messages, the queue, and every action are the far side's.
a member that cannot be asked at all refuses by name rather than answering about the wrong machine.

**Where a slash command runs.** pi's interface does not dispatch extension commands: it hands the typed line to `session.prompt`, and the session runs the command before deciding the text is for the model.
in a client, `prompt` is a call to the far side, so every command went there: `/theme` changed the colours of a process with no terminal, `/exit` reached the model as a prompt, and `/rewind` ran against the right files with nowhere to draw.
the client now asks the far side what commands it has, at attach and after a reconnect, and routes on the answer.
a command only one side has runs on that side; a command both sides have runs on the far side, which is where the files, the checkpoints and the conversation are, unless it is named in `[remote] commands-here`, which lists the ones this terminal owns.

**The far side's interface, drawn here.** rpc mode has no terminal, so every `ctx.ui` call a far-side extension makes leaves as an `extension_ui_request` frame and is answered with an `extension_ui_response`.
nothing read those frames, so a notification from a remote command went nowhere and a dialog waited on an answer that could never arrive: `/rewind` printed "No checkpoints available" into the void, and with checkpoints it parked the command on a picker nobody could see.
`lib/remote/ui-relay.ts` carries them, `remote-ui.ts` draws them with this interface's own dialogs, and the answer goes back down the link.
the broker holds what it could not deliver: a notification sent while nobody was attached is given to the next client as live, not replayed as history, and a dialog stays open until it is answered, so a command that asked a question before the last client left is answered by the next one.

**What rpc mode cannot do.** `ctx.ui.custom` exists there and resolves undefined, so an extension that offers a component and falls back to a plain dialog takes the component path and is answered with nothing.
that is the whole of why `/rewind` looked like it did nothing.
`remote-ui.ts` takes `custom`, `onTerminalInput` and `setEditorComponent` off the rpc context, which makes those extensions take the fallback the relay can carry.

a session that was already running when this went in keeps the broker it started with, and an older broker tags every frame carrying an id, including an answer, so the far side cannot match it: dialogs there stay unanswered until the session is restarted.
`/remote connect` redeploys and a local one takes `/restart`.

**Typing while it answers.** pi does not stop you: it calls prompt with a streaming behaviour taken from the steering mode, and the session steers or queues on that.
the proxy dropped it, so every message typed mid-turn came back `Agent is already processing`, a refusal a local session never gives.
the behaviour and any images travel with the message.

**What the corner names.** the footer is drawn from the read that follows `setModel`, and the far side is a round trip away, so a chosen model did not appear until something else refreshed the state.
the proxy now holds what was asked for as true at once and lets the far side's own answer correct it, `cycleModel` gives back the model it landed on, and `cycleThinkingLevel` is answered here from the levels the far side reported, since the interface reads it from a keystroke and has nowhere to put a promise.

**Which session the extensions read.** `ctx.model` is not a read of the session the interface holds.
pi binds it once, as a call on the session that owns the extension runner, and that is the local one the proxy wraps, so every extension in a client saw this machine's model rather than the far side's: the footer named a model the session was not running and did not move when `/model` changed it.
the proxy defines `model` and `thinkingLevel` on the local session instance, which redirects the binding pi has already made and holds across an extension reload.

**Which model a new session opens on.** a session on another machine is `pi --mode rpc` with no model named, so pi chose its own default there whatever this machine was set to.
the interface that creates a session hands over the model and thinking level it is on, as `--model provider/id --thinking level`.
a session that is being continued keeps what it was left on: the flags are dropped when the session has a transcript of its own, since otherwise every restart would overrule a `/model` made on the far side.

**Joining a turn already running.** the rows stream, because the interface draws what it is sent.
the extension events do not: an extension told about the end of something it never heard begin measures a turn from nothing, and one told about the middle of a turn and then nothing else never stops: the wait line counted for the rest of the session under an answer already on screen.
a joined turn is passed on in neither direction and the run it belongs to is closed when it ends, so the turn after it is whole.

**Detaching mid-turn.** a turn in flight cannot be handed over: the model call and any command it started belong to the process being left, and the daemon resumes the transcript rather than continuing them.
it used to happen silently, and the session came back with the tool call in the transcript, no output under it, and nothing running.
`/detach` and `/restart` now ask, and end the turn where ending it is written down.

**Which way out.** closing an interface onto a session elsewhere used to mean one thing, that everything said there came back into the local session.
that is the common case and a poor only case: somebody who connected to watch a long run wants the local transcript left as it was, and somebody who is finished for the day wants the shell.
so ctrl+d asks, with a menu of at most three rows, each tagged by the word that also names it on the command line (`/detach carry`, `/detach leave`, `/detach exit`) and answering to that word's first letter.
escape stays, since a question about leaving needs an answer that does not leave.
`[remote] leave-default` says which row the cursor starts on, so the whole interaction is ctrl+d and enter.

the menu is drawn by the client, which is showing the far side, and the carrying is done by the interface that launched it, which is the only process holding a local session to carry into.
one line on stderr joins the two (`lib/remote/leaving.ts`), a stream the launcher already captures to report why a client stopped.
whether carrying is possible at all is something only the launcher knows, so it goes the other way as `RHO_CARRY_BACK` in the client's environment, and a session that was never joined to this one is offered two rows rather than three.
nothing said on stderr means carry: that is what the far side's own `rho_leave` does, and what a client from before the question existed does.

**A refusal is an answer.** pi answers a command it will not run with `success: false` and the reason beside it.
the link settled on that as though it were a result, so every refusal the far side gave resolved a promise nobody read: a prompt refused during compaction left the text gone and the screen unchanged.
the link now rejects with what the far side said, and the client shows it.

**Credentials.** what travels is auth.json and nothing else, so the session answers as this machine answers: an oauth login, and any key stored through `/login`.
api keys from the shell's environment used to go with it, which handed the session a second identity to choose between, and the choice was not the laptop's: a far side billing an api account while the laptop bills its subscription is two accounts for one conversation.

an oauth token lasts hours and its refresh token is single use, so the copy lent when the session started goes stale as soon as this machine refreshes its own login.
the far side then answers with an empty message carrying the refusal inside it, which reads as the model having nothing to say.
the client hands over credentials as fresh as this machine's before every attach, and pi rereads them without restarting.

**Which pi runs there.** the version this machine runs, installed on the host under `~/.cache/rho/pi/<version>` the first time it is needed and reused after.
a host's own pi is whatever was installed there, and a host that has never had pi can hold a session this way.
it is installed rather than copied, because pi's cli is a bundle whose externals resolve only when a package manager has put them there, and it is run with node in preference to bun, because a host's bun can be older than the pi it is asked to run.

rho is sent too, so the agent there is this agent: its tools, its prompt, its rules.
the bundle's layout is pinned with `--root`, because without it bun takes the common root of the entry paths as they were written: a deploy started from `~/Git/mock` against `../../Code/rho/extensions/*.ts` wrote every extension into `_.._/_.._/Code/rho/` inside the package, pi loaded `./extensions` and found only the five vendored files, and the session ran with none of rho at all.
what that costs is not cosmetic: without `prompt-defingerprint.ts` anthropic classifies every request from that host as third party, which routes it to extra-usage billing and answers `429 ... would exceed your account's monthly spend limit` while the plan has headroom.
the build now counts what came out against what went in and fails rather than shipping a partial bundle.
the extensions are built to javascript here, where bun is, because the pi on a host runs under node when that host's bun is older than this pi, and node cannot load typescript.
`bin/build-remote-rho` makes that package, and it is sent under a name taken from its contents, so an edit here is a different directory there.
bun-runtime.ts is left out of it: it exists to force this process to be bun, which on such a host is a crash rather than a repair.

**What the footer says.** the machine, the directory the session is working in, and the branch checked out there.
the branch comes from the far side with the directory, since a branch read here belongs to a checkout the session cannot see.

**When nothing arrives.** a model request that gets no answer looks exactly like one that is thinking, because both are an absence of events.
one request from dev-box, after the session had sat idle, went out over a keep-alive socket the network had already dropped and took exactly 300.0 seconds to time out and retry, with nothing drawn in between.
that is pi's own `httpIdleTimeoutMs`, five minutes by default; a remote session is given thirty seconds instead, which is longer than any first token and short enough that a dead socket costs a pause.
fifteen seconds of silence during a turn now says so, and counts: `waiting on the model, 45s without a reply`.
escape aborts and reaches the far side in under a tenth of a second, so asking again is the way out.

**Measured against dev-box**, from a host with nothing installed on it: create 5.6s, list 0.4s, attach 0.7s warm, an answer streaming 2.3s after asking.
against a session held on this machine, with the real model and rho's own prompt: 0.3s from sending a prompt to the daemon accepting it, 1.7s to the first token, 1.8s to the turn settling, against 2.8s for the same prompt through `pi --print`.
the link is not what makes a turn slow; a model thinking is.

## Stage two: the environment moves, the agent does not

```
/environment connect samuel@gpucluster
/environment default gpucluster     # or: local
```

after this, `bash`, `read`, `write`, `edit`, `glob` and `grep` act on the GPU node.
the agent's cwd, its file paths, its command output: all from there.
the agent itself can switch, so it can allocate a node, connect, work, and drop back to local when the node dies.

paths stay addressable across environments, so `user@gpucluster:/my/file.txt` works from anywhere and an absolute path with no prefix means the current environment.
this is `cd` extended to hosts.

**Not ssh-per-command.** Prefixing every command with ssh loses the working directory, the environment, and any process that outlives one command; it pays a connection per call; and it cannot stream.
instead, an **executor** runs on the target: one small binary, started over ssh the first time, speaking a framed protocol on stdio.

**The executor owns:**

- a working directory and environment that persist between commands.
- process lifecycle: start, stream, signal, kill, and reap.
- file operations, so `read` and `edit` do not shell out to `cat` and `sed`
  (`edit` in particular needs exact-match replacement, not a shell pipeline);
- **lazy output.** A command's output stays on the executor, addressed by id.
  the agent is sent a head and a tail with a byte count; asking for the middle
  fetches only that range. this is the same discipline as context-mode, applied
  across the wire: the bytes stay where they are produced until wanted.

**Getting the executor there.** It must not need Nix, root, or a package manager on a machine that exists for two hours.
A single static binary copied by `ssh cat > …` and executed, or, if the target has Bun, a single script.
cache it by hash under `~/.cache`, so reconnecting to the same node skips the copy.

**Failure is the normal case.** These nodes are pre-empted mid-command.
the executor dying must surface as a tool error naming the environment, must switch the default back to local rather than leaving the agent addressing a corpse, and must say which command was lost.
reconnect resumes: the executor is restarted, but the agent is told the working directory and environment were reset, because pretending otherwise silently changes what a relative path means.

## Detaching on this machine

the same broker holds a session on the machine you are sitting at, which is what tmux was doing before.
`/detach` asks for a name, hands the conversation to a daemon, and closes the interface.
`/attach <name>` draws it again, in this terminal or another one, hours later, and `pi --attach <name>` does the same from a shell.
rho registers that flag on pi's own command line, so coming back to a session is as short as starting one.

the name is resolved against both records, not just this machine's.
a socket here and the ledger of what was started on another host were each read by the extension that wrote them, so `pi --attach overnight` answered for a session on dev-box with "no session called overnight here".
`extensions/lib/remote/sessions.ts` now answers the one question both need, "where is this name", and the flag dispatches on the answer: a socket here is drawn here, and a name in the ledger is handed to the connect in `remote.ts`, which is published through that module because the two extensions cannot import each other.
a socket here wins over the ledger, then the ledger, then a transcript kept here, which orders the readings by what each costs.
the bare `pi --attach` lists both and attaches when there is one candidate; it asks no host anything, since finding out whether a remote session is still running costs an ssh round trip per host and connecting starts a stopped one anyway.

the conversation moves by its session file rather than by copying anything: pi writes every turn to that file as it happens, so the daemon starts on the same file and continues it.
two pi processes appending to one file would interleave two conversations into it, so the daemon waits for the interface to exit before it reads anything (`serve --after-pid`).

the keys follow the distinction rather than the mode.
ctrl+d detaches and leaves the agent running; `/exit`, and ctrl+c twice, stop it.
that holds in an interface onto a session on another machine too, so closing one no longer leaves an agent resident on the far side.
ctrl+d is pi's own exit key, so rho takes `app.exit` out of `~/.pi/agent/keybindings.json` to claim it.

## How the two stages compose

stage one's broker and stage two's executor are the same shape: a host-side process that owns something long-lived and streams to a client with lazy reads.
the difference is what they own.
if the framed protocol is written once, with `open`, `write`, `signal`, `read-range`, `stat` and `close`, then the broker is that protocol carrying session events and the executor is that protocol carrying process output.

that is the thing to build first, and the thing to get right.

## Order of work

1. the framed protocol, with a local-loopback implementation and tests; no ssh.
2. the executor, with `bash` alone routed through it, `/environment connect`
   and `/environment default`.
3. `read`, `write`, `edit`, `glob`, `grep` routed, and `user@host:/path`
   addressing.
4. lazy output ranges.
5. the broker and `/remote`, reusing the protocol.

stage two is the one with the value, and it does not depend on stage one, so it goes first.

## Open questions

- whether the executor should tail a session's tool output to disk on the host.
  as well, so a pre-empted node loses no history.
- whether `/environment` should be per session or per tool call; per session is.
  simpler, but a single `bash` on another host is then three commands.
- what happens to a background process started in an environment that is then.
  switched away from. killed, orphaned, or reattachable by id.
