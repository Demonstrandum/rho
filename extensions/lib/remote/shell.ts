/**
 * Say a command in a shell the far side is certain to read.
 *
 * ssh hands its command string to the account's login shell, and that shell is
 * not ours to choose: fish, csh and rc do not read POSIX syntax, so `R=$(...)`
 * is a syntax error there rather than an assignment. Every script sent from
 * here is POSIX sh, so it names sh rather than trusting whatever the account
 * happens to log in with.
 */
export const shQuote = (text: string): string => `'${text.split("'").join(`'\\''`)}'`;

export const posix = (script: string): string => `sh -c ${shQuote(script)}`;
