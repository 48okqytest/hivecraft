package com.hivecraft.overlay.ui.term;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;

/** One terminal output line: coloured segments (protocol {@code lines[i]}). Pure logic. */
public record TermLine(List<Seg> segs, long ts) {

    /** A run of text with one style. {@code argb} includes alpha (0xFF......). {@code click} may be null. */
    public record Seg(String text, int argb, boolean bold, boolean italic, String click) {
        public Seg {
            text = text == null ? "" : text.replace("\t", "    ").replace("\r", "");
        }

        public Seg withText(String t) {
            return new Seg(t, argb, bold, italic, click);
        }
    }

    public static final int WHITE = 0xFFE8E8E8;
    public static final int DIM = 0xFF8A8F98;
    public static final int GREEN = 0xFF5CFF8A;
    public static final int RED = 0xFFFF5C5C;
    public static final int YELLOW = 0xFFFFD75C;
    public static final int CYAN = 0xFF5CE1FF;
    public static final int AMBER = 0xFFFFB000;

    public static TermLine of(String text, int argb) {
        return new TermLine(List.of(new Seg(text, argb, false, false, null)), System.currentTimeMillis());
    }

    public static TermLine of(Seg... segs) {
        return new TermLine(List.of(segs), System.currentTimeMillis());
    }

    public static Seg seg(String text, int argb) {
        return new Seg(text, argb, false, false, null);
    }

    public String plain() {
        StringBuilder sb = new StringBuilder();
        for (Seg s : segs) sb.append(s.text());
        return sb.toString();
    }

    /** Parse "#RRGGBB" (or "RRGGBB"); falls back to {@code def}. Returns opaque ARGB. */
    public static int parseColor(String hex, int def) {
        if (hex == null) return def;
        String h = hex.trim();
        if (h.startsWith("#")) h = h.substring(1);
        if (h.length() != 6) return def;
        try {
            return 0xFF000000 | Integer.parseInt(h, 16);
        } catch (NumberFormatException e) {
            return def;
        }
    }

    /** Parse a protocol line: array of {text,color?,bold?,italic?,click?}. Lenient: a bare string is one segment. */
    public static TermLine fromJson(JsonElement el, int defColor) {
        List<Seg> out = new ArrayList<>();
        if (el == null || el.isJsonNull()) return new TermLine(out, System.currentTimeMillis());
        if (el.isJsonPrimitive()) {
            out.add(new Seg(el.getAsString(), defColor, false, false, null));
        } else if (el.isJsonArray()) {
            for (JsonElement e : el.getAsJsonArray()) {
                if (e.isJsonPrimitive()) {
                    out.add(new Seg(e.getAsString(), defColor, false, false, null));
                } else if (e.isJsonObject()) {
                    JsonObject o = e.getAsJsonObject();
                    out.add(new Seg(
                            str(o, "text"),
                            parseColor(str(o, "color"), defColor),
                            bool(o, "bold"), bool(o, "italic"),
                            o.has("click") && !o.get("click").isJsonNull() ? o.get("click").getAsString() : null));
                }
            }
        } else if (el.isJsonObject()) {
            JsonArray one = new JsonArray();
            one.add(el);
            return fromJson(one, defColor);
        }
        return new TermLine(out, System.currentTimeMillis());
    }

    private static String str(JsonObject o, String k) {
        JsonElement e = o.get(k);
        return e == null || e.isJsonNull() ? "" : e.getAsString();
    }

    private static boolean bool(JsonObject o, String k) {
        JsonElement e = o.get(k);
        return e != null && e.isJsonPrimitive() && e.getAsBoolean();
    }
}
