package com.hivecraft.overlay.screen.tabs;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.TerminalScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.HiveUI;
import com.hivecraft.overlay.ui.SpectateCam;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.hud.HudRenderer;
import com.hivecraft.overlay.ui.layout.HudLayout;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;

import java.util.List;

/** Bot cards with actions: stop, come, follow, spectate camera, focus, status in terminal. */
public final class BotsTab implements Tab {
    private int scroll = 0;
    private int contentH = 0, viewH = 0;

    @Override public String title() { return "Bots"; }
    @Override public String icon() { return "☺"; }

    @Override
    public void render(ControlScreen s, Ui ui, ControlScreen.Area a, long now, float delta) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        MinecraftClient mc = MinecraftClient.getInstance();
        List<BotState> bots = Hive.state().bots();

        // team-wide actions
        int x = a.x();
        Gfx.text(g, tr, "TEAM", x, a.y() + 3, Gfx.FAINT);
        x += tr.getWidth("TEAM") + 8;
        x += ui.button(x, a.y(), "■ Stop all", Gfx.BAD, () -> s.command("stop all"), "stop every bot's current action") + 4;
        x += ui.button(x, a.y(), "⇣ Come all", Gfx.INFO, () -> s.command("come all"), "everyone walks to you") + 4;
        x += ui.button(x, a.y(), "Builds", Gfx.GOLD, () -> s.command("builds"), "running builds (output in terminal)") + 4;
        if (SpectateCam.active()) {
            ui.button(x, a.y(), "◉ Stop watching " + SpectateCam.target(), Gfx.WARN, SpectateCam::stop, null);
        }

