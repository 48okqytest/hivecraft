package com.hivecraft.overlay.ui.hud;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Ghost;
import com.hivecraft.overlay.core.Goal;
import com.hivecraft.overlay.core.Guard;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveState;
import com.hivecraft.overlay.ui.UiConfig;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.layout.HudLayout;
import com.hivecraft.overlay.ui.layout.HudLayout.Rect;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.render.RenderTickCounter;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The in-game HUD: team panel (bot cards), goal line, build progress, event ticker and the
 * connection badge. Every panel is anchored (see {@link HudLayout}), scales with GUI scale and the
 * HUD scale setting, keeps clear of the crosshair/hotbar/status effects, and animates smoothly.
 */
public final class HudRenderer {

    public static final int CARD_W = 156;

    private final Ticker ticker;
    /** Last frame's panel rects in HUD space (for the layout editor). */
    private final Map<String, Rect> lastRects = new LinkedHashMap<>();
    private float lastScale = 1f;
    private final Map<String, Anim> anims = new HashMap<>();
    private long lastFrame = 0;
    private boolean editing = false;

    /** Smoothed per-bot values. */
    private static final class Anim {
        double health = -1, food = -1, progress = -1, appear = 0;
    }

    public HudRenderer(Ticker ticker) {
        this.ticker = ticker;
    }

    public Map<String, Rect> lastRects() { return lastRects; }
    public float lastScale() { return lastScale; }
    public void setEditing(boolean e) { editing = e; }
    public boolean editing() { return editing; }

    // ------------------------------------------------------------------ entry

    public void render(DrawContext g, RenderTickCounter tick) {
        MinecraftClient mc = MinecraftClient.getInstance();
        UiConfig cfg = UiConfig.get();
        if (mc.options.hudHidden || mc.player == null) return;
        if (!cfg.hud && !editing) {
            // even with the HUD off, say when the bridge is down (small, unobtrusive)
            if (!Hive.state().online()) drawStatusBadge(g, mc.textRenderer, 4, 4, System.currentTimeMillis(), 0.8);
            return;
        }
        long now = System.currentTimeMillis();
        double dt = lastFrame == 0 ? 0 : Math.min(0.25, (now - lastFrame) / 1000.0);
        lastFrame = now;

        float scale = cfg.hudScale;
        lastScale = scale;
        int sw = (int) Math.floor(g.getScaledWindowWidth() / scale);
        int sh = (int) Math.floor(g.getScaledWindowHeight() / scale);
        var m = g.getMatrices();
        m.push();
        m.scale(scale, scale, 1);
        try {
            List<Rect> keep = keepClear(mc, sw, sh, scale);
            lastRects.clear();
            TextRenderer tr = mc.textRenderer;
            HiveState st = Hive.state();
            boolean debug = mc.getDebugHud().shouldShowDebugHud();

            Guard guard = Guard.get();
            if ((cfg.team || editing) && !debug) guard.run("hud.team", () -> drawTeam(g, tr, cfg, st, mc, sw, sh, keep, now, dt));
            else if (!st.online()) {
                Rect r = HudLayout.resolve(cfg.placement(UiConfig.TEAM), 120, 14, sw, sh, keep);
                drawStatusBadge(g, tr, r.x(), r.y(), now, 1);
            }
            if ((cfg.goal || editing) && !debug) guard.run("hud.goal", () -> drawGoal(g, tr, cfg, st, sw, sh, keep, now));
            if ((cfg.builds || editing) && !debug) guard.run("hud.builds", () -> drawBuilds(g, tr, cfg, st, sw, sh, keep, now));
            if (cfg.ticker || editing) guard.run("hud.ticker", () -> drawTicker(g, tr, cfg, sw, sh, keep, now));
        } finally {
            m.pop();
        }
    }

