package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Trail decay, ledger cache, ghosts, commands, PosKey. */
class StoresTest {
    static JsonObject j(String s) { return JsonParser.parseString(s).getAsJsonObject(); }

    static LedgerEvent ev(long id, long ts, String bot, String op, int x, int y, int z) {
        return new LedgerEvent(id, ts, bot, op, "stone", "", "air", x, y, z, "overworld", "place", null, null, -1, null);
    }

    // ------------------------------------------------------------------ trails

    @Test
    void trailDeltaAppendsInOrderAndIgnoresOlderPoints() {
        TrailStore t = new TrailStore();
        t.applyDelta(j("{\"Ash\":[[12.3,64,-3.7,1000],[11.0,64,-2.0,2000]]}"));
        t.applyDelta(j("{\"Ash\":[[10,64,-1,1500],[9,64,0,3000]],\"Flint\":[[0,0,0,10]]}"));
        List<TrailStore.Point> a = t.get("Ash", 3000, 10_000);
        assertEquals(3, a.size());
        assertEquals(List.of(1000L, 2000L, 3000L), a.stream().map(TrailStore.Point::ts).toList());
        assertEquals(1, t.get("Flint", 3000, 10_000).size());
    }

    @Test
    void trailDecayDropsOldPoints() {
        TrailStore t = new TrailStore();
        t.applyDelta(j("{\"Ash\":[[0,0,0,1000],[1,0,0,5000],[2,0,0,9000]]}"));
        assertEquals(2, t.get("Ash", 10_000, 6_000).size()); // window filter
        t.prune(10_000, 2_000);
        assertEquals(1, t.get("Ash", 10_000, 100_000).size());
        t.prune(20_000, 2_000);
        assertTrue(t.bots().isEmpty());
    }

    @Test
    void trailCapsPoints() {
        TrailStore t = new TrailStore();
        for (int i = 0; i < TrailStore.MAX_POINTS + 50; i++) t.add("A", new TrailStore.Point(i, 0, 0, i + 1));
        List<TrailStore.Point> p = t.get("A", TrailStore.MAX_POINTS + 50, Long.MAX_VALUE / 4);
        assertEquals(TrailStore.MAX_POINTS, p.size());
        assertEquals(51, p.get(0).ts());
    }

    @Test
    void trailFullSnapshotKeepsNewerLocalPoints() {
        TrailStore t = new TrailStore();
        t.applyDelta(j("{\"Ash\":[[5,0,0,5000],[6,0,0,6000]]}"));
        t.applyFull(j("{\"Ash\":[[1,0,0,1000],[2,0,0,2000],[5,0,0,5000]]}"));
        assertEquals(List.of(1000L, 2000L, 5000L, 6000L), t.get("Ash", 6000, 100_000).stream().map(TrailStore.Point::ts).toList());
    }

    // ------------------------------------------------------------------ ledger

    @Test
    void ledgerDedupesAndKeepsLatestPerBlock() {
        LedgerCache c = new LedgerCache();
        List<LedgerEvent> added = c.addAll(List.of(ev(2, 200, "Ash", "break", 1, 2, 3), ev(1, 100, "Ash", "place", 1, 2, 3)));
        assertEquals(2, added.size());
        assertEquals(1, added.get(0).id()); // sorted by ts
        assertEquals(0, c.addAll(List.of(ev(1, 100, "Ash", "place", 1, 2, 3))).size());
        LedgerEvent last = c.latestAt(1, 2, 3, "overworld");
        assertEquals(2, last.id());
        assertTrue(last.isBreak());
        assertNull(c.latestAt(1, 2, 3, "nether"));
        assertEquals(1, c.latestPerBlock("overworld", 0, null).size());
    }

    @Test
    void ledgerFilterByBotAndAge() {
        LedgerCache c = new LedgerCache();
        c.addAll(List.of(ev(1, 1000, "Ash", "place", 0, 64, 0), ev(2, 5000, "Flint", "place", 1, 64, 0), ev(3, 9000, "ash", "break", 2, 64, 0)));
        assertEquals(2, c.latestPerBlock("overworld", 0, "ASH").size());
        assertEquals(2, c.latestPerBlock("overworld", 4000, "").size());
        assertEquals(1, c.latestPerBlock("overworld", 4000, "Flint").size());
        c.prune(10_000, 3_000);
        assertEquals(1, c.latestPerBlock("overworld", 0, null).size());
        // recent feed is newest first and unaffected by prune
        assertEquals(List.of(3L, 2L, 1L), c.recent(10, null).stream().map(LedgerEvent::id).toList());
        assertEquals(List.of(3L, 1L), c.recent(10, "ash").stream().map(LedgerEvent::id).toList());
    }

