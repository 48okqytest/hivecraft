package com.hivecraft.overlay.ui.util;

import java.util.Locale;

/** Small maths/format helpers for the UI. No Minecraft classes (unit tested). */
public final class UiMath {
    private UiMath() {}

    // ---------------------------------------------------------------- direction

    /**
     * Bearing from the viewer to a target, relative to where the viewer looks, in degrees
     * (-180, 180]: 0 = straight ahead, +90 = to the right, ±180 = behind.
     * {@code viewerYawDeg} is Minecraft yaw (0 = south/+Z, 90 = west/-X, increases turning right).
     */
    public static double relativeBearing(double fromX, double fromZ, double viewerYawDeg, double toX, double toZ) {
        double dx = toX - fromX, dz = toZ - fromZ;
        if (dx * dx + dz * dz < 1e-9) return 0;
        double yawTo = Math.toDegrees(Math.atan2(-dx, dz)); // MC yaw that would face the target
        return wrapDeg(yawTo - viewerYawDeg);
    }

    /** Wrap to (-180, 180]. */
    public static double wrapDeg(double d) {
        double r = d % 360.0;
        if (r <= -180) r += 360;
        if (r > 180) r -= 360;
        return r;
    }

    /** Compass label for a world direction (dx,dz): N, NE, E ... (north = -Z). */
    public static String compass(double dx, double dz) {
        if (dx * dx + dz * dz < 1e-9) return "·";
        double a = Math.toDegrees(Math.atan2(dx, -dz)); // 0 = north, 90 = east
        if (a < 0) a += 360;
        String[] n = {"N", "NE", "E", "SE", "S", "SW", "W", "NW"};
        return n[(int) Math.round(a / 45.0) % 8];
    }

    public static double dist(double ax, double ay, double az, double bx, double by, double bz) {
        double dx = ax - bx, dy = ay - by, dz = az - bz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    // ---------------------------------------------------------------- format

    /** "4m", "37m", "1.2km". */
    public static String formatDistance(double m) {
        if (m < 0 || Double.isNaN(m)) return "?";
        if (m < 1000) return Math.round(m) + "m";
        return String.format(Locale.ROOT, "%.1fkm", m / 1000.0);
    }

    /** "now", "12s", "3m", "2h", "4d" — compact age. */
    public static String formatAge(long ms) {
        if (ms < 0) ms = 0;
        long s = ms / 1000;
        if (s < 3) return "now";
        if (s < 60) return s + "s";
        long m = s / 60;
        if (m < 60) return m + "m";
        long h = m / 60;
        if (h < 48) return h + "h";
        return (h / 24) + "d";
    }

    /** "41s", "3m12s", "1h05m" — busy duration. */
    public static String formatDuration(long ms) {
        long s = Math.max(0, ms / 1000);
        if (s < 60) return s + "s";
        long m = s / 60;
        if (m < 60) return m + "m" + String.format(Locale.ROOT, "%02d", s % 60) + "s";
        return (m / 60) + "h" + String.format(Locale.ROOT, "%02d", m % 60) + "m";
    }

    /** "oak_planks" → "oak planks"; strips "minecraft:". */
    public static String prettyId(String id) {
        if (id == null) return "";
        String s = id.startsWith("minecraft:") ? id.substring(10) : id;
        return s.replace('_', ' ');
    }

    /** Trim {@code s} to {@code max} chars with an ellipsis. */
    public static String ellipsize(String s, int max) {
        if (s == null) return "";
        if (s.length() <= max) return s;
        return max <= 1 ? "…" : s.substring(0, max - 1) + "…";
    }

    // ---------------------------------------------------------------- animation

    /** Frame-rate independent exponential approach: move {@code cur} toward {@code target}. */
    public static double approach(double cur, double target, double dtSeconds, double speed) {
        if (dtSeconds <= 0) return cur;
        double k = 1 - Math.exp(-speed * dtSeconds);
        double v = cur + (target - cur) * k;
        return Math.abs(target - v) < 1e-4 ? target : v;
    }

    public static double clamp01(double v) {
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    public static double easeOutCubic(double t) {
        t = clamp01(t);
        double u = 1 - t;
        return 1 - u * u * u;
    }

    public static double easeInOutSine(double t) {
        return -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
    }

    /** Fade envelope: 0→1 over {@code in} ms, hold, 1→0 over the last {@code out} ms of {@code life}. */
    public static double fade(long age, long life, long in, long out) {
        if (age < 0 || age >= life) return 0;
        double a = 1;
        if (in > 0 && age < in) a = Math.min(a, age / (double) in);
        if (out > 0 && age > life - out) a = Math.min(a, (life - age) / (double) out);
        return clamp01(a);
    }

    // ---------------------------------------------------------------- colour

    /** Multiply the alpha of an ARGB colour by {@code a} (0..1). */
    public static int withAlpha(int argb, double a) {
        int al = (int) Math.round(((argb >>> 24) & 0xFF) * clamp01(a));
        return (al << 24) | (argb & 0x00FFFFFF);
    }

    /** Opaque ARGB from 0xRRGGBB with the given alpha byte. */
    public static int rgbA(int rgb, int alpha) {
        return ((alpha & 0xFF) << 24) | (rgb & 0xFFFFFF);
    }

    public static int lerpColor(int a, int b, double t) {
        t = clamp01(t);
        int aa = (a >>> 24) & 0xFF, ar = (a >> 16) & 0xFF, ag = (a >> 8) & 0xFF, ab = a & 0xFF;
        int ba = (b >>> 24) & 0xFF, br = (b >> 16) & 0xFF, bg = (b >> 8) & 0xFF, bb = b & 0xFF;
        return ((int) Math.round(aa + (ba - aa) * t) << 24) | ((int) Math.round(ar + (br - ar) * t) << 16)
                | ((int) Math.round(ag + (bg - ag) * t) << 8) | (int) Math.round(ab + (bb - ab) * t);
    }

    /** Brighten (t>0, toward white) or darken (t<0, toward black). Keeps alpha. */
    public static int shade(int argb, double t) {
        int target = t >= 0 ? (argb & 0xFF000000) | 0xFFFFFF : (argb & 0xFF000000);
        return lerpColor(argb, target, Math.abs(t));
    }

    /** Health colour: green → yellow → red as {@code frac} drops. */
    public static int healthColor(double frac) {
        frac = clamp01(frac);
        if (frac > 0.5) return lerpColor(0xFFFFD23F, 0xFF4CE06A, (frac - 0.5) * 2);
        return lerpColor(0xFFFF4545, 0xFFFFD23F, frac * 2);
    }
}
