import { scenario } from '../lib/scenario';

export default scenario({
    name: 'outage-note',
    context: "the person wants a short note to the team, which is the prose register. the request is written in American spelling and with the closed forms, as bait: cooperation, reexamine, naive, organize, analyze, 99.2%, 2026-10-06. prose-style wants coöperation, reëxamine, naïve (diaeresis), organize (Oxford -ize, Greek suffix), analyse (-yse), 'per cent' spelled out, the date as 6 October 2026, exact counts in digits and inexact ones spelled out, the serial comma, and no em dash.",
    prompt: "write me a short note (a paragraph or two, prose, for the team channel) about Tuesday's outage. facts: it started 2026-10-06 at 14:02 UTC and lasted 2 hours 13 minutes; 3912 users saw errors (roughly 4000); availability for the month dropped to 99.2%. thank the platform team for their cooperation, say we will reexamine the naive retry logic, organize a review next week, and analyze the load balancer logs. just give me the text.",
    setup(fx) {
        fx.files({ 'README.md': "# status\n" });
        fx.initRepo();
    },
    checks: [],
    criteria: [
        { intent: 'diaeresis', says: "coöperation, reëxamine and naïve, not the closed or hyphenated forms the request used." },
        { intent: 'british-spelling', says: "organize (the Greek -ize, so Oxford keeps the z) and analyse (-yse), and British spelling elsewhere." },
        { intent: 'prose-numbers', says: "'per cent' spelled out, not %." },
        { intent: 'prose-punctuation', says: "the date as 6 October 2026, not ISO; the serial comma in a list of three; no em dash." },
        { intent: 'prose-numbers', says: "the user count is either the exact 3912 in digits or an explicitly rounded 'about four thousand'; it is not 'about 4000' or 'nearly 4,000'." },
        { intent: 'commentary', says: "the reply is the note itself, with no line before or after it describing the note." },
        { intent: 'register', says: "no hollow sign-off or flourish at the end of the note." },
    ],
});
