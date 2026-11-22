package com.hivecraft.overlay.core;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * config/hivecraft.json. Public mutable fields; call {@link Hive#saveConfig()} after changing them.
 * {@code ui} is a free-form object owned by HiveUI (HUD/screens settings); core never reads it.
 * {@code keys}: default key per binding id (translation key form, e.g. "key.keyboard.o"); rebinding in
 * Controls is stored by Minecraft in options.txt and wins over these defaults.
 */
public final class HiveConfig {
    public static final int VERSION = 1;
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    public int version = VERSION;
    public String bridgeUrl = "http://127.0.0.1:47960";
    /** Name sent to the bridge as the local player; blank = the Minecraft session name. */
    public String playerName = "";
    /** Master switch for all in-world rendering. */
    public boolean worldOverlay = true;

    // bot labels
    public boolean labels = true;
    public boolean labelsThroughWalls = true;
    public boolean labelBars = true;
    public boolean labelHeldItem = true;
    public double labelMaxDistance = 128;
    public float labelScale = 1.0f;

    // bot outline + trails + paths
    public boolean outlines = true;
    public boolean trails = true;
    public int trailSeconds = 60;
    public boolean pathLines = true;
    public boolean targetBeacon = true;

    // block attribution
    public boolean ledger = true;
    public boolean ledgerPlaced = true;
    public boolean ledgerBroken = true;
    public int ledgerFadeSeconds = 300;
    public double ledgerMaxDistance = 64;
    /** Only show blocks of this bot (blank = all). Cycled with a key. */
    public String ledgerBot = "";
    public boolean ledgerTooltip = true;

    // ghost builds
    public boolean ghosts = true;
    public float ghostAlpha = 0.45f;
    public boolean ghostShowDone = true;
    public double ghostMaxDistance = 160;

    // waypoints + fx
    public boolean waypoints = true;
    public double waypointMaxDistance = 512;
    public boolean actionFx = true;

    public Map<String, String> keys = defaultKeys();

    public JsonObject ui = new JsonObject();

    public static Map<String, String> defaultKeys() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("toggle_world", "key.keyboard.o");
        m.put("cycle_ledger_bot", "key.keyboard.i");
        m.put("toggle_labels", "key.keyboard.unknown");
        m.put("toggle_trails", "key.keyboard.n");   // paths & trails on/off
        m.put("toggle_ledger", "key.keyboard.b");   // who placed/broke what on/off
        m.put("toggle_ghosts", "key.keyboard.unknown");
        m.put("toggle_xray_labels", "key.keyboard.unknown");
        return m;
    }

    /** Next value of the ledger bot filter: "" (all) -> first bot -> ... -> last bot -> "". */
    public static String cycleBot(java.util.List<String> names, String current) {
        if (names == null || names.isEmpty()) return "";
        if (current == null || current.isEmpty()) return names.get(0);
        for (int i = 0; i < names.size(); i++)
            if (names.get(i).equalsIgnoreCase(current)) return i + 1 < names.size() ? names.get(i + 1) : "";
        return names.get(0);
    }

    /** ws:// URL of the mod socket derived from bridgeUrl. */
    public String wsUrl() {
        String b = httpBase();
        if (b.startsWith("https://")) return "wss://" + b.substring(8) + "/mod";
        if (b.startsWith("http://")) return "ws://" + b.substring(7) + "/mod";
        return "ws://" + b + "/mod";
    }

    /** bridgeUrl without trailing slash, with a scheme. */
    public String httpBase() {
        String b = bridgeUrl == null || bridgeUrl.isBlank() ? "http://127.0.0.1:47960" : bridgeUrl.trim();
        if (b.startsWith("ws://")) b = "http://" + b.substring(5);
        if (b.startsWith("wss://")) b = "https://" + b.substring(6);
        if (!b.startsWith("http://") && !b.startsWith("https://")) b = "http://" + b;
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        if (b.endsWith("/mod")) b = b.substring(0, b.length() - 4);
        return b;
    }

    /** Fills nulls / missing entries after loading an older or hand-edited file. */
    public HiveConfig sanitize() {
        if (bridgeUrl == null) bridgeUrl = "http://127.0.0.1:47960";
        if (playerName == null) playerName = "";
        if (ledgerBot == null) ledgerBot = "";
        if (ui == null) ui = new JsonObject();
        Map<String, String> d = defaultKeys();
        if (keys == null) keys = d;
        else for (var e : d.entrySet()) keys.putIfAbsent(e.getKey(), e.getValue());
        // 0.1.0 shipped these two unbound; give them their new defaults unless the user picked a key.
        for (String k : new String[] { "toggle_trails", "toggle_ledger" })
            if ("key.keyboard.unknown".equals(keys.get(k))) keys.put(k, d.get(k));
        trailSeconds = Math.max(5, Math.min(600, trailSeconds));
        ledgerFadeSeconds = Math.max(10, Math.min(3600, ledgerFadeSeconds));
        ghostAlpha = Math.max(0.05f, Math.min(1f, ghostAlpha));
        labelScale = Math.max(0.25f, Math.min(4f, labelScale));
        return this;
    }

    public static HiveConfig load(Path file) {
        if (file != null && Files.isRegularFile(file)) {
            try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
                HiveConfig c = fromTree(com.google.gson.JsonParser.parseReader(r));
                if (c != null) return c.sanitize();
            } catch (Exception e) {
                // corrupt file: keep a copy, fall back to defaults
                Guard.get().warn("config", "could not read " + file + ", using defaults (copy kept as .bad): " + e, e);
                try { Files.copy(file, file.resolveSibling(file.getFileName() + ".bad"), StandardCopyOption.REPLACE_EXISTING); }
                catch (IOException ce) { Guard.get().warn("config", "could not back up bad config: " + ce, null); }
            }
        }
        return new HiveConfig().sanitize();
    }

    public synchronized void save(Path file) throws IOException {
        Files.createDirectories(file.getParent());
        Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
        try (Writer w = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) { GSON.toJson(this, w); }
        try { Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
        catch (IOException e) { Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING); }
    }

    public String toJson() { return GSON.toJson(this); }

    public static HiveConfig fromJson(String s) {
        HiveConfig c = fromTree(com.google.gson.JsonParser.parseString(s));
        return (c == null ? new HiveConfig() : c).sanitize();
    }

    /** Hand-edit tolerant: null values and a non-object "ui" fall back to defaults instead of failing the whole file. */
    private static HiveConfig fromTree(com.google.gson.JsonElement el) {
        if (el == null || !el.isJsonObject()) return null;
        JsonObject o = el.getAsJsonObject().deepCopy();
        o.entrySet().removeIf(e -> e.getValue() == null || e.getValue().isJsonNull());
        if (o.has("ui") && !o.get("ui").isJsonObject()) o.remove("ui");
        if (o.has("keys") && !o.get("keys").isJsonObject()) o.remove("keys");
        return GSON.fromJson(o, HiveConfig.class);
    }
}
