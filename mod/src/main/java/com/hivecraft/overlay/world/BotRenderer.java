package com.hivecraft.overlay.world;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Fade;
import com.hivecraft.overlay.core.PathInfo;
import com.hivecraft.overlay.core.TrailStore;
import net.minecraft.client.render.VertexConsumer;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.util.math.Vec3d;
import org.joml.Matrix4f;

import java.util.List;

/** Floating labels, trails (ribbons), planned path lines and the target beacon for each bot. */
public final class BotRenderer {
    private BotRenderer() {}

    /** Where a bot is drawn this frame: its loaded entity's interpolated position, else the bridge position (lerped). */
    public static Vec3d renderPos(Frame f, BotState b) {
        PlayerEntity e = BotIndex.entity(b.name());
        if (e != null) return e.getLerpedPos(f.tickDelta);
        return new Vec3d(b.lerpX(f.now), b.lerpY(f.now), b.lerpZ(f.now));
    }

    public static void render(Frame f) {
        for (BotState b : f.st.bots()) {
            if (!b.online() || !f.dim.equals(b.dim())) continue;
            Vec3d p = renderPos(f, b);
            boolean focused = f.focused != null && f.focused.equalsIgnoreCase(b.name());
            if (f.cfg.trails) trail(f, b, p, focused);
            if (f.cfg.pathLines || f.cfg.targetBeacon) path(f, b, p, focused);
        }
        // labels last so they draw over trails
        if (f.cfg.labels) {
            for (BotState b : f.st.bots()) {
                if (!f.dim.equals(b.dim())) continue;
                label(f, b, renderPos(f, b));
            }
        }
    }

    // ------------------------------------------------------------------- trails

    private static void trail(Frame f, BotState b, Vec3d head, boolean focused) {
        long maxAge = f.cfg.trailSeconds * 1000L;
        List<TrailStore.Point> pts = f.st.trails().get(b.name(), f.now, maxAge);
        if (pts.isEmpty()) return;
        pts.add(new TrailStore.Point(head.x, head.y, head.z, f.now));
        Matrix4f m = f.m();
        VertexConsumer q = f.quads(false);
        VertexConsumer ln = focused ? f.thickLines() : f.lines(false);
        float half = focused ? 0.28f : 0.17f;
        int col = b.color();
        int bright = Fade.lighten(col, 0.35f);
        for (int i = 1; i < pts.size(); i++) {
            TrailStore.Point a = pts.get(i - 1), c = pts.get(i);
            double dx = c.x() - a.x(), dz = c.z() - a.z();
            double len = Math.sqrt(dx * dx + dz * dz);
            if (len > 12) continue; // teleport / respawn gap
            if (f.distSq(c.x(), c.y(), c.z()) > 160 * 160) continue;
            float fa = Fade.age(f.now, a.ts(), maxAge), fc = Fade.age(f.now, c.ts(), maxAge);
            float ya = f.ry(a.y() + 0.06), yc = f.ry(c.y() + 0.06);
            float px = 0, pz = 0;
            if (len > 1e-4) { px = (float) (-dz / len) * half; pz = (float) (dx / len) * half; }
            float ax = f.rx(a.x()), az = f.rz(a.z()), cx = f.rx(c.x()), cz = f.rz(c.z());
            // ribbon (alpha follows age at each end)
            Draw.v(q, m, ax - px, ya, az - pz, col, 0.42f * fa);
            Draw.v(q, m, ax + px, ya, az + pz, col, 0.42f * fa);
            Draw.v(q, m, cx + px, yc, cz + pz, col, 0.42f * fc);
            Draw.v(q, m, cx - px, yc, cz - pz, col, 0.42f * fc);
            // bright centre line
            Draw.line(ln, f.e(), ax, ya + 0.01f, az, cx, yc + 0.01f, cz, bright, 0.85f * fa, bright, 0.85f * fc);
        }
    }

    // -------------------------------------------------------------------- paths

