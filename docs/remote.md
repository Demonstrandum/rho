# Remote sessions and remote environments

Three machines, with different lifetimes:

- the laptop, switched off at will, holds nothing;
- dev-box, always up, cheap, holds the agent and its history;
- a rented GPU node, expensive and temporary, holds nothing that must survive it.

The agent runs on the middle one. The laptop draws it. The GPU node does the
work the agent asks for. Nothing valuable is on a machine that disappears.

## Stage one: the session runs elsewhere

```
/remote create mysesh samuel@dev-box
/remote connect mysesh
```

After `connect`, the local pi is a viewer. Keystrokes go up, session events come
down, and the TUI is drawn from those events rather than from a framebuffer.
Closing the laptop leaves the session running; opening it again reattaches and
redraws from history.

**Wire protocol.** pi already speaks the needed protocol: RPC mode is JSONL
over stdin and stdout, `prompt` and `steer` in, agent events out, with strict
LF framing. So the host side is `pi --mode rpc` and the client side is a
consumer of that stream. No new protocol, and the same events the local TUI
already renders.

**Transport.** ssh, because it is the one thing already working: keys, tailnet
identity, no open ports, no daemon to secure. `ssh host pi --mode rpc --session
<id>` is the whole of it for a single client.

**The multiplexing problem.** One RPC process per ssh connection means two
viewers get two sessions. A session that survives disconnection must outlive
the ssh channel, so something on the host owns the process and clients attach
to it. Two ways:

1. **tmux.** `pi` runs in a named tmux session on the host; the client runs
   `pi --mode rpc` inside it. Reuses a battle-tested supervisor and gives a
   fallback: `ssh` in and see the same session in a terminal. But the RPC
   stream then shares a pty with terminal drawing, which is the thing to avoid.
2. **A small host-side broker,** which is what I would build. It owns
   `pi --mode rpc` per named session, keeps a ring buffer of recent events for
   redraw on attach, and fans out to zero or more clients over a unix socket.
   `ssh host rho-remote attach mysesh` connects stdio to that socket.

`/remote broadcast mysesh` from a terminal on the host is then just registering
an already-running session with the broker.

**Redraw on attach.** The client needs enough to draw: the session file has the
full history, and the broker's buffer has anything since. Attach sends the
session id, the client reads the file over the same channel, then applies live
events. Cheap, because the session file is the source of truth pi already keeps.

**What is hard.** Interactive tool prompts (permission gates, `ui.confirm`)
have to be forwarded and answered by whichever client is attached, and two
attached clients need one answer, not two. First client to answer wins, the
other sees it resolved.

## Stage two: the environment moves, the agent does not

```
/environment connect samuel@gpucluster
/environment default gpucluster     # or: local
```

After this, `bash`, `read`, `write`, `edit`, `glob` and `grep` act on the GPU
node. The agent's cwd, its file paths, its command output: all from there. The
agent itself can switch, so it can allocate a node, connect, work, and drop
back to local when the node dies.

Paths stay addressable across environments, so `user@gpucluster:/my/file.txt`
works from anywhere and an absolute path with no prefix means the current
environment. This is `cd` extended to hosts.

**Not ssh-per-command.** Prefixing every command with ssh loses the working
directory, the environment, and any process that outlives one command; it pays
a connection per call; and it cannot stream. Instead, an **executor** runs on
the target: one small binary, started over ssh the first time, speaking a
framed protocol on stdio.

**The executor owns:**

- a working directory and environment that persist between commands;
- process lifecycle: start, stream, signal, kill, and reap;
- file operations, so `read` and `edit` do not shell out to `cat` and `sed`
  (`edit` in particular needs exact-match replacement, not a shell pipeline);
- **lazy output.** A command's output stays on the executor, addressed by id.
  The agent is sent a head and a tail with a byte count; asking for the middle
  fetches only that range. This is the same discipline as context-mode, applied
  across the wire: the bytes stay where they are produced until wanted.

**Getting the executor there.** It must not need Nix, root, or a package
manager on a machine that exists for two hours. A single static binary copied
by `ssh cat > …` and executed, or, if the target has Bun, a single script. Cache
it by hash under `~/.cache`, so reconnecting to the same node skips the copy.

**Failure is the normal case.** These nodes are pre-empted mid-command. The
executor dying must surface as a tool error naming the environment, must switch
the default back to local rather than leaving the agent addressing a corpse,
and must say which command was lost. Reconnect resumes: the executor is
restarted, but the agent is told the working directory and environment were
reset, because pretending otherwise silently changes what a relative path means.

## How the two stages compose

Stage one's broker and stage two's executor are the same shape: a host-side
process that owns something long-lived and streams to a client with lazy reads.
The difference is what they own. If the framed protocol is written once, with
`open`, `write`, `signal`, `read-range`, `stat` and `close`, then the broker is
that protocol carrying session events and the executor is that protocol
carrying process output.

That is the thing to build first, and the thing to get right.

## Order of work

1. The framed protocol, with a local-loopback implementation and tests. No ssh.
2. The executor, with `bash` alone routed through it, `/environment connect`
   and `/environment default`.
3. `read`, `write`, `edit`, `glob`, `grep` routed, and `user@host:/path`
   addressing.
4. Lazy output ranges.
5. The broker and `/remote`, reusing the protocol.

Stage two is the one with the value, and it does not depend on stage one, so it
goes first.

## Open questions

- Whether the executor should tail a session's tool output to disk on the host
  as well, so a pre-empted node loses no history.
- Whether `/environment` should be per session or per tool call. Per session is
  simpler, but a single `bash` on another host is then three commands.
- What happens to a background process started in an environment that is then
  switched away from. Killed, orphaned, or reattachable by id.
