package com.hivecraft.overlay.core;

import java.util.Locale;

/** Text for the crosshair block tooltip ("Placed by Ash · 3m ago · house build #house_10_64_5"). */
public final class LedgerText {
    private LedgerText() {}

    /** "oak_stairs" to "Oak Stairs". */
    public static String prettyBlock(String id) {
        if (id == null || id.isEmpty()) return "?";
        String s = id.startsWith("minecraft:") ? id.substring(10) : id;
        StringBuilder sb = new StringBuilder();
        for (String w : s.split("_")) {
            if (w.isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            sb.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
        }
        return sb.toString();
    }

    /** Main line: "Placed by Ash · 3m ago · house build #house_10_64_5" / "Broken by Flint · 12s ago · was Iron Ore". */
    public static String headline(LedgerEvent e, long now) {
        StringBuilder sb = new StringBuilder();
        sb.append(e.isPlace() ? "Placed by " : "Broken by ").append(e.bot()).append(" · ").append(Fade.ago(now, e.ts()));
        String why = context(e);
        if (!why.isEmpty()) sb.append(" · ").append(why);
        return sb.toString();
    }

    /** The "why": blueprint name + build id, or a cause description. */
    public static String context(LedgerEvent e) {
        if (e.build() != null && !e.build().isEmpty()) {
            String bp = blueprintOf(e.build());
            String s = (bp != null ? bp + " build" : "build") + " #" + e.build();
            if (e.section() >= 0) s += " sec " + e.section();
            return s;
        }
        String c = e.cause() == null ? "" : e.cause();
        return switch (c) {
            case "collect" -> e.isBreak() ? "gathering" : "collect";
            case "mine" -> "mining";
            case "place" -> "placed by hand";
            case "scaffold" -> "scaffold (climbing)";
            case "pathfinder-dig" -> "dug through while walking";
            case "pathfinder-place" -> "bridged while walking";
            case "auto" -> "auto behaviour";
            case "tunnel" -> "dug a way out";
            case "idle" -> "while idle";
            case "code" -> "script";
            case "" -> "";
            default -> c.replace('_', ' ');
        };
    }

    /** "house_10_64_5" to "house" (strip trailing _x_y_z); null when the id has no such suffix. */
    public static String blueprintOf(String buildId) {
        if (buildId == null) return null;
        String[] p = buildId.split("_");
        if (p.length >= 4) {
            int n = p.length;
            if (isInt(p[n - 1]) && isInt(p[n - 2]) && isInt(p[n - 3])) {
                return String.join("_", java.util.Arrays.copyOf(p, n - 3));
            }
        }
        return null;
    }

    private static boolean isInt(String s) {
        if (s.isEmpty()) return false;
        int i = s.charAt(0) == '-' ? 1 : 0;
        if (i == s.length()) return false;
        for (; i < s.length(); i++) if (!Character.isDigit(s.charAt(i))) return false;
        return true;
    }

    /** Second line: what block, and what it replaced. */
    public static String detail(LedgerEvent e) {
        if (e.isPlace()) {
            String s = prettyBlock(e.block());
            if (e.prev() != null && !e.prev().isEmpty() && !e.prev().endsWith("air")) s += " (replaced " + prettyBlock(e.prev()) + ")";
            return s;
        }
        return "was " + prettyBlock(e.block());
    }

    /** "3 changes" summary for blocks with longer history. */
    public static String historySummary(int n) {
        return n <= 1 ? "" : String.format(Locale.ROOT, "%d changes", n);
    }
}