    /** Zones the HUD keeps clear, in HUD space. */
    private static List<Rect> keepClear(MinecraftClient mc, int sw, int sh, float scale) {
        List<Rect> keep = new ArrayList<>(HudLayout.vanillaKeepClear(sw, sh));
        // the vanilla zones are in GUI units; when the HUD scale isn't 1 they are re-derived in HUD units
        if (scale != 1f) {
            int gw = (int) (sw * scale), gh = (int) (sh * scale);
            keep.clear();
            for (Rect r : HudLayout.vanillaKeepClear(gw, gh)) {
                keep.add(new Rect((int) Math.floor(r.x() / scale), (int) Math.floor(r.y() / scale),
                        (int) Math.ceil(r.w() / scale) + 1, (int) Math.ceil(r.h() / scale) + 1));
            }
        }
        int effects = mc.player == null ? 0 : mc.player.getStatusEffects().size();
        if (effects > 0) {
            int w = (int) Math.ceil(Math.min(effects, 8) * 25 / scale) + 4;
            keep.add(new Rect(sw - w, 0, w, (int) Math.ceil(52 / scale)));
        }
        return keep;
    }

    // ------------------------------------------------------------------ team

    private void drawTeam(DrawContext g, TextRenderer tr, UiConfig cfg, HiveState st, MinecraftClient mc,
                          int sw, int sh, List<Rect> keep, long now, double dt) {
        List<BotState> bots = st.bots();
        boolean compact = cfg.compact;
        int headerH = 14;
        int cardH = cardHeight(cfg);
        int rowH = 12;
        int gap = 3;
        int n = bots.size();
        int bodyH = n == 0 ? 14 : (compact ? n * rowH + 4 : n * (cardH + gap) + 2);
        // auto-compact when the cards would take more than ~60% of the screen height
        if (!compact && headerH + bodyH > sh * 0.6) {
            compact = true;
            bodyH = n * rowH + 4;
        }
        int w = compact ? 150 : CARD_W + 6;
        int h = headerH + bodyH;
        Rect r = HudLayout.resolve(cfg.placement(UiConfig.TEAM), w, h, sw, sh, keep);
        lastRects.put(UiConfig.TEAM, r);
        double op = cfg.panelOpacity;
        Gfx.panel(g, r.x(), r.y(), r.w(), r.h(), -1, op, 1);

        // header: HIVE · n online · status light
        int online = 0;
        for (BotState b : bots) if (b.online()) online++;
        Gfx.header(g, tr, r.x(), r.y(), r.w(), "⬢ HIVE", Gfx.GOLD, 1);
        String sub = st.online() ? (n == 0 ? "" : online + "/" + n + " online")
                : st.connection() == HiveState.Connection.CONNECTING ? "connecting…" : "offline";
        int subX = r.x() + 5 + tr.getWidth("⬢ HIVE") + 6;
        Gfx.text(g, tr, sub, subX, r.y() + 3, st.online() ? Gfx.MUTED : Gfx.WARN);
        drawConnLight(g, tr, r.right() - 6, r.y() + 3, st, now);

        if (n == 0) {
            String msg = st.online() ? "no bots yet" : statusText(st);
            Gfx.text(g, tr, Gfx.fit(tr, msg, w - 10), r.x() + 5, r.y() + headerH + 3, Gfx.FAINT);
            return;
        }
        String focus = Hive.focusedBot();
        int y = r.y() + headerH + 1;
        for (BotState b : bots) {
            Anim a = anims.computeIfAbsent(b.name(), k -> new Anim());
            a.appear = UiMath.approach(a.appear, 1, dt, 6);
            a.health = a.health < 0 ? b.health() : UiMath.approach(a.health, b.health(), dt, 8);
            a.food = a.food < 0 ? b.food() : UiMath.approach(a.food, b.food(), dt, 8);
            double target = b.hasProgress() ? b.progressFraction() : -1;
            a.progress = target < 0 ? -1 : (a.progress < 0 ? target : UiMath.approach(a.progress, target, dt, 6));
            boolean focused = b.name().equalsIgnoreCase(focus == null ? "" : focus);
            if (compact) {
                drawBotRow(g, tr, mc, b, a, r.x() + 2, y + 1, w - 4, focused, now);
                y += rowH;
            } else {
                int slide = (int) Math.round((1 - UiMath.easeOutCubic(a.appear)) * -20);
                drawBotCard(g, tr, mc, cfg, b, a, r.x() + 3 + slide, y + 1, CARD_W, cardH, focused, now);
                y += cardH + gap;
            }
        }
    }

    private static int cardHeight(UiConfig cfg) {
        return cfg.showThoughts ? 54 : 44;
    }

