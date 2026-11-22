package com.hivecraft.overlay.core;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/** Config, fades, tooltip text, fx rules, guard. */
class HelpersTest {

    // ------------------------------------------------------------------ config

    @Test
    void configDefaultsRoundTripAndSanitize(@org.junit.jupiter.api.io.TempDir Path dir) throws Exception {
        Path f = dir.resolve("config").resolve("hivecraft.json");
        HiveConfig c = HiveConfig.load(f); // missing file -> defaults
        assertEquals("http://127.0.0.1:47960", c.bridgeUrl);
        assertEquals("ws://127.0.0.1:47960/mod", c.wsUrl());
        c.trails = false;
        c.ledgerBot = "Ash";
        c.ui.addProperty("hudScale", 2);
        c.save(f);
        HiveConfig d = HiveConfig.load(f);
        assertFalse(d.trails);
        assertEquals("Ash", d.ledgerBot);
        assertEquals(2, d.ui.get("hudScale").getAsInt());
        assertEquals("key.keyboard.o", d.keys.get("toggle_world"));

        List<String> warnings = new ArrayList<>();
        Guard.get().setSink((m, t) -> warnings.add(m + (t != null ? " / " + t : "")));
        Files.writeString(f, "{\"trailSeconds\":99999,\"ghostAlpha\":7,\"keys\":{\"toggle_world\":\"key.keyboard.p\"},\"ui\":null}");
        HiveConfig e = HiveConfig.load(f);
        assertEquals(List.of(), warnings);
        assertEquals(600, e.trailSeconds);
        assertEquals(1f, e.ghostAlpha);
        assertEquals("key.keyboard.p", e.keys.get("toggle_world"));
        assertEquals("key.keyboard.i", e.keys.get("cycle_ledger_bot")); // missing defaults filled
        assertNotNull(e.ui);
        assertTrue(e.ledger); // missing field keeps default

        Files.writeString(f, "{ not json");
        HiveConfig bad = HiveConfig.load(f);
        assertTrue(bad.worldOverlay);
        assertTrue(Files.exists(dir.resolve("config").resolve("hivecraft.json.bad")));
    }

    @Test
    void bridgeUrlForms() {
        HiveConfig c = new HiveConfig();
        c.bridgeUrl = "127.0.0.1:47960/";
        assertEquals("http://127.0.0.1:47960", c.httpBase());
        assertEquals("ws://127.0.0.1:47960/mod", c.wsUrl());
        c.bridgeUrl = "ws://localhost:47960/mod";
        assertEquals("http://localhost:47960", c.httpBase());
        assertEquals("ws://localhost:47960/mod", c.wsUrl());
        c.bridgeUrl = "https://x.example";
        assertEquals("wss://x.example/mod", c.wsUrl());
        c.bridgeUrl = " ";
        assertEquals("http://127.0.0.1:47960", c.httpBase());
    }

    @Test
    void ledgerBotCycle() {
        List<String> n = List.of("Ash", "Flint", "Wren");
        assertEquals("Ash", HiveConfig.cycleBot(n, ""));
        assertEquals("Flint", HiveConfig.cycleBot(n, "ash"));
        assertEquals("", HiveConfig.cycleBot(n, "Wren"));
        assertEquals("Ash", HiveConfig.cycleBot(n, "Gone"));
        assertEquals("", HiveConfig.cycleBot(List.of(), "Ash"));
    }

    // ------------------------------------------------------------------- fades

    @Test
    void fades() {
        assertEquals(1f, Fade.age(1000, 1000, 500));
        assertEquals(0.5f, Fade.age(1250, 1000, 500), 1e-6);
        assertEquals(0f, Fade.age(5000, 1000, 500));
        assertEquals(1f, Fade.age(900, 1000, 500)); // future ts clamps
        assertEquals(1f, Fade.distance(10, 100, 0.7));
        assertEquals(0f, Fade.distance(100, 100, 0.7));
        float mid = Fade.distance(85, 100, 0.7);
        assertTrue(mid > 0 && mid < 1);
        assertTrue(Fade.distance(80, 100, 0.7) > Fade.distance(90, 100, 0.7));
        assertEquals(0f, Fade.popEnvelope(0));
        assertEquals(1f, Fade.popEnvelope(0.5));
        assertEquals(0f, Fade.popEnvelope(1));
        assertEquals(0x80FF0000, Fade.argb(0xFF0000, 128 / 255f));
        assertEquals(0xFFFFFF, Fade.lighten(0x000000, 1f));
        assertEquals(0x123456, Fade.lighten(0x123456, 0f));
        assertEquals("5s ago", Fade.ago(10_000, 5_000));
        assertEquals("3m ago", Fade.ago(200_000, 0));
        assertEquals("2h ago", Fade.ago(2 * 3600_000L + 5, 0));
        assertEquals("1d ago", Fade.ago(25 * 3600_000L, 0));
        assertEquals("0s ago", Fade.ago(0, 1000));
    }

    // -------------------------------------------------------------- tooltip text

