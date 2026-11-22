package com.hivecraft.overlay.core;

import java.nio.file.Path;
import java.util.function.Consumer;

/**
 * Static access point for the whole mod: {@code Hive.state()}, {@code Hive.client()}, {@code Hive.config()}.
 * Initialised by HivecraftMod before HiveUI.init() runs.
 */
public final class Hive {
    public static final String MOD_ID = "hivecraft";

    private static volatile HiveState state = new HiveState();
    private static volatile HiveConfig config = new HiveConfig().sanitize();
    private static volatile HiveClient client;
    private static volatile Path configPath;
    private static volatile boolean uiDrawsStatus;
    private static volatile Consumer<String> log = s -> {};

    private Hive() {}

    /** Called once by the entrypoint. */
    public static synchronized void init(Path configFile, String modVersion, Consumer<String> logger) {
        log = logger == null ? s -> {} : logger;
        configPath = configFile;
        config = HiveConfig.load(configFile);
        saveConfig(); // writes defaults / new fields
        state.setErrorLog(log);
        client = new HiveClient(state, () -> config, modVersion);
        client.setLog(log);
    }

    public static HiveState state() { return state; }
    public static HiveConfig config() { return config; }
    /** Null only before init. */
    public static HiveClient client() { return client; }

    /** Writes config/hivecraft.json (call after changing config fields). Never throws. */
    public static void saveConfig() {
        Path p = configPath;
        if (p == null) return;
        try { config.save(p); } catch (Exception e) { Guard.get().warn("config", "could not save " + p + ": " + e, e); }
    }

    /** Re-reads the file (e.g. after hand edits) and reconnects if the bridge URL changed. */
    public static void reloadConfig() {
        Path p = configPath;
        if (p == null) return;
        String oldUrl = config.httpBase();
        config = HiveConfig.load(p);
        if (!oldUrl.equals(config.httpBase()) && client != null) client.reconnectNow();
    }

    /** HiveUI sets this to true when its HUD draws the connection indicator (otherwise world code draws a fallback). */
    public static void setUiDrawsStatus(boolean v) { uiDrawsStatus = v; }
    public static boolean uiDrawsStatus() { return uiDrawsStatus; }

    public static void log(String s) { log.accept(s); }

    private static final Highlights highlights = new Highlights();
    private static volatile String focusedBot;

    /** UI-requested world highlights: {@code Hive.highlights().highlight(x,y,z,dim,ms)} / {@code highlightBox(...)}. */
    public static Highlights highlights() { return highlights; }

    /** The bot the UI has focused (K cycles), or null. The world renderer emphasises it (brighter label, thicker trail). */
    public static String focusedBot() { return focusedBot; }
    public static void setFocusedBot(String name) { focusedBot = (name == null || name.isBlank()) ? null : name; }
}
