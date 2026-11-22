package com.hivecraft.overlay.world;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Fade;
import com.hivecraft.overlay.core.Waypoint;

import java.util.Locale;

/** Waypoints (base, chests, mines) as light beams with a floating label + distance. */
public final class WaypointRenderer {
    private WaypointRenderer() {}

    /** Colour by waypoint kind; falls back to the colour of the bot that saved it. */
    static int colorFor(Frame f, Waypoint w) {
        String n = w.name().toLowerCase(Locale.ROOT);
        if (n.contains("base") || n.contains("home")) return 0xFFD54F;
        if (n.contains("chest") || n.contains("storage")) return 0xC8A165;
        if (n.contains("mine") || n.contains("ore") || n.contains("cave")) return 0x90A4AE;
        if (n.contains("farm")) return 0x9CCC65;
        BotState b = f.st.bot(w.by());
        return b != null ? b.color() : 0xFFFFFF;
    }

    public static void render(Frame f) {
        double t = (f.now % 100000L) / 1000.0;
        for (Waypoint w : f.st.waypoints()) {
            if (!f.dim.equals(w.dim())) continue;
            double x = w.x() + 0.5, z = w.z() + 0.5;
            double d = f.dist(x, w.y(), z);
            float a = Fade.distance(d, f.cfg.waypointMaxDistance, 0.85);
            if (a <= 0.02f) continue;
            int col = colorFor(f, w);
            // close up the beam fades so it doesn't block the view
            float near = Fade.clamp01((d - 3) / 10.0);
            float shimmer = (float) (0.85 + 0.15 * Math.sin(t * 3 + w.x() * 0.7));
            Draw.beam(f.quads(false), f.m(), f.rx(x), f.ry(w.y()), f.ry(w.y() + 90), f.rz(z), 0.22f, col, 0.35f * a * near * shimmer, 0f);
            Draw.beam(f.quads(false), f.m(), f.rx(x), f.ry(w.y()), f.ry(w.y() + 120), f.rz(z), 0.07f, Fade.lighten(col, 0.6f), 0.75f * a * near, 0f);
            Draw.beam(f.quads(true), f.m(), f.rx(x), f.ry(w.y()), f.ry(w.y() + 60), f.rz(z), 0.05f, col, 0.18f * a, 0f);
            Draw.outline(f.lines(false), f.e(), f.rx(w.x()), f.ry(w.y()), f.rz(w.z()), f.rx(w.x() + 1), f.ry(w.y() + 1), f.rz(w.z() + 1), col, 0.6f * a);

            // label at eye-ish height above the point, constant on-screen size
            double ly = w.y() + 2.2;
            float scale = 0.025f * (float) Math.max(1.0, Math.min(d / 8.0, 40.0));
            f.pushBillboard(x, ly, z, scale);
            try {
                int bg = Fade.argb(0, 0.4f * a);
                f.text("◆ " + w.name(), -20, col, a, true, bg);
                String sub = Math.round(d) + "m" + (w.by() == null || w.by().isEmpty() ? "" : " · " + w.by());
                f.text(sub, -9, 0xCCCCCC, a * 0.85f, true, bg);
            } finally {
                f.ms.pop();
            }
        }
    }
}
