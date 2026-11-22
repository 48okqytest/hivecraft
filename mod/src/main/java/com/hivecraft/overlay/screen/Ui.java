package com.hivecraft.overlay.screen;

import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * Tiny immediate-mode widget kit for the custom-drawn screens: widgets draw themselves during
 * render and register a hit region; the screen's mouseClicked dispatches to the last frame's hits.
 */
public final class Ui {
    public record Hit(int x, int y, int w, int h, Runnable action, String tooltip) {
        boolean contains(double mx, double my) { return mx >= x && mx < x + w && my >= y && my < y + h; }
    }

    private final List<Hit> hits = new ArrayList<>();
    private final List<Hit> next = new ArrayList<>();
    public int mx, my;
    public TextRenderer tr;
    public DrawContext g;
    private String tooltip;

    /** Start a frame. */
    public void begin(DrawContext g, TextRenderer tr, int mx, int my) {
        this.g = g;
        this.tr = tr;
        this.mx = mx;
        this.my = my;
        next.clear();
        tooltip = null;
    }

    /** End a frame: publish hits; draws a tooltip if hovering one. */
    public void end() {
        hits.clear();
        hits.addAll(next);
        if (tooltip != null && !tooltip.isEmpty()) {
            int w = tr.getWidth(tooltip) + 8;
            int x = Math.min(mx + 10, g.getScaledWindowWidth() - w - 2), y = my - 14;
            var m = g.getMatrices();
            m.push();
            m.translate(0, 0, 400);
            g.fill(x, y, x + w, y + 12, 0xF0101420);
            g.drawBorder(x, y, w, 12, 0xFF3A4458);
            g.drawText(tr, tooltip, x + 4, y + 2, Gfx.TEXT, false);
            m.pop();
        }
    }

    public boolean click(double x, double y) {
        // last registered = drawn on top → check in reverse
        for (int i = hits.size() - 1; i >= 0; i--) {
            Hit h = hits.get(i);
            if (h.contains(x, y)) {
                if (h.action() != null) h.action().run();
                return true;
            }
        }
        return false;
    }

    public boolean hover(int x, int y, int w, int h) {
        return mx >= x && mx < x + w && my >= y && my < y + h;
    }

    public void region(int x, int y, int w, int h, Runnable action, String tip) {
        next.add(new Hit(x, y, w, h, action, tip));
        if (tip != null && hover(x, y, w, h)) tooltip = tip;
    }

    public void tooltip(String t) {
        tooltip = t;
    }

    /** Flat button with accent; returns its width. */
    public int button(int x, int y, int w, int h, String label, int accent, boolean enabled, Runnable action, String tip) {
        boolean hv = enabled && hover(x, y, w, h);
        int bg = !enabled ? 0x60202530 : hv ? UiMath.withAlpha(accent, 0.35) : 0xA0181D28;
        g.fill(x, y, x + w, y + h, bg);
        g.fill(x, y + h - 1, x + w, y + h, enabled ? UiMath.withAlpha(accent, hv ? 1 : 0.6) : 0x40FFFFFF);
        int tw = tr.getWidth(label);
        g.drawText(tr, label, x + (w - tw) / 2, y + (h - 8) / 2, enabled ? (hv ? 0xFFFFFFFF : Gfx.TEXT) : Gfx.FAINT, false);
        if (enabled) region(x, y, w, h, action, tip);
        return w;
    }

    /** Button sized to its label. */
    public int button(int x, int y, String label, int accent, Runnable action, String tip) {
        return button(x, y, tr.getWidth(label) + 10, 14, label, accent, true, action, tip);
    }

    /** Switch row: "label ......... [■ ON]". */
    public void toggle(int x, int y, int w, String label, boolean value, Consumer<Boolean> set, String tip) {
        boolean hv = hover(x, y, w, 12);
        if (hv) g.fill(x - 2, y - 1, x + w + 2, y + 11, 0x30FFFFFF);
        g.drawText(tr, label, x, y + 1, value ? Gfx.TEXT : Gfx.MUTED, false);
        int sx = x + w - 20;
        g.fill(sx, y + 1, sx + 20, y + 9, value ? 0xFF1E6E3A : 0xFF2A303C);
        int kx = value ? sx + 11 : sx + 1;
        g.fill(kx, y + 2, kx + 8, y + 8, value ? Gfx.GOOD : 0xFF8A93A3);
        region(x - 2, y - 1, w + 4, 12, () -> set.accept(!value), tip);
    }

    /** "label  [-] value [+]". */
    public void stepper(int x, int y, int w, String label, String value, Runnable minus, Runnable plus) {
        g.drawText(tr, label, x, y + 1, Gfx.TEXT, false);
        int bx = x + w - 60;
        button(bx, y - 1, 12, 11, "-", Gfx.INFO, true, minus, null);
        int vw = tr.getWidth(value);
        g.drawText(tr, value, bx + 12 + (36 - vw) / 2, y + 1, Gfx.GOLD, false);
        button(bx + 48, y - 1, 12, 11, "+", Gfx.INFO, true, plus, null);
    }

    /** Selectable chip; returns width. */
    public int chip(int x, int y, String label, int accent, boolean selected, Runnable action) {
        int w = tr.getWidth(label) + 8;
        boolean hv = hover(x, y, w, 12);
        g.fill(x, y, x + w, y + 12, selected ? UiMath.withAlpha(accent, 0.45) : hv ? 0x50FFFFFF : 0x80181D28);
        if (selected) g.fill(x, y + 11, x + w, y + 12, accent);
        g.drawText(tr, label, x + 4, y + 2, selected ? 0xFFFFFFFF : Gfx.MUTED, false);
        region(x, y, w, 12, action, null);
        return w;
    }
}
