// the next frame of an animation that draws only when it is rendered.
//
// an animation here paints inside a render patch and asks for the frame after
// from there, so a frame that is not drawn (the field hidden, the condition
// gone) asks for nothing and the animation stops by itself. one pending timer
// per animation: a request for a later frame than the one already pending is
// dropped, and an earlier one replaces it.

interface Renderer {
    requestRender(): void;
}

export class FrameTimer {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private due = Infinity;

    request(tui: Renderer, ms: number): void {
        const due = Date.now() + ms;
        if (this.timer !== undefined && this.due <= due) return;
        this.cancel();
        this.due = due;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.due = Infinity;
            tui.requestRender();
        }, ms);
        this.timer.unref?.();
    }

    cancel(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = undefined;
        this.due = Infinity;
    }
}