    private void drawBotCard(DrawContext g, TextRenderer tr, MinecraftClient mc, UiConfig cfg, BotState b, Anim a,
                             int x, int y, int w, int h, boolean focused, long now) {
        double alpha = UiMath.easeOutCubic(a.appear) * (b.online() ? 1 : 0.55);
        int color = b.color() & 0xFFFFFF;
        int accent = 0xFF000000 | color;
        // card body
        int bg = b.dead() ? 0x3A1010 : Gfx.BG2;
        g.fill(x, y, x + w, y + h, UiMath.rgbA(bg, (int) (170 * alpha)));
        g.fill(x, y, x + 2, y + h, UiMath.withAlpha(accent, alpha));
        g.fillGradient(x + 2, y, x + 40, y + h, UiMath.rgbA(color, (int) (34 * alpha)), UiMath.rgbA(color, 0));
        if (focused) {
            double p = 0.6 + 0.4 * Math.sin(now / 260.0);
            int fc = UiMath.withAlpha(accent, p * alpha);
            g.fill(x, y - 1, x + w, y, fc);
            g.fill(x, y + h, x + w, y + h + 1, fc);
            g.fill(x + w - 1, y, x + w, y + h, fc);
        }

        // row 1: name, role · distance + arrow
        int tx = x + 6;
        Gfx.textA(g, tr, b.name(), tx, y + 3, accent, alpha);
        int nx = tx + tr.getWidth(b.name()) + 4;
        if (b.role() != null && !b.role().isBlank()) Gfx.textA(g, tr, Gfx.fit(tr, b.role(), 46), nx, y + 3, Gfx.FAINT, alpha);
        drawDistance(g, tr, mc, b, x + w - 4, y + 3, alpha, now);

        // row 2: health + food bars, held item at right
        int barY = y + 14;
        int barW = (w - 34) / 2;
        double hp = Math.max(0, a.health) / 20.0;
        Gfx.bar(g, tx, barY, barW, 5, hp, UiMath.healthColor(hp), 10, alpha);
        Gfx.bar(g, tx + barW + 4, barY, barW, 5, Math.max(0, a.food) / 20.0, 0xFFE0A040, 10, alpha);
        if (b.health() <= 6 && b.online() && !b.dead()) {
            // low health flash
            double f = 0.5 + 0.5 * Math.sin(now / 110.0);
            g.fill(tx - 1, barY - 1, tx + barW + 1, barY, UiMath.withAlpha(Gfx.BAD, f * alpha));
        }
        if (b.held() != null && alpha > 0.3) Gfx.item(g, b.held(), x + w - 20, y + 12, 16);

        // row 3: action (+ progress)
        int ay = y + 23;
        String act;
        int actColor;
        if (b.dead()) { act = "☠ dead"; actColor = Gfx.BAD; }
        else if (!b.online()) { act = "offline"; actColor = Gfx.FAINT; }
        else if (b.idle()) { act = "idle"; actColor = Gfx.MUTED; }
        else { act = b.actionText(); actColor = Gfx.TEXT; }
        String busy = !b.idle() && b.busyMs() > 3000 && b.online() ? " " + UiMath.formatDuration(b.busyMs()) : "";
        int bw = tr.getWidth(busy);
        Gfx.textA(g, tr, Gfx.fit(tr, act, w - 30 - bw), tx, ay, actColor, alpha);
        if (!busy.isEmpty()) Gfx.textA(g, tr, busy, x + w - 26 - bw, ay, Gfx.FAINT, alpha);
        int py = ay + 10;
        if (a.progress >= 0) {
            Gfx.bar(g, tx, py, w - 12, 3, a.progress, accent, 0, alpha);
        } else if (!b.idle() && b.online() && !b.dead()) {
            Gfx.busyBar(g, tx, py, w - 12, 3, UiMath.withAlpha(accent, 0.8), now, alpha);
        } else {
            g.fill(tx, py + 1, tx + w - 12, py + 2, UiMath.rgbA(0xFFFFFF, (int) (14 * alpha)));
        }

        // row 4: claimed task (or thought)
        int ty = py + 5;
        if (b.taskTitle() != null && !b.taskTitle().isBlank() && ty + 8 <= y + h) {
            Gfx.textA(g, tr, "▸ " + Gfx.fit(tr, b.taskTitle(), w - 20), tx, ty, 0xFFD6B25E, alpha);
            ty += 10;
        }
        if (cfg.showThoughts && b.thought() != null && !b.thought().isBlank() && ty + 8 <= y + h) {
            Gfx.textA(g, tr, "“" + Gfx.fit(tr, b.thought(), w - 22) + "”", tx, ty, Gfx.FAINT, alpha);
        }
    }

