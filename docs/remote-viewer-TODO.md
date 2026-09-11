# the local UI, driven by a remote session

the first attempt injected the far side's events into the local session as custom messages.
that is a reimplementation of the interface, and a bad one: no streaming, every event in its own block, stale information restated, and none of pi's own rendering.
it is removed.

what it should be: pi's own `InteractiveMode`, running locally, driven by a session that lives on another machine.
the same TUI, the same streaming, the same rows, with the events arriving over a socket instead of from a local agent.

## what pi already gives us

`InteractiveMode` and `AgentSessionRuntime` are both exported from the package root.
`InteractiveMode` takes a runtime and handles the TUI; the runtime owns the session, the session manager and the services.
`pi --mode rpc` already speaks every event the TUI consumes, as JSONL, with strict framing.
`dist/modes/rpc/rpc-client.js` is a client for that stream.

so the missing piece is one adapter: an `AgentSessionRuntime` whose session is a proxy over the rpc stream rather than a local agent.
prompts and steering go out as `prompt` and `steer` commands; `message_update`, `tool_execution_update` and the rest come back and are handed to the TUI exactly as a local session would hand them over.

## what that fixes

streaming, because `message_update` carries token deltas and the TUI already knows how to draw them.
formatting, because every row is drawn by the renderer that draws it locally, including the extensions loaded here.
staleness, because the session file is the far side's and the events are live.

## how it should feel

`/remote connect mock` replaces the session this terminal is showing, rather than drawing a second one inside it.
pi has the hook: `ctx.switchSession` and `ctx.newSession` both replace the running session and take a `withSession` callback that runs against the replacement.
so connecting is a session replacement whose runtime happens to be a proxy, and disconnecting is a replacement back.
nothing about the screen says "viewer": it is the same interface, showing a session that lives somewhere else.

## the parts that need deciding

- which side owns the extensions; the remote session loads its own; the local.
viewer loads its own for rendering.
a tool registered only on one side has to render as something on the other.
- interactive prompts; `ui.confirm` and `ui.select` happen on the far side and.
have to be forwarded and answered by whichever viewer is attached, with one answer winning.
- history on attach; the session file holds it; the viewer needs enough of it.
to draw a screen without shipping a megabyte of json.
- two viewers; the broker already fans out; the TUI has to tolerate another.
client typing.

## what works today, and is not this

`/remote create` starts the session, and pi itself is run over ssh to see it:

```
ssh -t nix@robotics-vm pi --resume mock
mosh nix@robotics-vm -- pi --resume mock
```

that is the real interface with every keystroke crossing the wire, which is what tmux over ssh already does and what this has to beat rather than excuse.
