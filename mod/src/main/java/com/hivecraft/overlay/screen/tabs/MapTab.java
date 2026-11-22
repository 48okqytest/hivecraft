package com.hivecraft.overlay.screen.tabs;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Ghost;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveState;
import com.hivecraft.overlay.core.PathInfo;
import com.hivecraft.overlay.core.TrailStore;
import com.hivecraft.overlay.core.Waypoint;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.hud.HudRenderer;
import com.hivecraft.overlay.ui.layout.MapProjection;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;

import java.util.List;

/**
 * Live top-down team map drawn from the streamed state: chunk grid, build footprints with
 * progress, waypoints, fading trails, planned paths, bots (heading ticks), you. Drag to pan,
 * wheel to zoom around the cursor, click a bot to focus it, "Center" to snap back.
 */
public final class MapTab implements Tab {
    private static final MapProjection proj = new MapProjection();
    private static boolean followMe = true;   // keep centred on the player (or the focused bot) until dragged
    private boolean dragging;
    private ControlScreen.Area area;

    @Override public String title() { return "Map"; }
    @Override public String icon() { return "⌖"; }

    @Override
    public void render(ControlScreen s, Ui ui, ControlScreen.Area a, long now, float delta) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        MinecraftClient mc = MinecraftClient.getInstance();
        HiveState st = Hive.state();
        String dim = HudRenderer.dimName(mc);
        int top = a.y() + 16;
        ControlScreen.Area m = new ControlScreen.Area(a.x(), top, a.w(), a.h() - 16);
        area = m;
        proj.setViewport(m.x(), m.y(), m.w(), m.h());
        if (followMe && mc.player != null) {
            BotState f = Hive.focusedBot() == null ? null : st.bot(Hive.focusedBot());
            if (f != null && dim.equals(f.dim())) proj.setCenter(f.lerpX(now), f.lerpZ(now));
            else proj.setCenter(mc.player.getX(), mc.player.getZ());
        }

        // toolbar
        int x = a.x();
        x += ui.button(x, a.y(), "Center", Gfx.INFO, () -> followMe = true, "follow you (or the focused bot)") + 3;
        x += ui.button(x, a.y(), "−", Gfx.INFO, () -> proj.setZoom(proj.zoom() / 1.5), "zoom out") + 3;
        x += ui.button(x, a.y(), "+", Gfx.INFO, () -> proj.setZoom(proj.zoom() * 1.5), "zoom in") + 6;
        Gfx.text(g, tr, String.format("%.2g px/block · %s", proj.zoom(), dim), x, a.y() + 3, Gfx.FAINT);

        // background + grid
        g.fill(m.x(), m.y(), m.right(), m.bottom(), 0xFF0A0F14);
        g.enableScissor(m.x(), m.y(), m.right(), m.bottom());
        int step = proj.gridStep(18);
        double wx0 = proj.toWorldX(m.x()), wx1 = proj.toWorldX(m.right());
        double wz0 = proj.toWorldZ(m.y()), wz1 = proj.toWorldZ(m.bottom());
        for (long gx = (long) Math.floor(wx0 / step) * step; gx <= wx1; gx += step) {
            int sx = (int) proj.toScreenX(gx);
            boolean major = gx % (step * 4) == 0;
            g.fill(sx, m.y(), sx + 1, m.bottom(), major ? 0x30FFFFFF : 0x14FFFFFF);
            if (major) drawSmall(g, tr, String.valueOf(gx), sx + 2, m.bottom() - 6, 0x60FFFFFF);
        }
        for (long gz = (long) Math.floor(wz0 / step) * step; gz <= wz1; gz += step) {
            int sy = (int) proj.toScreenY(gz);
            boolean major = gz % (step * 4) == 0;
            g.fill(m.x(), sy, m.right(), sy + 1, major ? 0x30FFFFFF : 0x14FFFFFF);
            if (major) drawSmall(g, tr, String.valueOf(gz), m.x() + 2, sy + 2, 0x60FFFFFF);
        }

