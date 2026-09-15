/**
 * Which machine runs a slash command typed into a remote session.
 *
 * pi's interface does not dispatch extension commands itself: it hands the text
 * to `session.prompt`, and the session runs the command before deciding the
 * text is for the model. In a remote client `prompt` is a call to the far side,
 * so every command went there and the client's own were unreachable: `/theme`
 * changed the colours of a process with no terminal, and `/exit` reached the
 * model as a prompt.
 *
 * Both sides have commands, and neither side is right for all of them. What
 * decides is where the thing being commanded is. The colours, the stash, the
 * prompt history and the pager are this terminal's; the files, the checkpoints
 * and the conversation are the session's. Commands are named here by the side
 * that owns them, since nothing in a command's registration says.
 */

export type Side = 'here' | 'there';

export interface CommandKnowledge {
    /** commands registered in the client process. */
    readonly here: ReadonlySet<string>;
    /** commands the far side reported, extensions, prompt templates and skills alike. */
    readonly there: ReadonlySet<string>;
    /** of the commands both sides have, the ones that belong to this terminal. */
    readonly keepHere: ReadonlySet<string>;
}

/** The command a line names, or null when the line is not a command. */
export function commandName(text: string): string | null {
    if (!text.startsWith('/')) return null;
    const cut = text.search(/\s/);
    const name = cut === -1 ? text.slice(1) : text.slice(1, cut);
    return name === '' ? null : name;
}

/**
 * Where a submitted line runs.
 *
 * Anything that is not a command goes to the session, which is the machine the
 * agent is on. A command known only to one side runs on that side. A command
 * both sides have runs on the far side unless it is named as this terminal's,
 * because the session is what a command usually acts on.
 */
export function whereToRun(text: string, knowledge: CommandKnowledge): Side {
    const name = commandName(text);
    if (name === null) return 'there';
    if (knowledge.here.has(name) && knowledge.keepHere.has(name)) return 'here';
    if (knowledge.there.has(name)) return 'there';
    return knowledge.here.has(name) ? 'here' : 'there';
}
