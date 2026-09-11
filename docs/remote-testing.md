# Testing /environment and /remote

start in a scratch repo, `~/Git/mock`, with `/reload` first so the session has the current extensions.
paste what breaks rather than working around it: the interesting failures so far have all been things that unit tests cannot reach.

## before anything

nothing.
`/remote create` lends the session whatever this laptop is logged in with: the api keys in the environment, and the contents of auth.json for an oauth login, which no environment variable can carry.
the far side gets a config directory of its own, mode 0700, with the rest of the config symlinked in, and pi is pointed at it with PI_CODING_AGENT_DIR.
nothing is written into the host's own home, so the credentials die with the session.

## /environment: the agent works elsewhere

```
/environment connect samuel@dev-box
```

then ask for `hostname`, `pwd`, a file read, a file edit.
all of it should happen on dev-box while the session stays on the laptop.

what is worth checking, in order of how likely it is to be wrong:

- `cd /srv/web` in one command, `pwd` in the next; the directory must persist.
  this is the thing ssh-per-command cannot do, and the reason an executor
  exists at all.
- A large output, say `journalctl -n 5000`; you should get a head, a tail and.
  an exact byte count rather than the whole thing.
- an edit against a file that has the same text twice; it must refuse rather.
  than guess.
- `/environment list`, then `/environment default local`, then a command: back
  on the laptop.

## /remote: the session runs elsewhere

```
/remote create mock nix@dev-box
/remote connect mock
```

`create` starts a session as a daemon on that machine and returns.
`connect` hands this terminal to it: a client draws the session with pi's own interface, and the local session stands down while it does.
what you see is pi, streaming as it always does, reading the events of a session that is somewhere else.

leaving the client gives the terminal back, and the session carries on.
`/remote list nix@dev-box` shows what is running there, and `/remote stop mock` ends one.

measured against dev-box with nothing installed on it beforehand: create 5.6s, list 0.4s, attach 4.9s cold and 0.7s warm, an answer streamed 2.3s after asking.

## /remote project: a repo and a worktree, without ssh

```
/remote project git@github.com:example-org/demo-server.git demo/main samuel@dev-box
/remote connect demo
```

makes `~/projects/demo/checkout/demo-server` and `~/projects/demo/worktrees/main`, then starts a session in the worktree.
the clone uses the laptop's forwarded agent, so no key is on the host.

- ask for a second branch: `/remote project <same repo> demo/other`; it should.
  reuse the clone and add a worktree, not clone again.
- asking for the same branch twice should land in the existing worktree rather.
  than failing.

## What is already proven, and what is not

proven live against dev-box: the executor connecting in about four seconds,
a persistent working directory, output held on the far side and read by range,
exact-match edits refusing an ambiguous match, a session outliving its client,
a late client catching up, `stop`, a private repo cloned with forwarded
credentials, a prompt reaching the remote pi and its answer coming back, and
the forwarded key present in the session's environment but absent from every
command line and from disk.

not proven: a remote session answering with a real model; two viewers attached
at once outside the unit test; reconnecting after the laptop sleeps rather than
after a clean disconnect; an environment whose machine is pre-empted mid
command, which is the case rented nodes will actually produce.

## Known rough edges

- `/remote connect` starts a session for a project that has none, but the.
  viewer and the session runner both assume the host has bun or node. A machine
  with neither gets the compiled executor for `/environment`, but `/remote`
  refuses.
- `project.toml` does not exist; nothing reads per-project settings yet.
- the first connect as a new user copies the bundle again, because the cache is.
  per user under `~/.cache/rho`.

## addressed paths

`user@host:/path` names a file and the machine it is on, so one read can come
from elsewhere without switching the session.
`local:/path` is this machine, since a bare path means the current environment.

- with an environment attached, read `local:/Users/samuel/Git/mock/README.md`.
it comes from the laptop.
- with nothing attached, read `samuel@dev-box:/etc/os-release`.
it attaches on demand and comes from there.
- a plain path still follows the current environment.
