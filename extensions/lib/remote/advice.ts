/**
 * What to do about a remote session that would not open.
 *
 * The client writes its reason and exits, and the interface it was launched
 * from redraws the screen the moment it returns, so the reason is gone before
 * it can be read: connecting to a stopped session looked like being bounced
 * straight back with nothing said.
 *
 * Each reason gets the one thing worth doing about it, named as a command that
 * can be typed rather than as a description of the problem.
 */

export interface Trouble {
    /** what the client said, cleaned of blank lines. */
    readonly reason: string;
    /** the command to try, when one would help. */
    readonly advice: string | null;
}

const RULES: readonly { readonly when: RegExp; readonly advice: (name: string, host: string) => string }[] = [
    {
        when: /no session called/i,
        advice: (name, host) => `/remote connect ${name} ${host} starts it again, and keeps what it said before`,
    },
    {
        when: /has no session runner/i,
        advice: (name, host) => `/remote create ${name} ${host} installs what it needs`,
    },
    {
        when: /does not exist on this machine/i,
        advice: (name, host) => `/remote create ${name} ${host}:<a directory that is there>`,
    },
    {
        when: /Permission denied|Host key verification|Could not resolve hostname|Connection refused|timed out/i,
        advice: (_name, host) => `ssh ${host} true says whether this machine can reach it at all`,
    },
    {
        when: /the link closed/i,
        advice: (name, host) => `/remote list ${host} says whether ${name} is still there`,
    },
];

/** The last thing the client said, which is the thing it stopped for. */
export function lastSaid(output: string): string {
    const lines = output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    return lines[lines.length - 1] ?? '';
}

export function troubleWith(output: string, name: string, host: string): Trouble {
    const reason = lastSaid(output);
    if (reason === '') {
        return { reason: `${name} on ${host} closed without saying why`, advice: `/remote list ${host}` };
    }
    const rule = RULES.find((candidate) => candidate.when.test(reason));
    return { reason, advice: rule === undefined ? null : rule.advice(name, host) };
}
