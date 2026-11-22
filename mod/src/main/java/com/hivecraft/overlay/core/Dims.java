package com.hivecraft.overlay.core;

import java.util.Locale;

/** Dimension name helpers: the bridge uses overworld | nether | end. */
public final class Dims {
    private Dims() {}

    /** "minecraft:the_nether" / "the_nether" / "nether" to "nether", etc. Unknown or null to "overworld". */
    public static String normalize(String d) {
        if (d == null) return "overworld";
        String s = d.toLowerCase(Locale.ROOT);
        if (s.startsWith("minecraft:")) s = s.substring(10);
        return switch (s) {
            case "the_nether", "nether" -> "nether";
            case "the_end", "end" -> "end";
            default -> "overworld";
        };
    }
}
