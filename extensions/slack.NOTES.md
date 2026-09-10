# slack: why it is built this way

Built during the robotics-vm migration to get one person's Slack replies in front of a running session, then rebuilt as three files with no daemon and no fixed workspace.
`extensions/slack.ts` is the session side, `extensions/lib/slack-api.ts` the Slack calls and the socket, `extensions/lib/slack-config.ts` the store of apps and the lock.
`bin/slack-inbox` and its spool are gone.

## The unit is the app, and an app belongs to one session

Slack allows one app up to ten open Socket Mode connections and sends each payload to any of them, with no documented pattern to the choice ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)).
Two sessions connected to one app therefore split the incoming DMs at random, and no cursor can repair that, because the messages the other session took never arrive here at all.
Two sessions on two apps are independent, and the credentials are per app already.

So the store holds apps by name, `<config dir>/slack/apps/<name>.json` at mode 0600, and `/slack code-bot` attaches this session to one of them.
The lock is per app, `<name>.lock`, holding the session id, the pid, and the working directory.
A lock whose pid is no longer running is stale and is taken over without asking; a live one refuses until `/slack <name> force`.
A session that never names an app opens nothing.

`/slack add <name>` prompts for the two tokens through `ctx.ui.input` rather than reading them from the command line.
A token typed as a message is in the transcript, in the session file on disk, and in the next request to the model.

## What arrives while nothing is connected

Socket Mode does not redeliver events sent while no socket was open, and the docs say events may be lost until a connection is established.
Every conversation therefore carries a high-water mark in session state, and the socket asks `conversations.history` for everything after it when it opens.
That call needs `im:history` for a DM.
Enumerating DM conversations through `users.conversations` would need `im:read`; keeping the channel ids already seen avoids depending on it, and the scope is in the manifest anyway.

State lives in `extensions/lib/state-store.ts` under the `session` scope, keyed by session id and pruned after 30 days: the attached app name and the marks.
`pi.appendEntry()` was the alternative and is the wrong one, because this is machine state about a socket rather than part of the conversation.
A resume reopens the app it was attached to, unless another session has taken it in the meantime.

## Telling the sender the message landed

Three signals, in ascending cost, and all of them are `chat:write` except the first.

A reaction on the incoming message (`reactions.add`, `reactions:write`, `eyes` by default) is the read mark.
Slack exposes no read receipt to an app, and this is the convention that stands in for one.
It works in a DM, a thread, and a channel, whatever kind of app it is.

The status line (`agents.sessions.setStatus`, and `assistant.threads.setStatus` for an app that predates it) renders as `code-bot is thinking...` exactly where a human's typing indicator goes.
It takes `loading_messages`, up to ten, which Slack rotates.
Slack clears it when the app posts and it expires after two minutes by itself, so a long turn refreshes it every 90 seconds.
Only an assistant or agent app has that surface: the first call settles which method the app answers to, and an app that answers to neither is marked and never asked again, which is one wasted call per session rather than one per message.

The text acknowledgement, the first reply of an exchange forwarded as a message, is what the daemon version did and is now off by default (`[slack] ack-message`).
The reaction and the status line say the same thing without spending a message in the thread.

## Files, and where a message is allowed to come from

An attachment is not a URL the session can use: `url_private` answers only to the bot token, and answers a browser with a login page.
So an incoming file is fetched once with the token and written to the session scratch directory under `slack/`, prefixed with the Slack file id so two files of one name stay apart and a redelivery overwrites rather than piles up.
The delivered message names the paths, and from there the ordinary file tools read them.

Outgoing files take the external upload: `files.getUploadURLExternal`, a POST of the bytes to the URL it returns, then `files.completeUploadExternal` to attach the file to a conversation.
`files.upload` is retired.
That is `slack_send_file`, which takes a path and defaults to the conversation in progress.

The scopes are granted at creation because adding one later means reinstalling the app to every workspace it is in.
They therefore cover more than the extension calls today: group DMs, private and public channels, reading a reaction back.
A scope is a permission, not an action.
The events decide what arrives, and the guard decides what is answered: a DM or a group DM is addressed to the app by existing, and a message in a channel reaches the session only when it contains `<@` and the app's own user id, which `auth.test` supplies at connect.
Without that rule an app invited to a busy channel answers every line in it.

## Slack style belongs in the tool description

An agent left to itself answers a one-line Slack question with five paragraphs, headings included.
No colleague does that, and it reads as noise on a phone.
The rules therefore live in the tool description and `promptGuidelines`, not only in the text injected with a delivered message, so they apply when the model calls `slack_reply` itself:

- reply as a colleague would, not as a report
- a one-line question gets a one-line answer
- no headings, no bullet lists, no preamble
- long detail stays in the terminal; Slack gets the summary and an offer

The mechanism behind it: a turn ends every time tool calls come back, so a long job produces a run of them.
Only the last is forwarded, the one that ended with no tool calls, because that is the answer.
Without that rule one question becomes a stream of narration in Slack, which is what happened before it was added.

`slack_reply` writes to Slack directly, and takes a channel, so the agent can answer someone other than whoever started the turn.
`slack_done` closes the exchange when the rest of the work is only of interest here.
Both are registered when a session attaches, not at load, so an unattached session pays nothing for them in its prompt.