        // builds
        for (Ghost gh : st.ghosts()) {
            if (gh.dim() != null && !gh.dim().equals(dim)) continue;
            int x0 = (int) proj.toScreenX(gh.minX()), x1 = (int) proj.toScreenX(gh.maxX() + 1);
            int z0 = (int) proj.toScreenY(gh.minZ()), z1 = (int) proj.toScreenY(gh.maxZ() + 1);
            BotState ob = gh.bot() == null ? null : st.bot(gh.bot());
            int c = ob != null ? ob.color() : 0x5CC8FF;
            g.fill(x0, z0, x1, z1, UiMath.rgbA(c, gh.isPreview() ? 24 : 40));
            g.drawBorder(x0, z0, Math.max(1, x1 - x0), Math.max(1, z1 - z0), UiMath.rgbA(c, 200));
            // fill bottom-up with progress
            int ph = (int) ((z1 - z0) * gh.progress() / 100.0);
            g.fill(x0 + 1, z1 - ph, x1 - 1, z1 - 1, UiMath.rgbA(c, 70));
            String label = UiMath.prettyId(gh.blueprint()) + (gh.isPreview() ? " (preview)" : " " + gh.progress() + "%");
            if (x1 - x0 > 20) drawSmall(g, tr, label, x0 + 2, z0 + 2, 0xFFFFFFFF);
        }

        // waypoints
        for (Waypoint w : st.waypoints()) {
            if (!dim.equals(w.dim())) continue;
            int sx = (int) proj.toScreenX(w.x() + 0.5), sy = (int) proj.toScreenY(w.z() + 0.5);
            if (!proj.visible(sx, sy, 20)) continue;
            g.fill(sx - 1, sy - 3, sx + 2, sy + 4, 0xFFFFC24A);
            g.fill(sx - 3, sy - 1, sx + 4, sy + 2, 0xFFFFC24A);
            g.fill(sx, sy, sx + 1, sy + 1, 0xFF000000);
            Gfx.text(g, tr, w.name(), sx + 5, sy - 4, 0xFFFFD98A);
            if (ui.hover(sx - 4, sy - 4, 9, 9)) ui.tooltip(w.name() + " · " + w.x() + " " + w.y() + " " + w.z() + (w.by() == null ? "" : " · by " + w.by()));
        }

        long serverNow = now + st.serverTimeOffset();
        List<BotState> bots = st.bots();
        // trails + paths under the bots
        for (BotState b : bots) {
            if (!dim.equals(b.dim())) continue;
            int c = b.color();
            List<TrailStore.Point> pts = st.trails().get(b.name(), serverNow, 180_000);
            double px = Double.NaN, pz = Double.NaN;
            for (TrailStore.Point p : pts) {
                double age = (serverNow - p.ts()) / 180_000.0;
                int alpha = (int) (200 * (1 - UiMath.clamp01(age)));
                double sx = proj.toScreenX(p.x()), sy = proj.toScreenY(p.z());
                if (!Double.isNaN(px)) line(g, px, pz, sx, sy, UiMath.rgbA(c, alpha));
                px = sx;
                pz = sy;
            }
            PathInfo path = st.path(b.name());
            if (path != null && !path.cleared()) {
                double lx = proj.toScreenX(b.lerpX(now)), lz = proj.toScreenY(b.lerpZ(now));
                int i = 0;
                for (int[] p : path.points()) {
                    double sx = proj.toScreenX(p[0] + 0.5), sy = proj.toScreenY(p[2] + 0.5);
                    if ((i++ + (int) (now / 150)) % 2 == 0) line(g, lx, lz, sx, sy, UiMath.rgbA(c, 150));
                    lx = sx;
                    lz = sy;
                }
                if (path.goal() != null) {
                    int gx = (int) proj.toScreenX(path.goal()[0] + 0.5), gz = (int) proj.toScreenY(path.goal()[2] + 0.5);
                    g.drawBorder(gx - 3, gz - 3, 7, 7, UiMath.rgbA(c, 230));
                }
            }
        }

