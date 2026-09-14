---
name: symba
description: provision and use Forge nodes from robotics-vm, and move the agent's own execution environment onto them. use when asked to allocate a GPU or CPU node, to attach yourself to robotics-vm and provision from there, to check out a repository and branch on a node and work in it, to extend or terminate a lease, or to get results off a node before it expires.
---

# provisioning a node and working on it

three machines, and which one you are on is the whole of this skill.

- the laptop, where the session is drawn and where nothing valuable lives.
- robotics-vm, always up, on the tailnet, and the only machine that may talk to forge.
- a forge node, expensive and short lived, which takes its disk with it when the lease ends.

the agent moves itself between them.
`/environment connect samuel@robotics-vm` makes bash, read, write and edit act there; `/environment connect ubuntu@<node>` moves them again; `/environment default local` brings them back.
a machine switch is announced in the transcript, so a command never lands somewhere unnoticed.

## the shape of a run

```
/environment connect samuel@robotics-vm     # the only machine that can allocate
symba profiles                              # what exists, and what it costs
symba create --profile gpu-small --name <run> --time <hours>
symba list                                  # id, tailnet address, hours left
/environment connect ubuntu@<node-address>  # the agent now works on the node
```

from there the node is an ordinary machine: clone, build, run, read logs.
when the run is done, take the results off it and end the lease, in that order.

## checking out a repository on the node

the agent's own credentials are not on the node and must not be put there.
ssh to forge nodes is agent-forwarded from robotics-vm, so a clone that uses the forwarded agent works and leaves no key behind:

```sh
GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=accept-new' \
  git clone --branch <branch> --single-branch git@github.com:symbolica-ai/<repo>.git ~/work/<repo>
```

for a second branch of the same repository, a worktree costs one clone rather than two:

```sh
git -C ~/work/<repo> fetch origin <branch>
git -C ~/work/<repo> worktree add ~/work/<repo>-<branch> <branch>
```

`/remote project <repo-url> <branch> ubuntu@<node>` does the same thing and starts a session in the worktree, which is what you want when the work should outlive the connection.

## the lease is the thing to get right

a gpu profile costs roughly a hundred times a cpu one, and a node that expires takes its disk with it.

```sh
symba extend <id> --hours 4      # before it expires, never after
symba download ubuntu@<node>:/home/ubuntu/runs/out.tar.zst ./out.tar.zst
symba storage upload ubuntu@<node>:/home/ubuntu/runs/out.tar.zst <name>.tar.zst
symba terminate <id> --yes       # the moment the run is done
```

`storage upload` streams node to storage, so a large artefact never passes through robotics-vm or the laptop.
`download` brings a path to wherever the command runs.

## what to check before blaming the run

`bin/symba-doctor` in robotics-server answers, in one command, whether this machine can allocate at all: tailnet membership, whether the forge api resolves, whether it answers, and whether symba itself is installed.
run it on robotics-vm before anything else, because every failure below looks like a network error from the cli.

- symba's built-in api address is `forge-api.tailbce956.ts.net`, which is not a name this tailnet serves; the device is `symbolica-forge-api`.
  `SYMBA_API_URL=https://symbolica-forge-api.tailbce956.ts.net symba profiles` is the form that has a chance of working.
- a peer this device is not permitted to see reports `no matching peer` from `tailscale ping`, and the cli says only `Name or service not known`.
  that is an acl question for the tailnet admin, not something to retry.
- forge nodes accept tailscale ssh from robotics-vm only where the acl allows those tags to talk.

## rules that are not negotiable

- allocate from robotics-vm, never from the laptop: the laptop is not always on and a lease outlives it.
- terminate what you allocate, and say the id you terminated.
- nothing that matters stays only on a node: it goes to forge storage or off the node before the lease ends.
- a lease is extended before it expires; after is a new node and a lost disk.
