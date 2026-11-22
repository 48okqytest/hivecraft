package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** Null-tolerant Gson helpers. Every getter returns the default when the key is missing, null or the wrong type. */
public final class J {
    private J() {}

    public static JsonElement get(JsonObject o, String k) {
        if (o == null) return null;
        JsonElement e = o.get(k);
        return (e == null || e.isJsonNull()) ? null : e;
    }

    public static String str(JsonObject o, String k, String def) {
        JsonElement e = get(o, k);
        if (e == null || !e.isJsonPrimitive()) return def;
        return e.getAsString();
    }

    public static String str(JsonObject o, String k) { return str(o, k, null); }

    public static double num(JsonObject o, String k, double def) {
        JsonElement e = get(o, k);
        if (e == null || !e.isJsonPrimitive()) return def;
        try { return e.getAsDouble(); } catch (RuntimeException ex) { return def; }
    }

    public static Double numOrNull(JsonObject o, String k) {
        JsonElement e = get(o, k);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) return null;
        return e.getAsDouble();
    }

    public static long lng(JsonObject o, String k, long def) {
        JsonElement e = get(o, k);
        if (e == null || !e.isJsonPrimitive()) return def;
        try { return e.getAsLong(); } catch (RuntimeException ex) {
            try { return (long) e.getAsDouble(); } catch (RuntimeException ex2) { return def; }
        }
    }

    public static int integer(JsonObject o, String k, int def) { return (int) lng(o, k, def); }

    public static boolean bool(JsonObject o, String k, boolean def) {
        JsonElement e = get(o, k);
        if (e == null || !e.isJsonPrimitive()) return def;
        if (e.getAsJsonPrimitive().isBoolean()) return e.getAsBoolean();
        if (e.getAsJsonPrimitive().isNumber()) return e.getAsDouble() != 0;
        return "true".equalsIgnoreCase(e.getAsString());
    }

    public static JsonObject obj(JsonObject o, String k) {
        JsonElement e = get(o, k);
        return (e != null && e.isJsonObject()) ? e.getAsJsonObject() : null;
    }

    public static JsonArray arr(JsonObject o, String k) {
        JsonElement e = get(o, k);
        return (e != null && e.isJsonArray()) ? e.getAsJsonArray() : null;
    }

    public static JsonArray arr(JsonElement e) { return (e != null && e.isJsonArray()) ? e.getAsJsonArray() : null; }
    public static JsonObject obj(JsonElement e) { return (e != null && e.isJsonObject()) ? e.getAsJsonObject() : null; }

    public static double at(JsonArray a, int i, double def) {
        if (a == null || i >= a.size()) return def;
        JsonElement e = a.get(i);
        if (e == null || !e.isJsonPrimitive()) return def;
        try { return e.getAsDouble(); } catch (RuntimeException ex) { return def; }
    }

    public static String strAt(JsonArray a, int i, String def) {
        if (a == null || i >= a.size()) return def;
        JsonElement e = a.get(i);
        if (e == null || !e.isJsonPrimitive()) return def;
        return e.getAsString();
    }

    /** "#RRGGBB" / "RRGGBB" / "#RGB" to 0xRRGGBB, or def. */
    public static int parseColor(String s, int def) {
        if (s == null) return def;
        String h = s.trim();
        if (h.startsWith("#")) h = h.substring(1);
        if (h.length() == 3) h = "" + h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
        if (h.length() != 6) return def;
        try { return Integer.parseInt(h, 16) & 0xFFFFFF; } catch (NumberFormatException e) { return def; }
    }

    /** Colour from the int key if present, else the string key, else def. */
    public static int color(JsonObject o, String strKey, String intKey, int def) {
        if (intKey != null) {
            Double d = numOrNull(o, intKey);
            if (d != null) return d.intValue() & 0xFFFFFF;
        }
        return parseColor(str(o, strKey), def);
    }
}