    private void drawBotRow(DrawContext g, TextRenderer tr, MinecraftClient mc, BotState b, Anim a, int x, int y, int w,
                            boolean focused, long now) {
        double alpha = b.online() ? 1 : 0.55;
        int accent = 0xFF000000 | (b.color() & 0xFFFFFF);
        if (focused) g.fill(x, y - 1, x + w, y + 10, UiMath.withAlpha(accent, 0.18));
        g.fill(x + 1, y + 1, x + 3, y + 8, accent);
        // tiny health pip column
        double hp = Math.max(0, a.health) / 20.0;
        g.fill(x + 4, y + 8 - (int) Math.round(7 * hp), x + 5, y + 8, UiMath.healthColor(hp));
        int tx = x + 8;
        Gfx.textA(g, tr, b.name(), tx, y + 1, accent, alpha);
        int ax = tx + Math.max(34, tr.getWidth(b.name()) + 4);
        String act = b.dead() ? "☠ dead" : !b.online() ? "offline" : b.idle() ? "idle" : b.actionText();
        if (a.progress >= 0) act += " " + Math.round(a.progress * 100) + "%";
        Gfx.textA(g, tr, Gfx.fit(tr, act, w - (ax - x) - 30), ax, y + 1, b.idle() ? Gfx.MUTED : Gfx.TEXT, alpha);
        drawDistance(g, tr, mc, b, x + w - 1, y + 1, alpha, now);
    }

    /** Right-aligned "37m" + direction arrow at (rightX, y). */
    private static void drawDistance(DrawContext g, TextRenderer tr, MinecraftClient mc, BotState b, int rightX, int y,
                                     double alpha, long now) {
        if (mc.player == null || !b.online()) return;
        String myDim = mc.world == null ? "overworld" : dimName(mc);
        if (b.dim() != null && !b.dim().equals(myDim)) {
            String s = b.dim();
            Gfx.textA(g, tr, s, rightX - tr.getWidth(s), y, Gfx.FAINT, alpha);
            return;
        }
        double bx = b.lerpX(now), by = b.lerpY(now), bz = b.lerpZ(now);
        double d = UiMath.dist(mc.player.getX(), mc.player.getY(), mc.player.getZ(), bx, by, bz);
        String s = UiMath.formatDistance(d);
        int tw = tr.getWidth(s);
        Gfx.textA(g, tr, s, rightX - tw - 9, y, Gfx.MUTED, alpha);
        double rel = UiMath.relativeBearing(mc.player.getX(), mc.player.getZ(), mc.player.getYaw(), bx, bz);
        int c = UiMath.withAlpha(d < 6 ? Gfx.GOOD : 0xFFDDE3EE, alpha);
        Gfx.arrow(g, rightX - 3.5f, y + 3.5f, (float) rel, 7, c);
    }

    public static String dimName(MinecraftClient mc) {
        if (mc.world == null) return "overworld";
        String id = mc.world.getRegistryKey().getValue().getPath();
        return switch (id) {
            case "the_nether" -> "nether";
            case "the_end" -> "end";
            default -> id;
        };
    }

    private static void drawConnLight(DrawContext g, TextRenderer tr, int rightX, int y, HiveState st, long now) {
        HiveState.Connection c = st.connection();
        int col = c == HiveState.Connection.ONLINE ? Gfx.GOOD : c == HiveState.Connection.CONNECTING ? Gfx.WARN : Gfx.BAD;
        String label = c == HiveState.Connection.ONLINE ? "LIVE" : c == HiveState.Connection.CONNECTING ? "…" : "OFF";
        int lw = tr.getWidth(label);
        Gfx.text(g, tr, label, rightX - lw, y, UiMath.withAlpha(col, 0.9));
        Gfx.dot(g, rightX - lw - 6, y + 2, col, now, c != HiveState.Connection.OFFLINE);
    }

    private static String statusText(HiveState st) {
        return switch (st.connection()) {
            case ONLINE -> "Hivecraft: live";
            case CONNECTING -> "Hivecraft: connecting…";
            case OFFLINE -> "Hivecraft: offline" + (st.lastError() != null && !st.lastError().isBlank() ? " (" + UiMath.ellipsize(st.lastError(), 40) + ")" : "");
        };
    }

