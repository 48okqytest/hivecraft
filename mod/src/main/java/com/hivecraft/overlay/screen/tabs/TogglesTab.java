package com.hivecraft.overlay.screen.tabs;

import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveConfig;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.HudEditScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.UiConfig;
import com.hivecraft.overlay.ui.draw.Gfx;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;

import java.util.Locale;
import java.util.function.Consumer;
import java.util.function.Function;

/** Every overlay switch in one place: HUD (mine), terminal, world overlays (ModWorld's HiveConfig fields), camera. */
public final class TogglesTab implements Tab {
    private int scroll = 0, contentH = 0, viewH = 0;

    @Override public String title() { return "Toggles"; }
    @Override public String icon() { return "⚙"; }

    @Override
    public void render(ControlScreen s, Ui ui, ControlScreen.Area a, long now, float delta) {
        DrawContext g = ui.g;
        UiConfig u = UiConfig.get();
        HiveConfig w = Hive.config();
        int colW = (a.w() - 12) / 3;
        int c1 = a.x(), c2 = a.x() + colW + 6, c3 = a.x() + 2 * (colW + 6);
        int top = a.y() - scroll;
        viewH = a.h();
        int rowW = colW - 6;

        g.enableScissor(a.x() - 2, a.y(), a.right() + 2, a.bottom());
        // ---- HUD
        int y = section(ui, "HUD", c1, top);
        y = tog(ui, c1, y, rowW, "HUD visible", u.hud, v -> u.hud = v, "also: J key");
        y = tog(ui, c1, y, rowW, "Team panel", u.team, v -> u.team = v, null);
        y = tog(ui, c1, y, rowW, "Compact bot rows", u.compact, v -> u.compact = v, "one line per bot");
        y = tog(ui, c1, y, rowW, "Show bot thoughts", u.showThoughts, v -> u.showThoughts = v, null);
        y = tog(ui, c1, y, rowW, "Goal line", u.goal, v -> u.goal = v, null);
        y = tog(ui, c1, y, rowW, "Build progress", u.builds, v -> u.builds = v, null);
        y = tog(ui, c1, y, rowW, "Event ticker", u.ticker, v -> u.ticker = v, null);
        y = tog(ui, c1, y, rowW, "  · chat", u.tickerChat, v -> u.tickerChat = v, null);
        y = tog(ui, c1, y, rowW, "  · blocks placed/broken", u.tickerBlocks, v -> u.tickerBlocks = v, null);
        y = tog(ui, c1, y, rowW, "  · tasks", u.tickerTasks, v -> u.tickerTasks = v, null);
        y = tog(ui, c1, y, rowW, "  · deaths & events", u.tickerEvents, v -> u.tickerEvents = v, null);
        y = tog(ui, c1, y, rowW, "  · economy", u.tickerEcon, v -> u.tickerEcon = v, "bought / sold / outbid / won");
        y = tog(ui, c1, y, rowW, "Coin balance chip", u.econChip, v -> u.econChip = v, "next to the team panel (economy: V)");
        ui.stepper(c1, y, rowW, "HUD scale", String.format(Locale.ROOT, "%.2fx", u.hudScale),
                () -> { u.hudScale = Math.max(0.5f, u.hudScale - 0.125f); u.save(); },
                () -> { u.hudScale = Math.min(2f, u.hudScale + 0.125f); u.save(); });
        y += 13;
        ui.stepper(c1, y, rowW, "Panel opacity", Math.round(u.panelOpacity * 100) + "%",
                () -> { u.panelOpacity = Math.max(0.2f, u.panelOpacity - 0.08f); u.save(); },
                () -> { u.panelOpacity = Math.min(1f, u.panelOpacity + 0.08f); u.save(); });
        y += 13;
        ui.stepper(c1, y, rowW, "Ticker time", u.tickerSeconds + "s",
                () -> { u.tickerSeconds = Math.max(3, u.tickerSeconds - 1); u.save(); },
                () -> { u.tickerSeconds = Math.min(60, u.tickerSeconds + 1); u.save(); });
        y += 15;
        int bx = c1;
        bx += ui.button(bx, y, "Move HUD…", Gfx.GOLD, () -> MinecraftClient.getInstance().setScreen(new HudEditScreen(s)), "drag the panels where you want them") + 4;
        ui.button(bx, y, "Reset layout", Gfx.INFO, () -> { u.resetLayout(); u.save(); s.toast("HUD layout reset", Gfx.GOOD); }, null);
        int end1 = y + 16;

        // ---- World (ModWorld's settings)
        y = section(ui, "WORLD", c2, top);
        y = wtog(ui, c2, y, rowW, "World overlay", c -> c.worldOverlay, (c, v) -> c.worldOverlay = v, "also: O key");
        y = wtog(ui, c2, y, rowW, "Bot labels", c -> c.labels, (c, v) -> c.labels = v, null);
        y = wtog(ui, c2, y, rowW, "  · through walls", c -> c.labelsThroughWalls, (c, v) -> c.labelsThroughWalls = v, null);
        y = wtog(ui, c2, y, rowW, "  · health bars", c -> c.labelBars, (c, v) -> c.labelBars = v, null);
        y = wtog(ui, c2, y, rowW, "  · held item", c -> c.labelHeldItem, (c, v) -> c.labelHeldItem = v, null);
        y = wtog(ui, c2, y, rowW, "Bot outlines", c -> c.outlines, (c, v) -> c.outlines = v, null);
        y = wtog(ui, c2, y, rowW, "Trails", c -> c.trails, (c, v) -> c.trails = v, null);
        y = wtog(ui, c2, y, rowW, "Planned paths", c -> c.pathLines, (c, v) -> c.pathLines = v, null);
        y = wtog(ui, c2, y, rowW, "Target beacons", c -> c.targetBeacon, (c, v) -> c.targetBeacon = v, null);
        y = wtog(ui, c2, y, rowW, "Action effects", c -> c.actionFx, (c, v) -> c.actionFx = v, null);
        y = wtog(ui, c2, y, rowW, "Waypoints", c -> c.waypoints, (c, v) -> c.waypoints = v, null);
        y = wtog(ui, c2, y, rowW, "Ghost builds", c -> c.ghosts, (c, v) -> c.ghosts = v, null);
        y = wtog(ui, c2, y, rowW, "  · show placed blocks", c -> c.ghostShowDone, (c, v) -> c.ghostShowDone = v, null);
        y = wtog(ui, c2, y, rowW, "Block attribution", c -> c.ledger, (c, v) -> c.ledger = v, "who placed/broke what");
        y = wtog(ui, c2, y, rowW, "  · placed", c -> c.ledgerPlaced, (c, v) -> c.ledgerPlaced = v, null);
        y = wtog(ui, c2, y, rowW, "  · broken", c -> c.ledgerBroken, (c, v) -> c.ledgerBroken = v, null);
        y = wtog(ui, c2, y, rowW, "  · crosshair tooltip", c -> c.ledgerTooltip, (c, v) -> c.ledgerTooltip = v, null);
        int end2 = y;

        // ---- Terminal, camera, bridge
        y = section(ui, "TERMINAL", c3, top);
        y = tog(ui, c3, y, rowW, "Team chat in terminal", u.terminalShowsChat, v -> u.terminalShowsChat = v, null);
        y = tog(ui, c3, y, rowW, "CRT scanlines", u.crt, v -> u.crt = v, null);
        ui.stepper(c3, y, rowW, "Opacity", Math.round(u.terminalOpacity * 100) + "%",
                () -> { u.terminalOpacity = Math.max(0.4f, u.terminalOpacity - 0.06f); u.save(); },
                () -> { u.terminalOpacity = Math.min(1f, u.terminalOpacity + 0.06f); u.save(); });
        y += 18;
        y = section(ui, "SPECTATE CAMERA", c3, y);
        ui.stepper(c3, y, rowW, "Distance", Math.round(u.spectateDistance) + "m",
                () -> { u.spectateDistance = Math.max(2, u.spectateDistance - 1); u.save(); },
                () -> { u.spectateDistance = Math.min(24, u.spectateDistance + 1); u.save(); });
        y += 13;
        ui.stepper(c3, y, rowW, "Height", Math.round(u.spectateHeight) + "m",
                () -> { u.spectateHeight = Math.max(0, u.spectateHeight - 1); u.save(); },
                () -> { u.spectateHeight = Math.min(16, u.spectateHeight + 1); u.save(); });
        y += 18;
        y = section(ui, "BRIDGE", c3, y);
        Gfx.text(g, ui.tr, Gfx.fit(ui.tr, w.httpBase(), rowW), c3, y, Gfx.MUTED);
        y += 11;
        String st = Hive.state().connection().name().toLowerCase(Locale.ROOT);
        String err = Hive.state().lastError();
        Gfx.text(g, ui.tr, Gfx.fit(ui.tr, st + (err != null && !err.isBlank() && !Hive.state().online() ? " · " + err : ""), rowW), c3, y,
                Hive.state().online() ? Gfx.GOOD : Gfx.WARN);
        y += 12;
        bx = c3;
        bx += ui.button(bx, y, "Reconnect", Gfx.INFO, () -> { if (Hive.client() != null) Hive.client().reconnectNow(); }, null) + 4;
        ui.button(bx, y, "Reload config", Gfx.INFO, () -> { Hive.reloadConfig(); s.toast("config/hivecraft.json reloaded", Gfx.GOOD); }, "re-read config/hivecraft.json");
        int end3 = y + 16;
        g.disableScissor();

        contentH = Math.max(end1, Math.max(end2, end3)) - top;
        scroll = Tab.clampScroll(scroll, contentH, viewH);
    }

    private static int section(Ui ui, String title, int x, int y) {
        Gfx.text(ui.g, ui.tr, title, x, y + 1, Gfx.GOLD);
        ui.g.fill(x, y + 11, x + ui.tr.getWidth(title) + 30, y + 12, 0x60FFC24A);
        return y + 16;
    }

    private static int tog(Ui ui, int x, int y, int w, String label, boolean value, Consumer<Boolean> set, String tip) {
        ui.toggle(x, y, w, label, value, v -> {
            set.accept(v);
            UiConfig.get().save();
        }, tip);
        return y + 12;
    }

    private interface Setter { void set(HiveConfig c, boolean v); }

    private static int wtog(Ui ui, int x, int y, int w, String label, Function<HiveConfig, Boolean> get, Setter set, String tip) {
        HiveConfig c = Hive.config();
        ui.toggle(x, y, w, label, get.apply(c), v -> {
            set.set(Hive.config(), v);
            Hive.saveConfig();
        }, tip);
        return y + 12;
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        scroll = Tab.clampScroll(scroll - (int) (v * 20), contentH, viewH);
        return true;
    }
}
