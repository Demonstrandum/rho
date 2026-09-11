# Testing /environment and /remote

Start in a scratch repo, `~/Git/mock`, with `/reload` first so the session has
the current extensions. Paste what breaks rather than working around it: the
interesting failures so far have all been things that unit tests cannot reach.

## Before anything

`echo ${ANTHROPIC_API_KEY:+set}` on the laptop. `/remote create` forwards that
variable into the remote session's environment, and a session with no key will
accept a prompt and answer that it has none. OAuth login on the laptop leaves
nothing to forward.

## /environment: the agent works elsewhere

```
/environment connect samuel@robotics-vm-1
```

Then ask for `hostname`, `pwd`, a file read, a file edit. All of it should
happen on robotics-vm while the session stays on the laptop.

What is worth checking, in order of how likely it is to be wrong:

- `cd /srv/web` in one command, `pwd` in the next. The directory must persist.
  This is the thing ssh-per-command cannot do, and the reason an executor
  exists at all.
- A large output, say `journalctl -n 5000`. You should get a head, a tail and
  an exact byte count rather than the whole thing.
- An edit against a file that has the same text twice. It must refuse rather
  than guess.
- `/environment list`, then `/environment default local`, then a command: back
  on the laptop.

## /remote: the session runs elsewhere

```
/remote create mock samuel@robotics-vm-1
/remote connect mock
```

After `connect` this terminal is a viewer: what you type goes to the session on
robotics-vm, and its replies are drawn here.

- `/remote disconnect`, then `/remote list samuel@robotics-vm-1`. The session
  is still running.
- `/remote connect mock` again. It should pick up where it was, including the
  recent exchange.
- Two terminals connected at once should see one session, not two.
- `/remote stop mock` ends it.

This is the least proven part. A prompt has reached the remote pi and its
response has come back, but never with a working model key, so the rendering of
a real answer is untested.

## /remote project: a repo and a worktree, without ssh

```
/remote project git@github.com:symbolica-ai/robotics-server.git demo/main samuel@robotics-vm-1
/remote connect demo
```

Makes `~/projects/demo/checkout/robotics-server` and
`~/projects/demo/worktrees/main`, then starts a session in the worktree. The
clone uses the laptop's forwarded agent, so no key is on the host.

- Ask for a second branch: `/remote project <same repo> demo/other`. It should
  reuse the clone and add a worktree, not clone again.
- Asking for the same branch twice should land in the existing worktree rather
  than failing.

## What is already proven, and what is not

Proven live against robotics-vm: the executor connecting in about four seconds,
a persistent working directory, output held on the far side and read by range,
exact-match edits refusing an ambiguous match, a session outliving its client,
a late client catching up, `stop`, a private repo cloned with forwarded
credentials, a prompt reaching the remote pi and its answer coming back, and
the forwarded key present in the session's environment but absent from every
command line and from disk.

Not proven: a remote session answering with a real model; two viewers attached
at once outside the unit test; reconnecting after the laptop sleeps rather than
after a clean disconnect; an environment whose machine is pre-empted mid
command, which is the case rented nodes will actually produce.

## Known rough edges

- `/remote connect` starts a session for a project that has none, but the
  viewer and the session runner both assume the host has bun or node. A machine
  with neither gets the compiled executor for `/environment`, but `/remote`
  refuses.
- `project.toml` does not exist. Nothing reads per-project settings yet.
- The first connect as a new user copies the bundle again, because the cache is
  per user under `~/.cache/rho`.