    /** Small badge for the bridge status (used when the team panel is hidden). */
    private static void drawStatusBadge(DrawContext g, TextRenderer tr, int x, int y, long now, double alpha) {
        HiveState st = Hive.state();
        String s = st.connection() == HiveState.Connection.CONNECTING ? "Hivecraft: connecting…" : "Hivecraft: offline";
        int w = tr.getWidth(s) + 16;
        Gfx.panel(g, x, y, w, 14, -1, 0.7, alpha);
        int col = st.connection() == HiveState.Connection.CONNECTING ? Gfx.WARN : Gfx.BAD;
        Gfx.dot(g, x + 5, y + 6, col, now, true);
        Gfx.textA(g, tr, s, x + 11, y + 3, Gfx.TEXT, alpha);
    }

    // ------------------------------------------------------------------ goal

    private void drawGoal(DrawContext g, TextRenderer tr, UiConfig cfg, HiveState st, int sw, int sh, List<Rect> keep, long now) {
        Goal goal = st.goal();
        String text = goal == null || goal.text() == null || goal.text().isBlank() ? (editing ? "(no goal set)" : null) : goal.text();
        if (text == null) return;
        String label = "GOAL";
        int maxW = Math.min(300, sw - 40);
        String body = Gfx.fit(tr, text, maxW - tr.getWidth(label) - 18);
        int w = tr.getWidth(label) + tr.getWidth(body) + 18;
        String by = goal != null && goal.by() != null && !goal.by().isBlank() ? "set by " + goal.by() + " · " + UiMath.formatAge(now - goal.ts()) + " ago" : "";
        int h = by.isEmpty() ? 14 : 23;
        w = Math.max(w, tr.getWidth(by) + 12);
        Rect r = HudLayout.resolve(cfg.placement(UiConfig.GOAL), w, h, sw, sh, keep);
        lastRects.put(UiConfig.GOAL, r);
        Gfx.panel(g, r.x(), r.y(), r.w(), r.h(), -1, cfg.panelOpacity, 1);
        // gold label chip
        int lw = tr.getWidth(label) + 6;
        g.fill(r.x() + 2, r.y() + 2, r.x() + 2 + lw, r.y() + 12, 0xFF3A2C0E);
        Gfx.text(g, tr, label, r.x() + 5, r.y() + 3, Gfx.GOLD);
        Gfx.text(g, tr, body, r.x() + 2 + lw + 5, r.y() + 3, Gfx.TEXT);
        if (!by.isEmpty()) Gfx.text(g, tr, by, r.x() + 5, r.y() + 13, Gfx.FAINT);
    }

    // ------------------------------------------------------------------ builds

    private void drawBuilds(DrawContext g, TextRenderer tr, UiConfig cfg, HiveState st, int sw, int sh, List<Rect> keep, long now) {
        List<Ghost> list = new ArrayList<>();
        for (Ghost gh : st.ghosts()) {
            if (gh.finished() && !editing) continue;
            list.add(gh);
            if (list.size() >= 5) break;
        }
        if (list.isEmpty() && !editing) return;
        int w = 150;
        int rowH = 21;
        int h = 14 + Math.max(1, list.size()) * rowH + 2;
        Rect r = HudLayout.resolve(cfg.placement(UiConfig.BUILDS), w, h, sw, sh, keep);
        lastRects.put(UiConfig.BUILDS, r);
        Gfx.panel(g, r.x(), r.y(), r.w(), r.h(), -1, cfg.panelOpacity, 1);
        Gfx.header(g, tr, r.x(), r.y(), r.w(), "▦ BUILDS", Gfx.INFO, 1);
        if (list.isEmpty()) {
            Gfx.text(g, tr, "no builds running", r.x() + 5, r.y() + 17, Gfx.FAINT);
            return;
        }
        int y = r.y() + 15;
        for (Ghost gh : list) {
            BotState owner = gh.bot() == null ? null : st.bot(gh.bot());
            int accent = owner != null ? 0xFF000000 | owner.color() : Gfx.INFO;
            String name = UiMath.prettyId(gh.blueprint() == null ? gh.id() : gh.blueprint());
            boolean preview = gh.isPreview();
            String tag = preview ? "preview" : gh.progress() + "%";
            int tagW = tr.getWidth(tag);
            g.fill(r.x() + 3, y + 1, r.x() + 5, y + 18, accent);
            Gfx.text(g, tr, Gfx.fit(tr, name, w - tagW - 18), r.x() + 8, y + 1, Gfx.TEXT);
            Gfx.text(g, tr, tag, r.right() - 5 - tagW, y + 1, preview ? Gfx.INFO : Gfx.GOLD);
            if (preview) {
                // dashed bar
                for (int dx = 0; dx < w - 14; dx += 6) g.fill(r.x() + 8 + dx, y + 12, r.x() + 8 + Math.min(dx + 3, w - 14), y + 14, 0x805CC8FF);
            } else {
                Gfx.bar(g, r.x() + 8, y + 11, w - 14, 4, gh.progress() / 100.0, accent, 0, 1);
            }
            String who = gh.bots() != null && !gh.bots().isEmpty() ? String.join(", ", gh.bots()) : (gh.bot() == null ? "" : gh.bot());
            String counts = preview ? who : gh.done() + "/" + gh.total() + (who.isEmpty() ? "" : " · " + who);
            // tiny caption under the bar, only if it fits in the row
            if (rowH >= 21) {
                var mtx = g.getMatrices();
                mtx.push();
                mtx.translate(r.x() + 8, y + 16, 0);
                mtx.scale(0.5f, 0.5f, 1);
                g.drawText(tr, Gfx.fit(tr, counts, (w - 14) * 2), 0, 0, Gfx.MUTED, false);
                mtx.pop();
            }
            y += rowH;
        }
    }