    private static void path(Frame f, BotState b, Vec3d head, boolean focused) {
        PathInfo p = f.st.path(b.name());
        if (p == null || !f.dim.equals(p.dim())) return;
        int col = Fade.lighten(b.color(), 0.2f);
        double t = (f.now % 100000L) / 1000.0;
        if (f.cfg.pathLines && !p.points().isEmpty()) {
            VertexConsumer ln = f.lines(false);
            VertexConsumer lx = f.lines(true);
            double px = head.x, py = head.y + 0.15, pz = head.z;
            double along = 0;
            for (int[] pt : p.points()) {
                double nx = pt[0] + 0.5, ny = pt[1] + 0.15, nz = pt[2] + 0.5;
                double seg = Math.sqrt((nx - px) * (nx - px) + (ny - py) * (ny - py) + (nz - pz) * (nz - pz));
                if (seg > 0.01 && seg < 64) {
                    // marching pulse: brightness moves from the bot toward the goal
                    float pulse0 = (float) (0.55 + 0.45 * Math.sin(along * 1.3 - t * 7));
                    float pulse1 = (float) (0.55 + 0.45 * Math.sin((along + seg) * 1.3 - t * 7));
                    Draw.line(ln, f.e(), f.rx(px), f.ry(py), f.rz(pz), f.rx(nx), f.ry(ny), f.rz(nz),
                            Fade.lighten(col, pulse0 * 0.5f), 0.9f, Fade.lighten(col, pulse1 * 0.5f), 0.9f);
                    Draw.line(lx, f.e(), f.rx(px), f.ry(py), f.rz(pz), f.rx(nx), f.ry(ny), f.rz(nz), col, 0.18f);
                }
                along += seg;
                px = nx; py = ny; pz = nz;
            }
        }
        if (f.cfg.targetBeacon && p.goal() != null) {
            int[] g = p.goal();
            double gx = g[0] + 0.5, gz = g[2] + 0.5;
            if (f.dist(gx, g[1], gz) > 256) return;
            float pulse = (float) (0.5 + 0.5 * Math.sin(t * 4));
            Matrix4f m = f.m();
            Draw.beam(f.quads(false), m, f.rx(gx), f.ry(g[1]), f.ry(g[1] + 48), f.rz(gz), focused ? 0.18f : 0.12f, col, 0.55f, 0f);
            Draw.beam(f.quads(true), m, f.rx(gx), f.ry(g[1]), f.ry(g[1] + 24), f.rz(gz), 0.05f, col, 0.25f, 0f);
            float in = 0.02f + 0.06f * pulse;
            Draw.outline(f.lines(false), f.e(), f.rx(g[0] + in), f.ry(g[1] + in), f.rz(g[2] + in),
                    f.rx(g[0] + 1 - in), f.ry(g[1] + 1 - in), f.rz(g[2] + 1 - in), col, 0.6f + 0.4f * pulse);
        }
    }

    // ------------------------------------------------------------------- labels

    private static String trim(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    private static void label(Frame f, BotState b, Vec3d p) {
        double d = f.dist(p.x, p.y + 2, p.z);
        float a = Fade.distance(d, f.cfg.labelMaxDistance, 0.7);
        if (a <= 0.03f) return;
        boolean focused = f.focused != null && f.focused.equalsIgnoreCase(b.name());
        boolean xray = f.cfg.labelsThroughWalls;
        // grow with distance so it stays readable, like a constant on-screen size beyond ~10 blocks
        float scale = 0.025f * f.cfg.labelScale * (float) Math.max(1.0, Math.min(d / 10.0, 8.0)) * (focused ? 1.2f : 1f);
        double top = p.y + 2.05 + (BotIndex.entity(b.name()) != null ? 0.35 : 0); // above the vanilla nametag
        f.pushBillboard(p.x, top, p.z, scale);
        try {
            int col = b.color();
            String name = b.name() + (b.role() == null || b.role().isEmpty() ? "" : " · " + b.role());
            String action = trim(b.online() ? (b.dead() ? "dead" : b.actionText()) : "offline", 48);
            int bg = Fade.argb(0x000000, 0.45f * a);

            // layout (pixels, y down): progress bar, bars, action, name at the top
            float y = 0;
            if (b.hasProgress()) {
                y -= 4;
                bar(f, -30, y, 60, 2.5f, b.progressFraction(), col, a, xray);
            }
            if (f.cfg.labelBars && b.online()) {
                y -= 4;
                bar(f, -30, y, 28, 2.5f, b.health() / 20f, 0xE53935, a, xray);
                bar(f, 2, y, 28, 2.5f, b.food() / 20f, 0xF9A825, a, xray);
            }
            y -= 10;
            f.text(action, y, b.online() ? 0xFFFFFF : 0xAAAAAA, a * 0.95f, xray, bg);
            y -= 11;
            f.text(name, y, col, a, xray, bg);
            if (f.cfg.labelHeldItem && b.held() != null && !b.held().isEmpty() && a > 0.3f) {
                float w = f.font().getWidth(name) / 2f;
                f.item(BlockStates.item(b.held()), -w - 7, y + 4, 9);
            }
            if (focused) {
                f.text("▼", y - 9, Fade.lighten(col, 0.4f), a, xray, 0);
            }
        } finally {
            f.ms.pop();
        }
    }

    /** Horizontal bar in billboard space: dark back + coloured fill. */
    private static void bar(Frame f, float x, float y, float w, float h, float frac, int rgb, float a, boolean xray) {
        Matrix4f m = f.m();
        VertexConsumer q = f.quads(xray);
        Draw.rect(q, m, x - 0.5f, y - 0.5f, x + w + 0.5f, y + h + 0.5f, 0.01f, 0x101010, 0.6f * a);
        float fw = w * Fade.clamp01(frac);
        if (fw > 0) Draw.rect(q, m, x, y, x + fw, y + h, 0f, rgb, 0.95f * a);
    }
}
