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

**Wire protocol.** pi already speaks it: rpc mode is jsonl over stdin and stdout, `prompt` and `steer` in, agent events out, with strict lf framing.
so the far side is `pi --mode rpc` and the client is a consumer of that stream.
one thing has to be rebuilt on the way in: the json protocol drops the cumulative assistant message on purpose and sends deltas, and the interface redraws the whole message on every update, so `event-shape.ts` rebuilds it from the deltas rather than asking for a round trip per token.

**Which machine answers.** the client wraps a real local session and replaces only the members that belong to the far side.
the settings, the editor, the theme and the session file are local; the model, the messages, the queue, and every action are the far side's.
a member that cannot be asked at all refuses by name rather than answering about the wrong machine.

**Credentials.** an oauth token lasts hours and its refresh token is single use, so the copy lent when the session started goes stale as soon as this machine refreshes its own login.
the far side then answers with an empty message carrying the refusal inside it, which reads as the model having nothing to say.
the client hands over credentials as fresh as this machine's before every attach, and pi rereads them without restarting.

**Which pi runs there.** the version this machine runs, installed on the host under `~/.cache/rho/pi/<version>` the first time it is needed and reused after.
a host's own pi is whatever was installed there, and a host that has never had pi can hold a session this way.
it is installed rather than copied, because pi's cli is a bundle whose externals resolve only when a package manager has put them there, and it is run with node in preference to bun, because a host's bun can be older than the pi it is asked to run.

rho is sent too, so the agent there is this agent: its tools, its prompt, its rules.
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