## Three traps

**Post with the incoming `thread_ts`.** An assistant app's DMs arrive in a thread, and a reply sent without it lands in the channel body, where the sender never sees it.
Slack split this into two messaging experiences on 2026-06-30, chosen in the manifest: `assistant_view`, which is what our app uses and which is closed to new apps and scheduled for deprecation, and `agent_view`, where the conversation looks like an ordinary DM and the app answers in a thread off it ([changelog](https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab)).
Echoing the incoming `thread_ts` when there is one, and treating the message itself as the root of a thread when there is not, is correct under both, and is what `SlackWeb.incoming` does.

**The Messages tab is off by default.** An app whose manifest omits `features.app_home` has a read-only DM, and Slack replaces the input box with "Sending messages to this app has been turned off".
The manifest therefore sets `messages_tab_enabled: true` and `messages_tab_read_only_enabled: false`.
An app already created without them is repaired in app settings under App Home, with no reinstall.

**Setting the status opens the thread.** Under `agent_view`, calling `setStatus` on a thread opens that thread for the user, so it is only called when a reply into it is coming.

**Keep the socket handle on `globalThis`.** `/reload` loads a fresh copy of the extension, which cannot see the previous copy's socket; the old one kept delivering into a replaced session until pi died of an uncaught stale-ctx throw.
The same registry now closes the previous copy's socket, which also stops two WebSockets from racing for one app inside one process.

## @pinet/slack-bridge, checked

It exists and it is maintained: `@pinet/slack-bridge` 0.2.13, MIT, published 2026-08-28, about 1500 downloads in the last month, 1.5 MB unpacked over 215 files.
It covers Socket Mode, thread ownership, an inbox per agent, `slack_send`, default-deny access by user id, a per-channel mention guard, and read-only and confirmation policies.
It ships a `manifest.yaml` and a documented token setup.

Three things decide against dropping ours into it, and none of them is the feature list.

It is one package of five: the install pulls `@pinet/pinet-core`, `@pinet/broker-core`, `@pinet/transport-core`, and `@pinet/imessage-bridge`, all pinned to the same version.
An iMessage bridge arriving as a hard dependency of a Slack bridge is not something rho should install on every machine.

Its unit is the machine, not the session.
Tokens and policy live in `~/.pi/agent/settings.json`, and `/pinet start` takes a machine-wide broker lock that `/pinet start replace` exists to break when a session dies holding it.
That is our owner file with a mesh, a five-minute maintenance loop, and a stranded-lock recovery path attached.
The thing this note asks for is smaller than the thing it would replace.

It does not carry the reply discipline.
The first-and-last forwarding rule, and the instruction to answer a one-line question in one line, are our text and would have to be re-added on top as guidelines and a skill.
That is the part that took a session to get right; the socket is the part that did not.

The case for adopting it is multi-agent routing: several pi sessions, one Slack app, work assigned per thread.
Until that is wanted, the overlap is a few hundred lines we already have.

## Setup is a manifest and a link

Both are confirmed against the current docs, and `/slack new <name>` prints the link.
Slack creates an app from a manifest, and a manifest can be handed over as a link ([configuring apps with app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests)):

```
https://api.slack.com/apps?new_app=1&manifest_yaml=<url-encoded manifest>
https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded manifest>
```

`apps.manifest.create` also exists, but it needs an app configuration token that expires 12 hours after it is generated, so it is a tool for a build script and not for a person setting rho up once.

The manifest is generated per app in `manifestYaml()`, because the name in it is what Slack prints in front of the status line: `code-bot is thinking...`.
The scopes are `chat:write` (answering, and the status line), `reactions:write` (the read mark), `im:history` (reading a DM and catching up), `im:read` (enumerating DM conversations), and `users:read` (a name instead of `U09L8EEPUTC`).

The manifest cannot produce the tokens, and no API can.
An app-level token exists only once someone generates it under Basic Information ([tokens](https://docs.slack.dev/authentication/tokens)), and a bot token only once someone installs the app to a workspace.
`apps.manifest.create` does not help: its own configuration token has to be generated by hand as well, and expires after 12 hours.

So `/slack new <name>` does everything that can be done and waits for the rest: it opens the pre-filled create dialog in the browser, prints the three clicks, and prompts for each token as it appears.
The floor is two copies and two pastes, about a minute, once per app.
That cost is per app rather than per session, and one app is what one concurrent session needs, so a second agent working in parallel is the only reason to pay it again.

## What is not built

**Streaming the answer.** `chat.startStream`, `chat.appendStream`, and `chat.stopStream` (October 2025, all `chat:write`) stream text into a Slack message as it is produced, and pi hands out token deltas through `message_update`.
The obstacle is not the API: a turn's text is not known to be the answer until the turn ends with no tool calls, so streaming every assistant message would stream the narration the forwarding rule exists to suppress.
One workable shape is to open a stream on the first `message_update` after the last tool result and abandon it if more tool calls follow.

**Channels.** The manifest subscribes to `message.im` only.
A channel needs `channels:history`, `message.channels`, and a mention guard, or the agent answers everything said in the room.

**Sender allow-lists.** Anyone who can DM the app reaches the session.
That is correct for an app installed for one person and wrong for anything wider.
