package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.Econ;
import com.hivecraft.overlay.core.Guard;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;

import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * One in-flight economy request with inline feedback: while busy the view greys its button; the answer shows as a
 * status line (green ✔ / red ✖ with the bridge's sentence) and as a screen toast. Callbacks run on the client thread.
 */
public final class Act {
    private volatile boolean busy;
    private String msg;
    private int color;
    private long at;

    public boolean busy() { return busy; }

    /** True while a status line is showing (busy, or an answer younger than 8 s). */
    public boolean active(long now) { return msg != null && (busy || now - at <= 8000); }

    /**
     * Starts {@code call}; {@code okText} turns the success answer into a message; {@code onOk} runs after success.
     * Ignored while a previous request is still running.
     */
    public void run(EconHost host, String doing, CompletableFuture<Econ.Result> call, Function<Econ.Result, String> okText, Consumer<Econ.Result> onOk) {
        if (busy) return;
        busy = true;
        msg = doing;
        color = Gfx.MUTED;
        at = System.currentTimeMillis();
        call.whenComplete((r, e) -> MinecraftClient.getInstance().execute(() -> {
            busy = false;
            Guard.get().run("econ.ui", () -> {
                at = System.currentTimeMillis();
                if (e != null || r == null) {
                    show(host, "✖ " + (e != null ? e.getMessage() : "no answer"), Gfx.BAD);
                    EconGfx.soundFail();
                    return;
                }
                if (r.ok()) {
                    String t = okText == null ? "done" : okText.apply(r);
                    if (r.note() != null) t += " · " + r.note();
                    show(host, "✔ " + t, Gfx.GOOD);
                    EconGfx.soundOk();
                    Inv.invalidate();
                    if (onOk != null) onOk.accept(r);
                } else {
                    show(host, "✖ " + r.error(), Gfx.BAD);
                    EconGfx.soundFail();
                }
            });
        }));
    }

    /** Local validation error (nothing sent). */
    public void error(EconHost host, String text) {
        show(host, "✖ " + text, Gfx.BAD);
        at = System.currentTimeMillis();
        EconGfx.soundFail();
    }

    private void show(EconHost host, String text, int c) {
        msg = text;
        color = c;
        if (host != null) host.toast(text, c);
    }

    /** Draws the status line (fades after 8 s; a spinner while busy). */
    public void render(Ui ui, int x, int y, int w, long now) {
        if (msg == null) return;
        if (busy) {
            String spin = "◐◓◑◒".charAt((int) (now / 120 % 4)) + " ";
            ui.g.drawText(ui.tr, Gfx.fit(ui.tr, spin + msg, w), x, y, Gfx.MUTED, false);
            return;
        }
        long age = now - at;
        if (age > 8000) return;
        double a = UiMath.fade(age, 8000, 80, 1200);
        Gfx.textA(ui.g, ui.tr, Gfx.fit(ui.tr, msg, w), x, y, color, a);
    }
}
