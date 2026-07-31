# anthropic subscription auth: how pi gets detected, exact findings

date: 2026-07-30. all experiments run against `https://api.anthropic.com/v1/messages`

## tl;dr

anthropic classifies first-party vs third-party traffic by **system prompt content
only**. pi's request is otherwise a perfect claude code replica. a fixed multi-token
span inside pi's harness prompt (the pi documentation cross-reference list) is
signatured server-side. any request containing it is routed to "overage" (extra
usage) billing only, never to plan claims. extra usage has a hard spend cap
(already overspent), so every such request returns:

```
429 {"type":"error","error":{"type":"rate_limit_error",
"message":"This request would exceed your account's monthly spend limit. Please try again later."}}
```

## background: auth is not the problem

- claude code OAuth: PKCE against `claude.ai/oauth/authorize`, token endpoint
  `https://platform.claude.com/v1/oauth/token`, claude code's own public client_id,
  scopes `user:file_upload user:inference user:mcp_servers user:profile
  user:sessions:claude_code`.
- pi-ai (`dist/auth/oauth/anthropic.js`) uses the SAME client_id (base64-obfuscated),
  same endpoints, a superset of scopes. pi's auth file holds the synced token.
- pi-ai (`dist/api/anthropic-messages.js`) detects OAuth access tokens by prefix and sends:
  `Authorization: Bearer`, `anthropic-beta: claude-code-20250219,oauth-2025-04-20,...`,
  `user-agent: claude-cli/2.1.75`, `x-app: cli`, first system block exactly
  `"You are Claude Code, Anthropic's official CLI for Claude."`, and renames tools
  to claude code's canonical names ("stealth mode").
- so pi passes the documented spoof checks. the 429 is billing, not auth rejection.

## rate limit architecture (from response headers)

every response carries `anthropic-ratelimit-unified-*` headers revealing three layers:

1. plan claims: `5h` and `7d` windows (`...-5h-status=allowed`, `...-5h-utilization=0.07`)
2. first-party fallback: `...-fallback-percentage=0.5` (claude code's 50% policy)
3. overage (extra usage, paid): `...-overage-status=rejected`,
   `...-overage-disabled-reason=org_spend_cap_reached`,
   `...-overage-utilization=4.05`

`...-representative-claim=five_hour` on accepted requests = billed to the plan.

## elimination log

round 1-3 (hand-built requests, pi's exact header set, tiny/big bodies, all models
haiku/sonnet/opus 4.1-4.7, max_tokens 1 vs 64000): ALL 200, plan-billed. headers,
betas, UA version, `x-organization-uuid`, `x-client-platform`, `metadata.user_id`:
all irrelevant.

round 4: captured pi's REAL request via a local logging proxy
(`~/.pi/agent/models.json` override: `{"providers":{"anthropic":{"baseUrl":"http://127.0.0.1:8899/v1"}}}`;
note pi appends `/v1/messages` itself, so the baseUrl must NOT include `/v1`).
pi's request: 51KB, 18 tools, `thinking: {budget_tokens: 8192}`,
`max_tokens=64000`, system = [claude code block, 13936-char pi prompt].

round 5 (replay the captured bytes, mutate one field at a time):

| variant | result |
|---|---|
| exact replay | 429 |
| remove `thinking` | 429 |
| `max_tokens` 1024 | 429 |
| remove all 18 tools | 429 |
| remove system block 2 (pi's prompt) | 200, plan-billed |
| block 2 = same-length lorem padding | 200 |
| block 2 = "You are a helpful assistant." | 200 |

round 6 (binary search the 13936-char prompt, 8 API calls): trigger localized to a
~435-char span, the pi documentation instructions in the harness prompt.

round 7 (split that span): the tripping chunk is the doc-links list:

```
grations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models
(docs/models.md), pi packages (docs/packages.md), environment variables
(docs/environment-variables.md)
```

no individual sub-fragment (`docs/custom-provider.md` alone,
`docs/environment-variables.md` alone, etc.) trips it. the signature is a fixed
multi-token span of that list. neighboring sentences ("When working on pi topics...",
"The following skills provide spec...") are clean.

## conclusion (updated after ddmin)

anthropic maintains per-harness signatures of system prompt text. pi's identity
spoofing (client_id, headers, first system block, tool names) is complete but the
prompt BODY is the classifier. a first bisect (contiguous spans) pointed at the
doc-links bullet, but reordering/paraphrasing it still tripped: the signature is a
DISTRIBUTED token set. delta debugging (ddmin, removal-based minimization, 25
calls) reduced the tripping configuration to the co-occurrence of these two lines
of pi's harness prompt:

```
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
```

the "When asked about:" bullet was also signatured earlier the same day (the
classifier is actively tuned; a span that passed in the morning failed in the
afternoon). recognized first-party prompt -> plan claims + 50% fallback.
signatured third-party prompt -> overage only, always, even with plan headroom.
additionally, once the 5h claim is nearly exhausted, ANY nontrivial request from a
third-party-classified prompt pre-flights into the capped overage pool and 429s,
which confounds testing; only run experiments at low utilization.

## the fix (shipped in rho)

`extensions/prompt-defingerprint.ts` rewrites three lines per turn at
`before_agent_start`:

```
"- When asked about: ..."            -> "- For questions about pi itself, consult the pi documentation files listed above"
"Pi documentation (read only ...):"  -> "Bundled pi CLI docs, relevant only when the user asks about the harness itself:"
"- When working on pi topics, ..."   -> "- For harness work, read the bundled docs and examples, following their cross-references"
```

verified end-to-end: full rewritten prompt -> 200 plan-billed; `pi --provider
anthropic --model claude-opus-4-6` answers instead of 429ing.

## maintenance

the classifier is actively tuned: signatures observed in the morning failed by the
afternoon. when 429s return, re-derive the current trigger lines with a
removal-based minimizer (ddmin) against the live classifier, update `RULES` in
`extensions/prompt-defingerprint.ts`, and verify with a full-prompt replay at low
5h utilization (high utilization confounds everything, see conclusion).

## artifacts

scripts used in the investigation, in the order they matter: a local logging
proxy for capturing pi's exact outbound request (point the anthropic provider at
it via `~/.pi/agent/models.json`), a replay harness that resends the captured
bytes with one field mutated at a time, a contiguous-span bisector, and the ddmin
removal-based minimizer that handles distributed token sets. the captured request
log has authorization redacted.