        // bots
        String focus = Hive.focusedBot();
        for (BotState b : bots) {
            if (!dim.equals(b.dim()) || !b.online()) continue;
            int sx = (int) Math.round(proj.toScreenX(b.lerpX(now))), sy = (int) Math.round(proj.toScreenY(b.lerpZ(now)));
            int c = 0xFF000000 | b.color();
            boolean f = b.name().equalsIgnoreCase(focus == null ? "" : focus);
            if (f) {
                int r = 6 + (int) (2 * Math.sin(now / 200.0));
                g.drawBorder(sx - r, sy - r, r * 2 + 1, r * 2 + 1, UiMath.withAlpha(c, 0.8));
            }
            g.fill(sx - 3, sy - 3, sx + 4, sy + 4, 0xFF000000);
            g.fill(sx - 2, sy - 2, sx + 3, sy + 3, b.dead() ? Gfx.BAD : c);
            if (b.yaw() != null) {
                double yaw = Math.toRadians(b.mcYaw());
                double fx = -Math.sin(yaw), fz = Math.cos(yaw);
                line(g, sx + 0.5, sy + 0.5, sx + 0.5 + fx * 8, sy + 0.5 + fz * 8, c);
            }
            Gfx.text(g, tr, b.name(), sx + 6, sy - 4, c);
            if (ui.hover(sx - 5, sy - 5, 11, 11)) ui.tooltip(b.name() + " · " + b.actionText() + " · " + b.bx() + " " + b.by() + " " + b.bz());
            final String n = b.name();
            ui.region(sx - 5, sy - 5, 11, 11, () -> Hive.setFocusedBot(f ? null : n), null);
        }

        // you
        if (mc.player != null) {
            float sx = (float) proj.toScreenX(mc.player.getX()), sy = (float) proj.toScreenY(mc.player.getZ());
            Gfx.arrow(g, sx, sy, mc.player.getYaw() + 180f, 9, 0xFF000000);
            Gfx.arrow(g, sx, sy, mc.player.getYaw() + 180f, 7, 0xFFFFFFFF);
        }
        g.disableScissor();

        // compass + scale bar
        Gfx.text(g, tr, "N", m.right() - 10, m.y() + 4, Gfx.GOLD);
        Gfx.arrow(g, m.right() - 7.5f, m.y() + 16, 0, 5, Gfx.GOLD);
        int blocks = proj.gridStep(40);
        int barPx = (int) (blocks * proj.zoom());
        g.fill(m.right() - 8 - barPx, m.bottom() - 6, m.right() - 8, m.bottom() - 5, 0xC0FFFFFF);
        drawSmall(g, tr, blocks + " blocks", m.right() - 8 - barPx, m.bottom() - 12, 0xC0FFFFFF);
        g.drawBorder(m.x(), m.y(), m.w(), m.h(), 0xFF2A3242);
        // hover coordinates
        if (ui.hover(m.x(), m.y(), m.w(), m.h())) {
            String c = (int) Math.floor(proj.toWorldX(ui.mx)) + ", " + (int) Math.floor(proj.toWorldZ(ui.my));
            Gfx.text(g, tr, c, a.right() - tr.getWidth(c), a.y() + 3, Gfx.MUTED);
        }
    }

    /** Thin line made of 1px fills (fine for a few hundred segments). */
    private static void line(DrawContext g, double x0, double y0, double x1, double y1, int argb) {
        double dx = x1 - x0, dy = y1 - y0;
        int n = (int) Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
        if (n > 2000) return;
        if (n == 0) { g.fill((int) x0, (int) y0, (int) x0 + 1, (int) y0 + 1, argb); return; }
        for (int i = 0; i <= n; i++) {
            int x = (int) Math.round(x0 + dx * i / n), y = (int) Math.round(y0 + dy * i / n);
            g.fill(x, y, x + 1, y + 1, argb);
        }
    }

    private static void drawSmall(DrawContext g, net.minecraft.client.font.TextRenderer tr, String s, int x, int y, int argb) {
        var mtx = g.getMatrices();
        mtx.push();
        mtx.translate(x, y, 0);
        mtx.scale(0.5f, 0.5f, 1);
        g.drawText(tr, s, 0, 0, argb, false);
        mtx.pop();
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        if (area == null) return false;
        proj.zoomAt(mx, my, v > 0 ? 1.25 : 0.8);
        if (followMe) followMe = Math.abs(mx - (area.x() + area.w() / 2.0)) < 4 && Math.abs(my - (area.y() + area.h() / 2.0)) < 4;
        return true;
    }

    @Override
    public boolean clicked(ControlScreen s, double mx, double my, int button) {
        if (area != null && mx >= area.x() && mx < area.right() && my >= area.y() && my < area.bottom()) {
            dragging = true;
            return true;
        }
        return false;
    }

    @Override
    public boolean dragged(double mx, double my, int button, double dx, double dy) {
        if (!dragging) return false;
        followMe = false;
        proj.dragBy(dx, dy);
        return true;
    }

    @Override
    public void released(double mx, double my, int button) {
        dragging = false;
    }
}
