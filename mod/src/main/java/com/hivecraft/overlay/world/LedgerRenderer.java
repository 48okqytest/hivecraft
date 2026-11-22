package com.hivecraft.overlay.world;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Fade;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.Highlights;
import com.hivecraft.overlay.core.LedgerEvent;
import net.minecraft.client.render.VertexConsumer;
import org.joml.Matrix4f;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Block attribution: placed blocks get a tinted fill, broken blocks an outline ghost, per bot colour, fading with age. */
public final class LedgerRenderer {
    private LedgerRenderer() {}

    public static final int MAX_BLOCKS = 6000;

    public static void render(Frame f) {
        long fade = f.cfg.ledgerFadeSeconds * 1000L;
        List<LedgerEvent> evs = f.cfg.ledger ? f.st.ledger().latestPerBlock(f.dim, f.now - fade, f.cfg.ledgerBot) : List.of();
        if (!evs.isEmpty()) {
            Map<String, Integer> colors = new HashMap<>();
            for (BotState b : f.st.bots()) colors.put(b.name().toLowerCase(), b.color());
            double maxD = f.cfg.ledgerMaxDistance, maxSq = maxD * maxD;
            Matrix4f m = f.m();
            VertexConsumer q = f.quads(false);
            VertexConsumer ln = f.lines(false);
            int n = 0;
            for (LedgerEvent e : evs) {
                if (n >= MAX_BLOCKS) break;
                double dsq = f.distSq(e.x() + 0.5, e.y() + 0.5, e.z() + 0.5);
                if (dsq > maxSq) continue;
                if (!f.visible(e.x(), e.y(), e.z(), e.x() + 1, e.y() + 1, e.z() + 1)) continue;
                float a = Fade.age(f.now, e.ts(), fade) * Fade.distance(Math.sqrt(dsq), maxD, 0.75);
                if (a <= 0.02f) continue;
                // fresh changes flash brighter for the first 1.5 s
                float flash = Fade.age(f.now, e.ts(), 1500);
                Integer c = colors.get(e.bot().toLowerCase());
                int col = c != null ? c : 0xFFFFFF;
                float x = f.rx(e.x()), y = f.ry(e.y()), z = f.rz(e.z());
                if (e.isPlace() && f.cfg.ledgerPlaced) {
                    float g = 0.004f;
                    Draw.box(q, m, x - g, y - g, z - g, x + 1 + g, y + 1 + g, z + 1 + g, Fade.lighten(col, flash * 0.6f), (0.22f + 0.3f * flash) * a);
                    Draw.outline(ln, f.e(), x - g, y - g, z - g, x + 1 + g, y + 1 + g, z + 1 + g, col, 0.55f * a);
                    n++;
                } else if (e.isBreak() && f.cfg.ledgerBroken) {
                    float in = 0.12f;
                    Draw.outline(ln, f.e(), x + in, y + in, z + in, x + 1 - in, y + 1 - in, z + 1 - in, col, 0.75f * a);
                    if (flash > 0) Draw.box(q, m, x + in, y + in, z + in, x + 1 - in, y + 1 - in, z + 1 - in, col, 0.25f * flash * a);
                    n++;
                }
            }
        }
        highlights(f);
    }

    /** UI-requested highlights: pulsing thick outline + beam + optional label. */
    private static void highlights(Frame f) {
        List<Highlights.Box> boxes = Hive.highlights().active(System.currentTimeMillis());
        if (boxes.isEmpty()) return;
        double t = (f.now % 100000L) / 1000.0;
        float pulse = (float) (0.5 + 0.5 * Math.sin(t * 6));
        for (Highlights.Box b : boxes) {
            if (!f.dim.equals(b.dim())) continue;
            long left = b.until() - System.currentTimeMillis();
            float a = Fade.clamp01(left / 600.0);
            float x1 = f.rx(b.minX() - 0.02), y1 = f.ry(b.minY() - 0.02), z1 = f.rz(b.minZ() - 0.02);
            float x2 = f.rx(b.maxX() + 1.02), y2 = f.ry(b.maxY() + 1.02), z2 = f.rz(b.maxZ() + 1.02);
            Draw.outline(f.thickLines(), f.e(), x1, y1, z1, x2, y2, z2, b.color(), (0.6f + 0.4f * pulse) * a);
            Draw.outline(f.lines(true), f.e(), x1, y1, z1, x2, y2, z2, b.color(), 0.45f * a);
            Draw.box(f.quads(false), f.m(), x1, y1, z1, x2, y2, z2, b.color(), 0.12f * pulse * a);
            double cx = (b.minX() + b.maxX() + 1) / 2.0, cz = (b.minZ() + b.maxZ() + 1) / 2.0;
            Draw.beam(f.quads(true), f.m(), f.rx(cx), y2, f.ry(b.maxY() + 40), f.rz(cz), 0.1f, b.color(), 0.4f * a, 0f);
            if (b.label() != null) {
                double d = f.dist(cx, b.maxY() + 1.6, cz);
                f.pushBillboard(cx, b.maxY() + 1.6, cz, 0.025f * (float) Math.max(1, Math.min(d / 10, 8)));
                try { f.text(b.label(), -4, b.color(), a, true, Fade.argb(0, 0.4f * a)); } finally { f.ms.pop(); }
            }
        }
    }
}
