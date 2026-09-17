---
name: remote
description: work on another machine, or run the session on one. use when asked to connect to a host, attach the execution environment to a rented or GPU node, allocate a nodes node and work on it, start or attach a long-lived session on the always-on host, or set up a project checkout and worktree there. loads the environment and remote_session tools.
---

# working somewhere else

three machines with different lifetimes, and the point is to keep each thing on the one that suits it.

the laptop can be switched off, so it holds nothing.
dev-box is always up and cheap, so it holds the session and its history.
a rented GPU node is expensive and pre-empted, so it holds no state that must survive it: it runs commands and nothing else.

two independent mechanisms, and they compose.

## naming a machine

every connection here is made by running `ssh`, so ssh resolves the name from `~/.ssh/config`: the user, the address, the port, the key, and the jump host.
a host name on its own is therefore a complete address.
`environment connect dev-box`, `bash on: 'gpu-4'`, and `dev-box:/srv/log` all work, and none of them needs a user.

never read `~/.ssh/config` to find the user for a host.
that file is parsed by ssh, with patterns, negation, `Include` and `Match`, and a grep over it gets the wrong answer on any of them.
write `user@host` only for a machine the config does not cover, such as a rented node addressed by its tailnet address.

to see which names exist: `rg '^Host ' ~/.ssh/config`.
to see what one of them resolves to, ask ssh rather than the file: `ssh -G dev-box | rg '^(user|hostname|port) '`.

## the execution environment: `environment`

`environment connect <host>` attaches a machine and makes it current.
after that, bash, read, write and edit act there, with a working directory that persists between commands.
`environment default <name>` switches between attached machines, and `environment default local` comes back to this one.
`environment list` says what is attached and which is current.

an executor is copied to the far side on first connect: a small bundle where the machine has bun or node, a static binary where it has neither.
nothing is installed, nothing needs root, and it dies with the connection.

a rented node is pre-empted without warning.
when that happens the tools refuse rather than quietly running on the laptop, and the environment has to be reconnected or abandoned deliberately.

## the session: `remote_session`

`remote_session create <name> <host>` starts an agent session on that
machine, which keeps running when this one stops.
`remote_session list <host>` says what is running there.

the person attaches to one with `/remote connect <name>`, which makes their
terminal a viewer: what they type goes to the session, and its replies are
drawn locally.
`/remote disconnect` leaves it running.

`/remote project <repo> <project>/<branch> <host>` clones on the host using
the person's forwarded ssh agent, as `projects/<project>/checkout/<repo>` with
a worktree per branch beside it, and `/remote connect <project>` starts a
session in that worktree.

## allocating a node and working on it

the usual sequence when asked to work on rented hardware:

```
nodes create --profile cpu-small --name work --time 2
nodes list                                   # for the tailnet address
```

then `environment connect ubuntu@<address>`, which is the case that does need
a user because the address came from `nodes list` and not from the ssh config.
do the work, and
`nodes terminate <node id> --yes` when it is done.
the node costs money for as long as it exists, so it is terminated rather than
left running, and the session stays on the always-on host so that terminating
the node loses nothing.

## what belongs where

state that must survive goes on dev-box or in a repository, never on a
rented node.
the agent never runs on the rented node: it runs on the host and acts on the
node through the environment, because a pre-empted machine takes everything
running on it with no warning.

## reading one file on another machine

a path may name its machine.
`host:/abs/path` (or `user@host:/abs/path`) reads or writes there, attaching to that host if nothing is attached to it yet.
`local:/abs/path` always means the machine the session runs on.
a plain path means whichever machine is current, so `local:` is how to reach a file here while an environment is attached.
this is for one file: `environment connect` is still how the session moves, and a command is not a path, so bash always runs on the current machine.

## one command on another machine

`bash` takes an optional `on`: an attached environment name, a host to attach on demand, or `local`.
omit it unless the command has to run somewhere other than the current environment: naming the machine the session already points at repeats what the environment block says and reads as though it changed something.
without it the command runs wherever the environment currently points.
this is the command equivalent of an addressed path, and it exists so that running one command elsewhere does not mean moving the session there and back, which would change where every later command goes.
