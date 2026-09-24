// the footer as it was last drawn.
//
// the theme picker shows a session, and a session has a footer: the working
// directory, the branch, the spend, the model. pi's FooterComponent is built
// from an AgentSession and a footer data provider, neither of which an
// extension is handed, so the picker cannot construct one. what it can do is
// show the one already on screen: footer.ts renders the real footer on every
// frame, and leaves its lines here.
//
// so the footer in the preview is the session's own footer, with its own
// numbers, drawn by the renderer that draws it for real and in the theme being
// previewed, one frame behind at worst. a session with no rho footer leaves
// nothing here and the picker shows no footer rather than a drawing of one.
//
// the lines live on globalThis, because /reload replaces both modules and the
// writer and the reader would otherwise hold two copies of this one.

const MIRROR = '__rho_footer_mirror';

interface Mirror {
    lines: readonly string[];
}

function mirror(): Mirror {
    const shared = globalThis as typeof globalThis & { [MIRROR]?: Mirror };
    return (shared[MIRROR] ??= { lines: [] });
}

export function publishFooter(lines: readonly string[]): void {
    mirror().lines = lines;
}

export function lastFooter(): readonly string[] {
    return mirror().lines;
}