    // ------------------------------------------------------------------ ticker

    private void drawTicker(DrawContext g, TextRenderer tr, UiConfig cfg, int sw, int sh, List<Rect> keep, long now) {
        ticker.setLife(cfg.tickerSeconds * 1000L);
        List<Ticker.Entry> list = ticker.visible(now);
        int max = 7;
        if (list.size() > max) list = list.subList(list.size() - max, list.size());
        int rowH = 12;
        int w = 210;
        int h = Math.max(1, list.size()) * rowH + 2;
        Rect r = HudLayout.resolve(cfg.placement(UiConfig.TICKER), w, editing ? Math.max(h, 40) : h, sw, sh, keep);
        lastRects.put(UiConfig.TICKER, r);
        if (editing && list.isEmpty()) {
            Gfx.panel(g, r.x(), r.y(), r.w(), r.h(), -1, 0.4, 1);
            Gfx.text(g, tr, "event ticker", r.x() + 5, r.y() + 4, Gfx.FAINT);
            return;
        }
        boolean rightAligned = cfg.placement(UiConfig.TICKER).anchor().hx == 2;
        // newest at the bottom; grows upward when anchored to the bottom
        boolean bottom = cfg.placement(UiConfig.TICKER).anchor().vy == 2;
        int y = bottom ? r.bottom() - rowH : r.y() + 1;
        for (int i = list.size() - 1; i >= 0; i--) {
            Ticker.Entry e = list.get(i);
            double a = e.alpha(now, ticker.life());
            if (a <= 0.02) { y += bottom ? -rowH : rowH; continue; }
            int textW = 0;
            for (var s : e.segs) textW += Gfx.width(tr, s, s.text());
            boolean icon = e.icon != null && !Gfx.stack(e.icon).isEmpty();
            int ew = Math.min(w, textW + 10 + (icon ? 11 : 0));
            int ex = rightAligned ? r.right() - ew : r.x();
            // slide in from the side on appear
            double in = UiMath.easeOutCubic(UiMath.clamp01((now - e.born) / 300.0));
            int slide = (int) Math.round((1 - in) * 14) * (rightAligned ? 1 : -1);
            ex += slide;
            g.fill(ex, y, ex + ew, y + rowH - 1, UiMath.rgbA(Gfx.BG, (int) (150 * a * cfg.panelOpacity / 0.72)));
            g.fill(rightAligned ? ex + ew - 2 : ex, y, rightAligned ? ex + ew : ex + 2, y + rowH - 1, UiMath.withAlpha(0xFF000000 | e.accent, a));
            int tx = ex + 5;
            if (icon) {
                Gfx.item(g, e.icon, tx - 1, y + 1, 9);
                tx += 11;
            }
            Gfx.segs(g, tr, e.segs, tx, y + 2, a, true);
            y += bottom ? -rowH : rowH;
        }
    }
}
