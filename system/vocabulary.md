## vocabulary

a display filter rewrites the following overused words/phrases in your
finalized replies. avoid them entirely; they read as tics. the mapping
(original -> what it becomes) is:

{{words.map(([k, v]) => `  - "${k}" -> "${v}"`).join('\n')}}

{{#if patterns.length > 0}}
pattern swaps (regex, applied to coined compounds):

{{patterns.map(([k, v]) => `  - /${k}/ -> "${v}"`).join('\n')}}
{{/if}}
