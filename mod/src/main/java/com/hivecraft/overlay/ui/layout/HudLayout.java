package com.hivecraft.overlay.ui.layout;

import java.util.ArrayList;
import java.util.List;

/**
 * HUD placement maths: panels are stored as an anchor (one of 9 screen points) plus an offset in
 * scaled GUI pixels, so they stay put when the window or GUI scale changes. Placement is clamped
 * into the screen and pushed out of "keep clear" zones (crosshair, hotbar + vitals). Dragging a
 * panel re-picks the nearest anchor on drop. Pure logic (unit tested).
 */
public final class HudLayout {
    private HudLayout() {}

    public enum Anchor {
        TOP_LEFT(0, 0), TOP_CENTER(1, 0), TOP_RIGHT(2, 0),
        MID_LEFT(0, 1), CENTER(1, 1), MID_RIGHT(2, 1),
        BOTTOM_LEFT(0, 2), BOTTOM_CENTER(1, 2), BOTTOM_RIGHT(2, 2);

        public final int hx, vy; // 0 = left/top, 1 = centre, 2 = right/bottom

        Anchor(int hx, int vy) {
            this.hx = hx;
            this.vy = vy;
        }

        public static Anchor of(String s, Anchor def) {
            if (s == null) return def;
            try {
                return valueOf(s);
            } catch (IllegalArgumentException e) {
                return def;
            }
        }
    }

    public record Rect(int x, int y, int w, int h) {
        public int right() { return x + w; }
        public int bottom() { return y + h; }
        public boolean contains(double px, double py) { return px >= x && px < x + w && py >= y && py < y + h; }
        public boolean intersects(Rect o) { return x < o.right() && o.x < right() && y < o.bottom() && o.y < bottom(); }
        public Rect moved(int dx, int dy) { return new Rect(x + dx, y + dy, w, h); }
    }

    /** Where a panel is: anchor + offset (px, scaled GUI units; positive = right/down). */
    public record Placement(Anchor anchor, int dx, int dy) {}

    /** Screen margin kept free around the edges. */
    public static final int MARGIN = 4;

    /** Rect of a {@code w×h} panel placed at {@code p} on a {@code sw×sh} screen (before clamping). */
    public static Rect place(Placement p, int w, int h, int sw, int sh) {
        int ax = switch (p.anchor().hx) {
            case 0 -> MARGIN;
            case 1 -> (sw - w) / 2;
            default -> sw - w - MARGIN;
        };
        int ay = switch (p.anchor().vy) {
            case 0 -> MARGIN;
            case 1 -> (sh - h) / 2;
            default -> sh - h - MARGIN;
        };
        return new Rect(ax + p.dx(), ay + p.dy(), w, h);
    }

    /**
     * Place, clamp to the screen and move out of the keep-clear zones: a small breadth-first search
     * over "push out of this zone" moves (up to 4 deep) picks the nearest on-screen spot that
     * touches no zone. If none exists (tiny screen), the clamped spot is used as is.
     */
    public static Rect resolve(Placement p, int w, int h, int sw, int sh, List<Rect> keepClear) {
        Rect start = clamp(place(p, w, h, sw, sh), sw, sh);
        if (free(start, keepClear)) return start;
        List<Rect> frontier = new ArrayList<>(List.of(start));
        java.util.Set<Rect> seen = new java.util.HashSet<>(frontier);
        Rect best = null;
        int bestD = Integer.MAX_VALUE;
        for (int depth = 0; depth < 4 && !frontier.isEmpty(); depth++) {
            List<Rect> next = new ArrayList<>();
            for (Rect r : frontier) {
                for (Rect z : keepClear) {
                    if (!r.intersects(z)) continue;
                    for (Rect c : pushes(r, z, sw, sh)) {
                        if (!seen.add(c)) continue;
                        if (free(c, keepClear)) {
                            int d = Math.abs(c.x() - start.x()) + Math.abs(c.y() - start.y());
                            if (d < bestD) { bestD = d; best = c; }
                        } else next.add(c);
                    }
                }
            }
            frontier = next;
        }
        return best != null ? best : start;
    }

    private static boolean free(Rect r, List<Rect> zones) {
        for (Rect z : zones) if (r.intersects(z)) return false;
        return true;
    }

    /** The four on-screen moves that take {@code r} just out of {@code z}. */
    static List<Rect> pushes(Rect r, Rect z, int sw, int sh) {
        List<Rect> out = new ArrayList<>(4);
        Rect[] c = {r.moved(z.x() - r.right(), 0), r.moved(z.right() - r.x(), 0), r.moved(0, z.y() - r.bottom()), r.moved(0, z.bottom() - r.y())};
        for (Rect o : c) if (o.x() >= 0 && o.y() >= 0 && o.right() <= sw && o.bottom() <= sh) out.add(o);
        return out;
    }

    public static Rect clamp(Rect r, int sw, int sh) {
        int x = Math.max(0, Math.min(r.x(), sw - r.w()));
        int y = Math.max(0, Math.min(r.y(), sh - r.h()));
        return new Rect(x, y, r.w(), r.h());
    }

    /**
     * Vanilla zones the HUD must not cover: crosshair (centre) and the hotbar with the health/food/
     * armour/XP rows above it (182 px wide, ~ 60 px tall at the bottom centre). Scaled GUI units.
     */
    public static List<Rect> vanillaKeepClear(int sw, int sh) {
        List<Rect> l = new ArrayList<>();
        l.add(new Rect(sw / 2 - 14, sh / 2 - 14, 28, 28));            // crosshair
        l.add(new Rect(sw / 2 - 100, sh / 2 + 8, 200, 26));           // world block tooltip (ModWorld draws it at centre, y+12)
        l.add(new Rect(sw / 2 - 91 - 4, sh - 62, 182 + 8, 62));       // hotbar + vitals + xp
        return l;
    }

    /** Placement for a panel the user dropped at rect {@code r}: nearest anchor + offset from it. */
    public static Placement fromRect(Rect r, int sw, int sh) {
        double cx = r.x() + r.w() / 2.0, cy = r.y() + r.h() / 2.0;
        int hx = cx < sw / 3.0 ? 0 : (cx > sw * 2 / 3.0 ? 2 : 1);
        int vy = cy < sh / 3.0 ? 0 : (cy > sh * 2 / 3.0 ? 2 : 1);
        Anchor a = Anchor.TOP_LEFT;
        for (Anchor an : Anchor.values()) if (an.hx == hx && an.vy == vy) a = an;
        Rect base = place(new Placement(a, 0, 0), r.w(), r.h(), sw, sh);
        return new Placement(a, r.x() - base.x(), r.y() - base.y());
    }

    /** Stack rows of heights {@code hs} with {@code gap}; returns the y of each row from {@code y0}. */
    public static int[] stack(int y0, int[] hs, int gap) {
        int[] ys = new int[hs.length];
        int y = y0;
        for (int i = 0; i < hs.length; i++) {
            ys[i] = y;
            y += hs[i] + gap;
        }
        return ys;
    }

    /** Lay {@code n} cells in a grid that fits {@code width}: returns columns count for min cell width. */
    public static int columns(int width, int minCell, int gap, int n) {
        if (n <= 0) return 1;
        int c = Math.max(1, (width + gap) / (minCell + gap));
        return Math.min(c, n);
    }
}
