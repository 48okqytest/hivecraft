package com.hivecraft.overlay.screen;

import com.hivecraft.overlay.ui.HiveUI;
import com.hivecraft.overlay.ui.UiConfig;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.hud.HudRenderer;
import com.hivecraft.overlay.ui.layout.HudLayout;
import com.hivecraft.overlay.ui.layout.HudLayout.Rect;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.text.Text;

import java.util.Map;

/**
 * Drag the HUD panels around. The live HUD renders underneath (in editing mode, so empty panels
 * show placeholders); each panel snaps to the nearest of 9 anchors on drop and is saved.
 */
public final class HudEditScreen extends Screen {
    private final Screen parent;
    private String dragging;
    private double grabDx, grabDy;
    private final Ui ui = new Ui();

    public HudEditScreen(Screen parent) {
        super(Text.literal("Move HUD"));
        this.parent = parent;
    }

    @Override
    protected void init() {
        HiveUI.hud().setEditing(true);
    }

    @Override
    public boolean shouldPause() {
        return false;
    }

    @Override
    public void renderBackground(DrawContext g, int mouseX, int mouseY, float delta) {
        // keep the game + live HUD visible
    }

    @Override
    public void render(DrawContext g, int mouseX, int mouseY, float delta) {
        HudRenderer hud = HiveUI.hud();
        float sc = hud.lastScale();
        // anchor guides (thirds)
        for (int i = 1; i < 3; i++) {
            g.fill(width * i / 3, 0, width * i / 3 + 1, height, 0x20FFFFFF);
            g.fill(0, height * i / 3, width, height * i / 3 + 1, 0x20FFFFFF);
        }
        // keep-clear zones
        for (Rect k : HudLayout.vanillaKeepClear(width, height)) {
            g.fill(k.x(), k.y(), k.right(), k.bottom(), 0x30FF4545);
        }
        ui.begin(g, textRenderer, mouseX, mouseY);
        for (Map.Entry<String, Rect> e : hud.lastRects().entrySet()) {
            Rect r = e.getValue();
            int x = (int) (r.x() * sc), y = (int) (r.y() * sc), w = (int) (r.w() * sc), h = (int) (r.h() * sc);
            boolean hv = mouseX >= x && mouseX < x + w && mouseY >= y && mouseY < y + h;
            boolean drag = e.getKey().equals(dragging);
            int c = drag ? Gfx.GOLD : hv ? 0xFFFFFFFF : 0xA0FFC24A;
            g.drawBorder(x - 1, y - 1, w + 2, h + 2, c);
            String label = e.getKey() + " · " + UiConfig.get().placement(e.getKey()).anchor().name().toLowerCase().replace('_', ' ');
            int lw = textRenderer.getWidth(label) + 6;
            int ly = y - 11 < 0 ? y + h + 1 : y - 11;
            g.fill(x - 1, ly, x - 1 + lw, ly + 10, 0xE0101420);
            g.drawText(textRenderer, label, x + 2, ly + 1, c, false);
        }
        String help = "Drag panels · they snap to the nearest corner/edge · Esc: done";
        int hw = textRenderer.getWidth(help) + 12;
        int hy = height / 2 + 40;
        g.fill((width - hw) / 2, hy, (width + hw) / 2, hy + 14, 0xE0101420);
        g.drawText(textRenderer, help, (width - hw) / 2 + 6, hy + 3, Gfx.TEXT, false);
        ui.button((width - 80) / 2, hy + 18, 80, 14, "Reset layout", Gfx.INFO, true, () -> {
            UiConfig.get().resetLayout();
            UiConfig.get().save();
        }, null);
        ui.end();
    }

    @Override
    public boolean mouseClicked(double mx, double my, int button) {
        if (ui.click(mx, my)) return true;
        HudRenderer hud = HiveUI.hud();
        float sc = hud.lastScale();
        for (Map.Entry<String, Rect> e : hud.lastRects().entrySet()) {
            Rect r = e.getValue();
            if (mx >= r.x() * sc && mx < r.right() * sc && my >= r.y() * sc && my < r.bottom() * sc) {
                dragging = e.getKey();
                grabDx = mx / sc - r.x();
                grabDy = my / sc - r.y();
                return true;
            }
        }
        return super.mouseClicked(mx, my, button);
    }

    @Override
    public boolean mouseDragged(double mx, double my, int button, double dx, double dy) {
        if (dragging == null) return false;
        HudRenderer hud = HiveUI.hud();
        float sc = hud.lastScale();
        Rect r = hud.lastRects().get(dragging);
        if (r == null) return false;
        int sw = (int) Math.floor(width / sc), sh = (int) Math.floor(height / sc);
        Rect moved = HudLayout.clamp(new Rect((int) Math.round(mx / sc - grabDx), (int) Math.round(my / sc - grabDy), r.w(), r.h()), sw, sh);
        UiConfig.get().setPlacement(dragging, HudLayout.fromRect(moved, sw, sh));
        return true;
    }

    @Override
    public boolean mouseReleased(double mx, double my, int button) {
        if (dragging != null) {
            dragging = null;
            UiConfig.get().save();
            return true;
        }
        return super.mouseReleased(mx, my, button);
    }

    @Override
    public void close() {
        HiveUI.hud().setEditing(false);
        UiConfig.get().save();
        client.setScreen(parent);
    }

    @Override
    public void removed() {
        HiveUI.hud().setEditing(false);
    }
}
