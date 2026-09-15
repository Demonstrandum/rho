/**
 * The model a session on another machine starts on.
 *
 * A remote session is `pi --mode rpc` started by a shell command over ssh, and
 * pi with no model named resolves its own default: every session opened on the
 * far side's default model whatever the interface that created it was set to,
 * and the only way back was /model once it was running. The interface hands
 * over what it is on, the way a local session picks up the settings of the
 * machine it starts in.
 *
 * Both halves of that live here: the flags are written on the laptop and read
 * on the host, and a disagreement between the two is a session that silently
 * keeps the wrong model.
 */

/** What an interface is running, as the far side needs to be told it. */
export interface ModelChoice {
    readonly provider: string;
    readonly id: string;
    readonly thinking: string;
}

/**
 * Only names made of the characters a model name is made of.
 *
 * This text becomes a word in an unquoted shell command on another machine.
 */
const NAME = /^[A-Za-z0-9._\/-]+$/;
const LEVEL = /^[a-z]+$/;

/** The arguments that name a model, or none when the choice cannot be written safely. */
export function modelFlags(choice: ModelChoice | null): readonly string[] {
    if (choice === null) return [];
    const named = `${choice.provider}/${choice.id}`;
    if (!NAME.test(named) || !LEVEL.test(choice.thinking)) return [];
    return ['--model', named, '--thinking', choice.thinking];
}

/**
 * The same arguments with the model taken out, for a session that already has one.
 *
 * A session being continued has a model of its own -- whatever /model last set,
 * on either side -- and a flag would overrule that choice every time the
 * session was started again.
 */
export function withoutModelFlags(args: readonly string[]): string[] {
    const kept: string[] = [];
    for (let at = 0; at < args.length; at += 1) {
        const argument = args[at] as string;
        if (argument === '--model' || argument === '--thinking') {
            at += 1;
            continue;
        }
        kept.push(argument);
    }
    return kept;
}