    @Test
    void tooltipText() {
        long now = 1_000_000;
        LedgerEvent built = new LedgerEvent(1, now - 180_000, "Ash", "place", "oak_stairs", "facing=east", "air",
                11, 65, 6, "overworld", "blueprint", "blueprint_build", "cottage_10_64_5", 12, "place");
        assertEquals("Placed by Ash · 3m ago · cottage build #cottage_10_64_5 sec 12", LedgerText.headline(built, now));
        assertEquals("Oak Stairs", LedgerText.detail(built));
        LedgerEvent mined = new LedgerEvent(2, now - 12_000, "Flint", "break", "minecraft:iron_ore", "", null,
                40, 12, -80, "overworld", "mine", "mine_block", null, -1, null);
        assertEquals("Broken by Flint · 12s ago · mining", LedgerText.headline(mined, now));
        assertEquals("was Iron Ore", LedgerText.detail(mined));
        LedgerEvent replaced = new LedgerEvent(3, now, "Wren", "place", "cobblestone", "", "grass_block",
                0, 0, 0, "overworld", "pathfinder-place", "goto", null, -1, null);
        assertEquals("Cobblestone (replaced Grass Block)", LedgerText.detail(replaced));
        assertTrue(LedgerText.headline(replaced, now).endsWith("bridged while walking"));
        assertEquals("house", LedgerText.blueprintOf("house_10_64_5"));
        assertEquals("big_house", LedgerText.blueprintOf("big_house_-10_64_-5"));
        assertNull(LedgerText.blueprintOf("b12"));
        assertEquals("", LedgerText.historySummary(1));
        assertEquals("3 changes", LedgerText.historySummary(3));
        LedgerEvent weird = new LedgerEvent(4, now, "A", "place", "dirt", "", null, 0, 0, 0, "overworld", "my_action", null, null, -1, null);
        assertTrue(LedgerText.headline(weird, now).endsWith("my action"));
    }

    // --------------------------------------------------------------- fx rules

    @Test
    void fxRules() {
        assertEquals(FxRules.Kind.CRAFT, FxRules.forAction("craft").kind());
        assertEquals("iron_sword", FxRules.forAction("attack").item());
        assertEquals(FxRules.Kind.ATTACK, FxRules.forAction("hunt").kind());
        assertEquals("furnace", FxRules.forAction("smelt").item());
        assertNull(FxRules.forAction("goto"));
        assertNull(FxRules.forAction(null));
        LedgerEvent torch = new LedgerEvent(1, 0, "A", "place", "wall_torch", "", null, 0, 0, 0, "overworld", "place", null, null, -1, null);
        assertEquals("torch", FxRules.forLedger(torch).item());
        assertEquals(FxRules.Kind.PLACE, FxRules.forLedger(torch).kind());
        LedgerEvent ore = new LedgerEvent(2, 0, "A", "break", "minecraft:iron_ore", "", null, 0, 0, 0, "overworld", "mine", null, null, -1, null);
        assertEquals("iron_ore", FxRules.forLedger(ore).item());
        assertEquals(FxRules.Kind.BREAK, FxRules.forLedger(ore).kind());
        assertEquals("oak_sign", FxRules.itemFor("oak_wall_sign"));
    }

    // ------------------------------------------------------------------ guard

    @Test
    void guardContainsLogsRateLimitedAndDisablesRepeatOffenders() {
        AtomicLong clock = new AtomicLong(0);
        Guard g = new Guard(clock::get);
        List<String> logs = new ArrayList<>();
        g.setSink((m, t) -> logs.add(m));

        assertTrue(g.run("ok", () -> {}));
        assertFalse(g.run("ghosts", () -> { throw new IllegalStateException("bad vertex"); }));
        assertEquals(1, logs.size());
        assertTrue(logs.get(0).contains("ghosts") && logs.get(0).contains("bad vertex"));
        clock.addAndGet(100);
        g.run("ghosts", () -> { throw new IllegalStateException("bad vertex"); });
        assertEquals(1, logs.size()); // same message within a minute: not logged again
        assertFalse(g.isDisabled("ghosts"));
        for (int i = 0; i < Guard.DISABLE_AFTER; i++) { clock.addAndGet(100); g.run("ghosts", () -> { throw new IllegalStateException("bad vertex"); }); }
        assertTrue(g.isDisabled("ghosts"));
        assertEquals(List.of("ghosts"), g.disabledLayers());
        assertTrue(logs.stream().anyMatch(m -> m.contains("disabled")));
        // disabled layer is skipped, others keep running
        boolean[] ran = {false};
        assertFalse(g.run("ghosts", () -> ran[0] = true));
        assertFalse(ran[0]);
        assertTrue(g.run("labels", () -> {}));
        g.reset("ghosts");
        assertTrue(g.disabledLayers().isEmpty());
        assertTrue(g.run("ghosts", () -> {}));
    }

    @Test
    void guardSpreadOutFailuresDoNotDisable() {
        AtomicLong clock = new AtomicLong(0);
        Guard g = new Guard(clock::get);
        for (int i = 0; i < 20; i++) {
            clock.addAndGet(Guard.WINDOW_MS / 2);
            g.run("rare", () -> { throw new RuntimeException("x"); });
        }
        assertFalse(g.isDisabled("rare"));
        assertEquals("java.lang.RuntimeException: x", g.lastError("rare"));
    }

    @Test
    void guardLogsAgainAfterAMinuteAndSinkFailuresAreSwallowed() {
        AtomicLong clock = new AtomicLong(0);
        Guard g = new Guard(clock::get);
        List<String> logs = new ArrayList<>();
        g.setSink((m, t) -> logs.add(m));
        g.warn("k", "m", null);
        g.warn("k", "m", null);
        clock.addAndGet(Guard.LOG_EVERY_MS + 1);
        g.warn("k", "m", null);
        g.warn("k", "other", null);
        assertEquals(3, logs.size());
        g.setSink((m, t) -> { throw new RuntimeException("logger broke"); });
        assertDoesNotThrow(() -> g.warn("k", "new", null));
    }
}
