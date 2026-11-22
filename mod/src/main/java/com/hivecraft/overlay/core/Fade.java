package com.hivecraft.overlay.core;

/** Pure fade / easing math used by the renderers (unit-tested). */
public final class Fade {
    private Fade() {}

    public static float clamp01(double v) { return (float) (v < 0 ? 0 : (v > 1 ? 1 : v)); }

    /** 1 at age 0, linearly 0 at maxAge (and beyond). */
    public static float age(long now, long ts, long maxAgeMs) {
        if (maxAgeMs <= 0) return 0;
        return clamp01(1.0 - (now - ts) / (double) maxAgeMs);
    }

    /** 1 up to {@code start * max}, then smoothly to 0 at {@code max}. */
    public static float distance(double dist, double max, double start) {
        if (max <= 0) return 0;
        double a = max * start;
        if (dist <= a) return 1;
        if (dist >= max) return 0;
        double t = (dist - a) / (max - a);
        return (float) (1 - t * t * (3 - 2 * t));
    }

    /** Pop-in, hold, fade-out envelope over a lifetime: t in [0,1]. */
    public static float popEnvelope(double t) {
        if (t <= 0 || t >= 1) return 0;
        if (t < 0.15) return (float) (t / 0.15);
        if (t > 0.7) return (float) ((1 - t) / 0.3);
        return 1;
    }

    /** ARGB with alpha a (0..1) applied to 0xRRGGBB. */
    public static int argb(int rgb, float a) {
        int al = Math.round(clamp01(a) * 255);
        return (al << 24) | (rgb & 0xFFFFFF);
    }

    /** Mixes rgb toward white by f (0..1). */
    public static int lighten(int rgb, float f) {
        int r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
        r = Math.round(r + (255 - r) * f); g = Math.round(g + (255 - g) * f); b = Math.round(b + (255 - b) * f);
        return (r << 16) | (g << 8) | b;
    }

    /** Human "3m ago" / "12s ago" / "2h ago" / "1d ago". */
    public static String ago(long now, long ts) {
        long s = Math.max(0, (now - ts) / 1000);
        if (s < 60) return s + "s ago";
        long m = s / 60;
        if (m < 60) return m + "m ago";
        long h = m / 60;
        if (h < 24) return h + "h ago";
        return (h / 24) + "d ago";
    }
}