        int top = a.y() + 20;
        viewH = a.h() - 20;
        if (bots.isEmpty()) {
            Gfx.text(g, tr, Hive.state().online() ? "No bots on the team yet." : "Not connected to the bridge (127.0.0.1:47960).", a.x(), top + 6, Gfx.MUTED);
            return;
        }
        int gap = 6;
        int cols = HudLayout.columns(a.w(), 168, gap, bots.size());
        int cw = (a.w() - gap * (cols - 1)) / cols;
        int chh = 92;
        int rows = (bots.size() + cols - 1) / cols;
        contentH = rows * (chh + gap);
        scroll = Tab.clampScroll(scroll, contentH, viewH);
        String focus = Hive.focusedBot();
        g.enableScissor(a.x() - 1, top, a.right() + 1, a.bottom());
        for (int i = 0; i < bots.size(); i++) {
            int cx = a.x() + (i % cols) * (cw + gap);
            int cy = top + (i / cols) * (chh + gap) - scroll;
            if (cy > a.bottom() || cy + chh < top) continue;
            card(s, ui, mc, bots.get(i), cx, cy, cw, chh, focus, now);
        }
        g.disableScissor();
        if (contentH > viewH) {
            int th = Math.max(10, viewH * viewH / contentH);
            int ty = top + (viewH - th) * scroll / Math.max(1, contentH - viewH);
            g.fill(a.right() - 2, ty, a.right(), ty + th, 0x80FFFFFF);
        }
    }

    private void card(ControlScreen s, Ui ui, MinecraftClient mc, BotState b, int x, int y, int w, int h, String focus, long now) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        int accent = 0xFF000000 | b.color();
        boolean focused = b.name().equalsIgnoreCase(focus == null ? "" : focus);
        g.fill(x, y, x + w, y + h, 0xC0141A24);
        g.fillGradient(x, y, x + w, y + 18, UiMath.withAlpha(accent, 0.35), UiMath.withAlpha(accent, 0.05));
        g.fill(x, y, x + 2, y + h, accent);
        if (focused) g.drawBorder(x, y, w, h, UiMath.withAlpha(accent, 0.7 + 0.3 * Math.sin(now / 250.0)));

        // header
        Gfx.text(g, tr, b.name(), x + 6, y + 5, 0xFFFFFFFF);
        int nx = x + 10 + tr.getWidth(b.name());
        if (b.role() != null) Gfx.text(g, tr, Gfx.fit(tr, b.role(), w - (nx - x) - 60), nx, y + 5, 0xFFCFD6E2);
        String st = b.dead() ? "dead" : b.online() ? "online" : (b.status() == null ? "offline" : b.status());
        int sc = b.dead() ? Gfx.BAD : b.online() ? Gfx.GOOD : Gfx.FAINT;
        int sw = tr.getWidth(st);
        Gfx.text(g, tr, st, x + w - 6 - sw, y + 5, sc);
        Gfx.dot(g, x + w - 12 - sw, y + 7, sc, now, b.online());

        // vitals + held
        int vy = y + 22;
        double hp = b.health() / 20.0;
        Gfx.text(g, tr, "♥", x + 6, vy, 0xFFFF6B6B);
        Gfx.bar(g, x + 15, vy + 1, 50, 6, hp, UiMath.healthColor(hp), 10, 1);
        Gfx.text(g, tr, String.valueOf(Math.round(b.health())), x + 68, vy, Gfx.MUTED);
        Gfx.text(g, tr, "≋", x + 84, vy, 0xFFE0A040);
        Gfx.bar(g, x + 93, vy + 1, 40, 6, b.food() / 20.0, 0xFFE0A040, 10, 1);
        if (b.held() != null) {
            Gfx.item(g, b.held(), x + w - 22, y + 20, 16);
            if (ui.hover(x + w - 22, y + 20, 16, 16)) ui.tooltip(UiMath.prettyId(b.held()));
        }

        // action + progress
        int ay = y + 34;
        String act = b.dead() ? "☠ dead" : !b.online() ? "offline" : b.idle() ? "idle" : b.actionText();
        Gfx.text(g, tr, Gfx.fit(tr, act, w - 12), x + 6, ay, b.idle() ? Gfx.MUTED : Gfx.TEXT);
        if (b.hasProgress()) Gfx.bar(g, x + 6, ay + 10, w - 12, 3, b.progressFraction(), accent, 0, 1);
        else if (!b.idle() && b.online()) Gfx.busyBar(g, x + 6, ay + 10, w - 12, 3, accent, now, 1);

        // task + where
        int ty = ay + 16;
        String task = b.taskTitle() != null ? "▸ " + b.taskTitle() : "no task";
        Gfx.text(g, tr, Gfx.fit(tr, task, w - 12), x + 6, ty, b.taskTitle() != null ? 0xFFD6B25E : Gfx.FAINT);
        String where = b.bx() + " " + b.by() + " " + b.bz();
        if (mc.player != null && b.online() && b.dim().equals(HudRenderer.dimName(mc))) {
            double d = UiMath.dist(mc.player.getX(), mc.player.getY(), mc.player.getZ(), b.x(), b.y(), b.z());
            where += "  · " + UiMath.formatDistance(d) + " " + UiMath.compass(b.x() - mc.player.getX(), b.z() - mc.player.getZ());
        } else if (!b.dim().equals(HudRenderer.dimName(mc))) where += "  · " + b.dim();
        Gfx.text(g, tr, Gfx.fit(tr, where, w - 12), x + 6, ty + 10, Gfx.FAINT);

        // buttons
        int by = y + h - 16;
        int bx = x + 5;
        String n = b.name();
        boolean on = b.online();
        int bw = (w - 10 - 4 * 3) / 5;
        ui.button(bx, by, bw, 13, "Stop", Gfx.BAD, on, () -> s.command("stop " + n), "stop " + n + "'s current action");
        bx += bw + 3;
        ui.button(bx, by, bw, 13, "Come", Gfx.INFO, on, () -> s.command("come " + n), n + " walks to you");
        bx += bw + 3;
        ui.button(bx, by, bw, 13, "Follow", Gfx.INFO, on, () -> s.command("follow " + n), n + " follows you (Stop ends it)");
        bx += bw + 3;
        boolean watching = n.equalsIgnoreCase(SpectateCam.target() == null ? "" : SpectateCam.target());
        ui.button(bx, by, bw, 13, watching ? "Back" : "Watch", Gfx.GOLD, on || watching,
                () -> s.closeAndRun(() -> SpectateCam.toggle(n)), "spectate camera behind " + n + " (press again to return)");
        bx += bw + 3;
        ui.button(bx, by, bw, 13, focused ? "Unfocus" : "Focus", 0xFFBA68C8, true,
                () -> Hive.setFocusedBot(focused ? null : n), "highlight " + n + " in the HUD and world");
        // click the name → status in terminal
        ui.region(x + 4, y + 2, tr.getWidth(n) + 4, 12, () -> s.closeAndRun(() -> {
            MinecraftClient.getInstance().setScreen(new TerminalScreen(HiveUI.terminal()));
            HiveUI.terminal().submit("status " + n);
        }), "status " + n + " in the terminal");
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        scroll = Tab.clampScroll(scroll - (int) (v * 24), contentH, viewH);
        return true;
    }
}