    @Test
    void ledgerRecentIsCapped() {
        LedgerCache c = new LedgerCache();
        List<LedgerEvent> l = new ArrayList<>();
        for (int i = 0; i < LedgerCache.MAX_RECENT + 100; i++) l.add(ev(i, i, "Ash", "place", i, 64, 0));
        c.addAll(l);
        assertEquals(LedgerCache.MAX_RECENT, c.size());
        assertEquals(LedgerCache.MAX_RECENT + 99, c.recent(1, null).get(0).id());
    }

    @Test
    void ledgerAtCacheFetchLifecycle() {
        LedgerCache c = new LedgerCache();
        assertTrue(c.beginFetch(11, 65, 6, "overworld", 1000));
        assertFalse(c.beginFetch(11, 65, 6, "overworld", 1001)); // in flight
        LedgerCache.AtResult r = LedgerCache.AtResult.parse(j("""
                {"ok":true,"x":11,"y":65,"z":6,"dim":"overworld",
                 "history":[{"id":5,"ts":100,"bot":"Ash","op":"place","block":"oak_stairs","x":11,"y":65,"z":6,"build":"house_10_64_5","section":1}],
                 "last":{"id":5,"ts":100,"bot":"Ash","op":"place","block":"oak_stairs","x":11,"y":65,"z":6,"build":"house_10_64_5","section":1}}"""), 1002);
        c.endFetch(11, 65, 6, "overworld", r, 1002);
        LedgerCache.AtResult got = c.getAt(11, 65, 6, "overworld");
        assertEquals("Ash", got.last().bot());
        assertFalse(c.beginFetch(11, 65, 6, "overworld", 1002 + LedgerCache.AT_TTL_MS - 1)); // fresh
        assertTrue(c.beginFetch(11, 65, 6, "overworld", 1002 + LedgerCache.AT_TTL_MS + 1));  // stale
        long t = 1002 + LedgerCache.AT_TTL_MS + 2;
        c.endFetch(11, 65, 6, "overworld", null, t); // failure keeps the old answer
        assertNotNull(c.getAt(11, 65, 6, "overworld"));
        assertFalse(c.beginFetch(11, 65, 6, "overworld", t + LedgerCache.AT_RETRY_MS - 1)); // backoff after failure
        assertTrue(c.beginFetch(11, 65, 6, "overworld", t + LedgerCache.AT_RETRY_MS + 1));

        // a live event at that block updates the cached answer
        c.addAll(List.of(new LedgerEvent(6, 200, "Flint", "break", "oak_stairs", "", null, 11, 65, 6, "overworld", "mine", null, null, -1, null)));
        got = c.getAt(11, 65, 6, "overworld");
        assertEquals("Flint", got.last().bot());
        assertEquals(2, got.history().size());
    }

    @Test
    void atResultWithoutLastUsesHistory() {
        LedgerCache.AtResult r = LedgerCache.AtResult.parse(j("{\"x\":1,\"y\":2,\"z\":3,\"history\":[{\"id\":1,\"bot\":\"A\"},{\"id\":2,\"bot\":\"B\"}],\"last\":null}"), 0);
        assertEquals("B", r.last().bot());
        LedgerCache.AtResult empty = LedgerCache.AtResult.parse(j("{\"x\":1,\"y\":2,\"z\":3,\"history\":[]}"), 0);
        assertNull(empty.last());
    }

    // ------------------------------------------------------------------- misc

    @Test
    void posKeyRoundTrips() {
        int[][] cases = {{0, 0, 0}, {12, 64, -4}, {-30000000 / 2, -64, 29999999 / 2}, {1, 319, -1}, {-1, -1, -1}};
        for (int[] c : cases) {
            long k = PosKey.pack(c[0], c[1], c[2]);
            assertEquals(c[0], PosKey.x(k));
            assertEquals(c[1], PosKey.y(k));
            assertEquals(c[2], PosKey.z(k));
        }
        assertNotEquals(PosKey.pack(1, 2, 3), PosKey.pack(3, 2, 1));
    }

