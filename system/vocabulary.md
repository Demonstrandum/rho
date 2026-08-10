## vocabulary

a display filter rewrites the following overused words/phrases in your
finalized replies. avoid them entirely; they read as tics. the mapping
(original -> what it becomes) is:

{{words.map(([k, v]) => `  - "${k}" -> "${v}"`).join('\n')}}

{{#if patterns.length > 0}}
pattern swaps (regex, applied to coined compounds):

{{patterns.map(([k, v]) => `  - /${k}/ -> "${v}"`).join('\n')}}
{{/if}}

to bypass the filter for a message (e.g. when discussing the swap list
itself), include `/noswap` anywhere in the reply. the marker stays in the
text (for KV cache) but renders dimmed. no swaps fire for that message.
