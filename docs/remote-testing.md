# Testing /environment and /remote

start in a scratch repo, `~/Git/mock`, with `/reload` first so the session has the current extensions.
paste what breaks rather than working around it: the interesting failures so far have all been things that unit tests cannot reach.

## before anything

nothing.
`/remote create` lends the session what this laptop is logged in with, which is auth.json and nothing else: an oauth login, and any key stored through `/login`.
keys from the shell's environment used to travel beside it, giving the session a second identity to pick from, and a far side answering on an api key while the laptop answers on its subscription is two accounts for one conversation.
the far side gets a config directory of its own, mode 0700, with the rest of the config symlinked in, and pi is pointed at it with PI_CODING_AGENT_DIR.
nothing is written into the host's own home, so the credentials die with the session.

an oauth token lasts hours and its refresh token is single use, so the copy lent at create goes stale once this laptop refreshes its own login.
the client hands over fresh credentials before every attach, and pi rereads them without restarting, so this should not be visible.
if it ever is, the symptom is an answer that arrives empty: the refusal travels inside the assistant message rather than as an error.

## /environment: the agent works elsewhere

```
/environment connect samuel@robotics-vm
```

then ask for `hostname`, `pwd`, a file read, a file edit.
all of it should happen on robotics-vm while the session stays on the laptop.

what is worth checking, in order of how likely it is to be wrong:

- `cd /srv/web` in one command, `pwd` in the next; the directory must persist.
  this is the thing ssh-per-command cannot do, and the reason an executor exists at all.
- A large output, say `journalctl -n 5000`; you should get a head, a tail and.
  an exact byte count rather than the whole thing.
- an edit against a file that has the same text twice; it must refuse rather.
  than guess.
- `/environment list`, then `/environment default local`, then a command: back on the laptop.

## /remote: the session runs elsewhere

```
/remote create mock nix@robotics-vm
/remote connect mock
```

`create` starts a session as a daemon on that machine and returns.
`connect` hands this terminal to it: a client draws the session with pi's own interface, and the local session stands aside the way it does for an external editor.
what you see is pi, streaming as it always does, reading the events of a session that is somewhere else.

ctrl+d leaves the client and gives the terminal back, with the session still running.
ctrl+c twice also leaves, and `/exit` ends the session: a command is now run on the side that owns it rather than always on the far side.
`/remote list nix@robotics-vm` shows what is running there, and `/remote stop mock` ends one.

what to check while you are in there, in order of how likely it is to be wrong:

- the footer names the machine and the remote directory, `robotics-vm /home/nix`, not this laptop's.
- ask for a command, say `hostname && pwd`; the row is pi's own and the answer is the far side's.
- escape mid-answer: the abort must settle the far side, not a local session that is not running.
- leave with ctrl+d and connect again: the conversation is drawn as it stands, tool calls and their output included.
- a turn that goes quiet for fifteen seconds says `waiting on the model, 45s without a reply` and counts until something arrives.
- `/remote stop mock` from another window while you are attached: the client says which session on which host closed, gives the terminal back, and exits.
- `/theme` and `/stash` open here, against this terminal; `/rewind` runs on the far side and its checkpoint list is drawn here as a select.
- `/rewind` in a directory with no checkpoints says "No checkpoints available" rather than nothing at all.
- detach with ctrl+d while a far-side dialog is open, then connect again: the question is put again rather than left parked.
- name a model that does not exist there: the refusal is shown rather than swallowed.

measured against robotics-vm with nothing installed on it beforehand: create 3.0s, list 0.3s, attach 0.4s, abort reaching the far side in 94ms, an answer streamed about 2s after asking.
eight attach and detach cycles leave no relays behind and settle at 370ms per attach, because the ssh connection is shared.

## /remote project: a repo and a worktree, without ssh

```
/remote project git@github.com:symbolica-ai/robotics-server.git feature/remote samuel@robotics-vm
/remote connect robotics-server-feature-remote
```

makes `~/projects/demo/checkout/robotics-server` and `~/projects/demo/worktrees/main`, then starts a session in the worktree.
the clone uses the laptop's forwarded agent, so no key is on the host.

- ask for a second branch: `/remote project <same repo> other`; it should.
  reuse the clone and add a worktree, not clone again.
- asking for the same branch twice should land in the existing worktree rather.
  than failing.

## What is already proven, and what is not

proven live against robotics-vm: the executor connecting in about four seconds,
a persistent working directory, output held on the far side and read by range,
exact-match edits refusing an ambiguous match, a session outliving its client,
a late client catching up, `stop`, a private repo cloned with forwarded
credentials, and the forwarded key present in the session's environment but
absent from every command line and from disk.

also proven, on a host wiped to nothing first: a remote session answering with a
real model and streaming token by token; two clients watching one live turn and
both seeing every frame; one client leaving without disturbing the other; abort
reaching the far side; a command running there and not here; reattaching to a
conversation and continuing it; the client exiting when its session is stopped
under it; and nothing left behind afterwards, no relays, no brokers, no sockets.

not proven: reconnecting after the laptop sleeps rather than after a clean
disconnect; an environment whose machine is pre-empted mid command, which is the
case rented nodes will actually produce; a session left running for days.

## Known rough edges

- `project.toml` does not exist; nothing reads per-project settings yet.
- the first connect as a new user copies the bundle again, because the cache is.
  per user under `~/.cache/rho`.
- which machine a session is on is remembered in `~/.cache/rho/remote/sessions.json`;.
  delete that and `/remote connect` needs the host spelled out again.
- a session runs until it is stopped; nothing expires it, so a forgotten one.
  holds about forty megabytes on the host until `/remote stop`.

## addressed paths

`user@host:/path` names a file and the machine it is on, so one read can come
from elsewhere without switching the session.
`local:/path` is this machine, since a bare path means the current environment.

- with an environment attached, read `local:/Users/samuel/Git/mock/README.md`.
it comes from the laptop.
- with nothing attached, read `samuel@robotics-vm:/etc/os-release`.
it attaches on demand and comes from there.
- a plain path still follows the current environment.
