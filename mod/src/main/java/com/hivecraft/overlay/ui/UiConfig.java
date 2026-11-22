package com.hivecraft.overlay.ui;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.ui.layout.HudLayout.Anchor;
import com.hivecraft.overlay.ui.layout.HudLayout.Placement;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * HUD / screen settings, stored in the free {@code ui} object of config/hivecraft.json
 * ({@link com.hivecraft.overlay.core.HiveConfig#ui}). Load once, mutate, {@link #save()}.
 */
public final class UiConfig {
    private static final Gson GSON = new Gson();

    public static final String TEAM = "team", TICKER = "ticker", GOAL = "goal", BUILDS = "builds";

    // HUD
    public boolean hud = true;
    public boolean team = true;
    public boolean ticker = true;
    public boolean goal = true;
    public boolean builds = true;
    public boolean compact = false;        // one-line bot rows instead of cards
    public boolean showThoughts = false;   // bot's last thought under the action
    public float hudScale = 1.0f;          // extra scale on top of GUI scale (0.5..2)
    public int tickerSeconds = 9;
    public boolean tickerChat = true, tickerBlocks = true, tickerTasks = true, tickerEvents = true;
    public float panelOpacity = 0.72f;
    // economy
    public boolean econChip = true;       // coin balance chip by the team panel
    public boolean tickerEcon = true;     // sales / purchases / outbid / won in the ticker
    // terminal
    public boolean terminalShowsChat = true;
    public float terminalOpacity = 0.88f;
    public boolean crt = true;             // scanlines + glow
    public java.util.List<String> history = new java.util.ArrayList<>(); // terminal command history (last 100)
    // spectate camera
    public float spectateDistance = 6f, spectateHeight = 3f;

    public Map<String, Pos> pos = defaults();

    public static final class Pos {
        public String a;
        public int dx, dy;

        public Pos() {}

        Pos(Anchor a, int dx, int dy) {
            this.a = a.name();
            this.dx = dx;
            this.dy = dy;
        }
    }

    static Map<String, Pos> defaults() {
        Map<String, Pos> m = new LinkedHashMap<>();
        m.put(TEAM, new Pos(Anchor.TOP_LEFT, 0, 0));
        m.put(GOAL, new Pos(Anchor.TOP_CENTER, 0, 0));
        m.put(TICKER, new Pos(Anchor.BOTTOM_RIGHT, 0, 0));   // bottom-left belongs to vanilla chat
        m.put(BUILDS, new Pos(Anchor.TOP_RIGHT, 0, 0));
        return m;
    }

    public Placement placement(String panel) {
        Pos p = pos.get(panel);
        if (p == null) {
            p = defaults().get(panel);
            if (p == null) p = new Pos(Anchor.TOP_LEFT, 0, 0);
            pos.put(panel, p);
        }
        return new Placement(Anchor.of(p.a, Anchor.TOP_LEFT), p.dx, p.dy);
    }

    public void setPlacement(String panel, Placement pl) {
        pos.put(panel, new Pos(pl.anchor(), pl.dx(), pl.dy()));
    }

    public void resetLayout() {
        pos = defaults();
    }

    UiConfig sanitize() {
        if (pos == null) pos = defaults();
        if (history == null) history = new java.util.ArrayList<>();
        if (history.size() > 100) history = new java.util.ArrayList<>(history.subList(history.size() - 100, history.size()));
        for (Map.Entry<String, Pos> e : defaults().entrySet()) pos.putIfAbsent(e.getKey(), e.getValue());
        hudScale = clamp(hudScale, 0.5f, 2f);
        panelOpacity = clamp(panelOpacity, 0.2f, 1f);
        terminalOpacity = clamp(terminalOpacity, 0.4f, 1f);
        tickerSeconds = Math.max(3, Math.min(60, tickerSeconds));
        spectateDistance = clamp(spectateDistance, 2f, 24f);
        spectateHeight = clamp(spectateHeight, 0f, 16f);
        return this;
    }

    private static float clamp(float v, float lo, float hi) {
        return Float.isNaN(v) ? lo : Math.max(lo, Math.min(hi, v));
    }

    // ------------------------------------------------------------------ persistence

    private static UiConfig current;

    public static synchronized UiConfig get() {
        if (current == null) current = load();
        return current;
    }

    public static UiConfig fromJson(JsonObject o) {
        UiConfig c = null;
        try {
            if (o != null && o.size() > 0) c = GSON.fromJson(o, UiConfig.class);
        } catch (RuntimeException e) {
            Hive.log("ui config unreadable, using defaults: " + e.getMessage());
        }
        return (c == null ? new UiConfig() : c).sanitize();
    }

    public JsonObject toJson() {
        JsonElement e = GSON.toJsonTree(this);
        return e.getAsJsonObject();
    }

    private static UiConfig load() {
        return fromJson(Hive.config().ui);
    }

    /** Writes into HiveConfig.ui and saves config/hivecraft.json. */
    public void save() {
        Hive.config().ui = toJson();
        Hive.saveConfig();
    }
}