    @Test
    void ghostWithPlacedClampsAndIgnoresUnknownCells() {
        Ghost g = Ghost.parse(j("{\"id\":\"g\",\"total\":2,\"done\":0,\"blocks\":[[0,0,0,\"stone\",\"\",0],[1,0,0,\"stone\",\"\",0]]}"), null);
        assertSame(g, g.withPlaced(5, 5, 5, true));
        Ghost g1 = g.withPlaced(0, 0, 0, true);
        assertEquals(1, g1.done());
        assertEquals(50, g1.progress());
        assertSame(g1, g1.withPlaced(0, 0, 0, true));
        assertFalse(g.blockAt(0, 0, 0).placed()); // original untouched
        Ghost g2 = g1.withPlaced(1, 0, 0, true);
        assertEquals(100, g2.progress());
        assertEquals(0, g2.remaining());
    }

    @Test
    void commandResultParsing() {
        CommandResult r = CommandResult.parse(j("""
                {"t":"command_result","id":7,"ok":true,"lines":[
                  [{"text":"Ash","color":"#F2B134","bold":true},{"text":"  online  ","color":"#55FF55"},{"text":"mining iron_ore 12/24","color":"#FFFFFF","click":"status Ash"}],
                  [{"text":"  hp 18.5  food 17  at 12 64 -4","color":"#AAAAAA"}]],"data":{"history":[]}}"""));
        assertTrue(r.ok());
        assertEquals(2, r.lines().size());
        CommandResult.Segment s = r.lines().get(0).get(0);
        assertEquals("Ash", s.text());
        assertEquals(0xF2B134, s.color());
        assertTrue(s.bold());
        assertEquals("status Ash", r.lines().get(0).get(2).click());
        assertEquals(-1, CommandResult.parse(j("{\"lines\":[[{\"text\":\"x\"}]]}")).lines().get(0).get(0).color());
        assertNotNull(r.data());
        assertEquals("Ash  online  mining iron_ore 12/24\n  hp 18.5  food 17  at 12 64 -4", r.plainText());

        CommandResult bad = CommandResult.parse(j("{\"ok\":false,\"error\":\"unknown command\"}"));
        assertFalse(bad.ok());
        assertEquals("unknown command", bad.plainText());
        assertEquals(0xFF5555, bad.lines().get(0).get(0).color());
        assertFalse(CommandResult.error("offline").ok());
    }

    @Test
    void colorsAndJsonHelpers() {
        assertEquals(0xF2B134, J.parseColor("#F2B134", 0));
        assertEquals(0xF2B134, J.parseColor("f2b134", 0));
        assertEquals(0xFFAA00, J.parseColor("#FA0", 0));
        assertEquals(7, J.parseColor("nope", 7));
        assertEquals(7, J.parseColor(null, 7));
        JsonObject o = j("{\"c\":\"#000001\",\"ci\":15905076,\"n\":\"12\",\"b\":1,\"s\":5}");
        assertEquals(15905076, J.color(o, "c", "ci", 0));
        assertEquals(1, J.color(o, "c", null, 0));
        assertEquals(12, J.integer(o, "n", 0));
        assertTrue(J.bool(o, "b", false));
        assertEquals("5", J.str(o, "s"));
        assertNull(J.obj(o, "s"));
        assertEquals(3, J.integer(null, "x", 3));
    }

    @Test
    void dimsNormalize() {
        assertEquals("nether", Dims.normalize("minecraft:the_nether"));
        assertEquals("end", Dims.normalize("the_end"));
        assertEquals("overworld", Dims.normalize("minecraft:overworld"));
        assertEquals("overworld", Dims.normalize(null));
        assertEquals("overworld", Dims.normalize("mymod:weird"));
    }

    @Test
    void highlightsExpire() {
        Highlights h = new Highlights();
        h.highlight(1, 2, 3, "overworld", 1000);
        h.highlightBox(5, 5, 5, 0, 0, 0, "the_nether", 60_000, 0x123456, "build");
        long now = System.currentTimeMillis();
        List<Highlights.Box> a = h.active(now);
        assertEquals(2, a.size());
        assertEquals(0, a.get(1).minX());
        assertEquals(5, a.get(1).maxX());
        assertEquals("nether", a.get(1).dim());
        assertEquals(1, h.active(now + 5000).size());
        for (int i = 0; i < Highlights.MAX + 5; i++) h.highlight(i, 0, 0, null, 60_000);
        assertEquals(Highlights.MAX, h.active(now).size());
    }
}
