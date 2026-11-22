package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.screen.tabs.Tab;
import com.hivecraft.overlay.ui.draw.Gfx;
import net.minecraft.client.gui.DrawContext;

import java.util.List;

/** A scrollable grid of the player's inventory items (summed per id); click one to pick it. */
public final class InvPicker {
    public static final int SLOT = 18;
    private int scroll, contentH, viewH;
    private int x, y, w, h;
    private String selected;

    public String selected() { return selected; }

    public void select(String id) { selected = id; }

    /** Drops the selection when the item left the inventory. */
    public void validate() {
        if (selected != null && Inv.count(selected) <= 0) selected = null;
    }

    public void render(Ui ui, int x, int y, int w, int h, Runnable onPick) {
        this.x = x; this.y = y; this.w = w; this.h = h;
        DrawContext g = ui.g;
        List<Inv.Entry> items = Inv.items();
        g.fill(x, y, x + w, y + h, 0x80080B10);
        g.drawBorder(x, y, w, h, 0x602A3242);
        if (items.isEmpty()) {
            g.drawCenteredTextWithShadow(ui.tr, "inventory empty", x + w / 2, y + h / 2 - 4, Gfx.FAINT);
            return;
        }
        int cols = Math.max(1, (w - 4) / SLOT);
        int rows = (items.size() + cols - 1) / cols;
        contentH = rows * SLOT;
        viewH = h - 4;
        scroll = Tab.clampScroll(scroll, contentH, viewH);
        int ox = x + 2 + ((w - 4) - cols * SLOT) / 2;
        g.enableScissor(x + 1, y + 1, x + w - 1, y + h - 1);
        for (int i = 0; i < items.size(); i++) {
            Inv.Entry e = items.get(i);
            int sx = ox + (i % cols) * SLOT, sy = y + 2 + (i / cols) * SLOT - scroll;
            if (sy + SLOT < y || sy > y + h) continue;
            boolean hv = ui.hover(sx, sy, SLOT, SLOT) && ui.hover(x, y, w, h);
            boolean sel = e.id().equals(selected);
            EconGfx.slot(g, sx, sy, SLOT, hv, sel);
            EconGfx.item(g, ui.tr, e.id(), sx + 1, sy + 1, e.count());
            if (e.risky()) g.fill(sx + 1, sy + 1, sx + 4, sy + 4, 0xFFFF5252);
            if (sy >= y && sy + SLOT <= y + h) {
                String tip = EconGfx.name(e.id()) + " × " + e.count() + (e.risky() ? "  ⚠ enchants/damage/names are lost" : "");
                ui.region(sx, sy, SLOT, SLOT, () -> { selected = e.id(); EconGfx.soundClick(); if (onPick != null) onPick.run(); }, tip);
            }
        }
        g.disableScissor();
        if (contentH > viewH) {
            int bh = Math.max(8, viewH * viewH / contentH);
            int by = y + 2 + (viewH - bh) * scroll / Math.max(1, contentH - viewH);
            g.fill(x + w - 3, by, x + w - 1, by + bh, 0x80FFFFFF);
        }
    }

    public boolean scrolled(double mx, double my, double v) {
        if (mx < x || mx >= x + w || my < y || my >= y + h) return false;
        scroll = Tab.clampScroll(scroll - (int) (v * SLOT), contentH, viewH);
        return true;
    }
}
