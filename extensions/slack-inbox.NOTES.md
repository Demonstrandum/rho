# slack-inbox: what it is, and what it should be

Built during the dev-box migration to get one person's Slack replies in front of a running session.
It works, and it is not yet a thing to hand to other people.
This note says what to change, and why, before it counts as part of rho.

## The two pieces today

`bin/slack-inbox` holds a Socket Mode WebSocket and appends each human message to `~/.config/robotics-migration/slack-inbox.jsonl`.
`extensions/slack-inbox.ts` delivers unread lines at session start, watches the file, injects new messages with a turn triggered, and forwards replies back: the first turn of an exchange as an acknowledgement, the last as the answer, the narration between them kept out of Slack.
`slack_reply` overrides the text or the channel, `slack_done` ends the exchange.

## What is wrong with it as a rho feature

- **The config path is named after one migration.** `~/.config/robotics-migration/` should be `~/.config/rho/slack/`, and the extension should be inert when it is absent, so installing rho does not imply a Slack connection.
- ~~**It loads everywhere.**~~ Fixed by an owner file: `~/.config/robotics-migration/slack-inbox.owner` holds one session id, `/slack claim` writes it, and any session that is not the owner loads inert (no tools, no watcher, no delivery).
  Unattached is the default.
  The per-session design below is still the right end state; this is the stopgap that stops every pi in every project from ringing.
  Original defect: Sitting in `./extensions` means every pi session in every project connects and injects.
  A session in an unrelated repo receives DMs meant for another one.
- **Sessions race.** Two open sessions watch one spool and share one cursor, so a message goes to whichever reads first.
  Delivery should be claimed, once.

## How it should work

**One connection, owned by the session.** No `rho slack listen`, no daemon, no launchd agent, nothing outside pi.
The socket belongs to the pi+rho session that asked for it and dies with that session.
This drops the mailbox behaviour — messages sent while pi is closed are not collected — and that is the right trade: a background process that receives your DMs whether or not you are working is a surprise, and a second one is a conflict.

**`/slack` attaches the current session.** Tokens can sit in a global config as a default, but the command sets them, and the channel, per session, stored in the session data pi already keeps on disk.
So a session resumed tomorrow is still attached to the same channel without being told again, and a session that never ran `/slack` is silent.
Something like:

```
/slack                       show status: attached? which channel? which app?
/slack connect [#channel]    open the socket for this session
/slack disconnect            close it
```

**Per-session state, not per-machine state.** The cursor problem disappears with the daemon: whatever arrives goes to the session holding the socket, because there is only one.

## Slack style belongs in the tool description

An agent left to itself answers a one-line Slack question with five paragraphs, headings included.
No colleague does that, and it reads as noise on a phone.
The rules therefore live in the tool description and `promptGuidelines`, not only in the text injected with a delivered message, so they apply when the model calls `slack_reply` itself:

- reply as a colleague would, not as a report
- one short line first, before any tool calls, so the sender knows it arrived
- then the work, and the outcome in the final reply
- a one-line question gets a one-line answer
- no headings, no bullet lists, no preamble
- long detail stays in the terminal; Slack gets the summary and an offer

The mechanism that makes this work is worth keeping in any rewrite: a turn ends every time tool calls come back, so a long job produces a run of them.
Only the first and the last are forwarded.
Without that, one question becomes a stream of narration in Slack, which is exactly what happened before it was added.

## Two traps that cost a session each

**Post with the incoming `thread_ts`.** An assistant app's DMs arrive in a thread, and a reply sent without it lands in the channel body, where the sender never sees it.

**Keep the watcher handle on `globalThis`.** `/reload` loads a fresh copy of the extension, which cannot see the previous copy's watcher; the old one kept calling into a replaced session until pi died of an uncaught stale-ctx throw.

## Look at @pinet/slack-bridge first

<https://pi.dev/packages/@pinet/slack-bridge> almost certainly does all of this
already: Socket Mode, thread routing, an inbox per agent, `slack_send`, default-deny access by user ID, per-channel mention guards, read-only and confirmation policies.
It also does much more — a broker/follower mesh, a maintenance loop, canvases and pins — which may be more than is wanted, but the overlap is the whole of the above.

```
pi install npm:@pinet/slack-bridge
```

Two ideas worth taking regardless of whether we adopt it:

- **A `manifest.yaml`.** Slack can create an app from a manifest, so setup becomes "paste this file" instead of a list of scopes to tick by hand.
  Ours needed `connections:write` on an app token, `chat:write`, `im:history`, `users:read`, and a `message.im` subscription, all found by trial.
  A manifest states them once and cannot drift.
- **Better still, a create-app link.** `https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded manifest>`
  opens the create dialog pre-filled from a manifest, so the only manual steps
  left are generating the two tokens. Worth checking whether that parameter is
  still supported, and if so shipping the link in `/slack` output so a new user
  goes from nothing to connected in about a minute.
