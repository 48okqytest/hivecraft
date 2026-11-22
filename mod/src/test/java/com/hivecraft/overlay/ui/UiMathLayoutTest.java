package com.hivecraft.overlay.ui;

import com.hivecraft.overlay.ui.hud.Ticker;
import com.hivecraft.overlay.ui.layout.HudLayout;
import com.hivecraft.overlay.ui.layout.HudLayout.Anchor;
import com.hivecraft.overlay.ui.layout.HudLayout.Placement;
import com.hivecraft.overlay.ui.layout.HudLayout.Rect;
import com.hivecraft.overlay.ui.util.UiMath;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class UiMathLayoutTest {

    @Test
    void bearingRelativeToYaw() {
        // facing south (+Z, yaw 0): target straight south is ahead
        assertEquals(0, UiMath.relativeBearing(0, 0, 0, 0, 10), 1e-6);
        // facing south, target to the west (-X) is on the right (+90)
        assertEquals(90, UiMath.relativeBearing(0, 0, 0, -10, 0), 1e-6);
        assertEquals(-90, UiMath.relativeBearing(0, 0, 0, 10, 0), 1e-6);
        // facing north (yaw 180), target south is behind
        assertEquals(180, Math.abs(UiMath.relativeBearing(0, 0, 180, 0, 10)), 1e-6);
        // facing east (yaw -90 / 270), target east ahead
        assertEquals(0, UiMath.relativeBearing(0, 0, -90, 10, 0), 1e-6);
        assertEquals(0, UiMath.relativeBearing(0, 0, 270, 10, 0), 1e-6);
    }

    @Test
    void compassAndWrap() {
        assertEquals("N", UiMath.compass(0, -5));
        assertEquals("E", UiMath.compass(5, 0));
        assertEquals("SW", UiMath.compass(-5, 5));
        assertEquals(-170, UiMath.wrapDeg(190), 1e-9);
        assertEquals(180, UiMath.wrapDeg(-180), 1e-9);
    }

    @Test
    void formats() {
        assertEquals("37m", UiMath.formatDistance(37.4));
        assertEquals("1.2km", UiMath.formatDistance(1234));
        assertEquals("now", UiMath.formatAge(1000));
        assertEquals("12s", UiMath.formatAge(12_000));
        assertEquals("3m", UiMath.formatAge(185_000));
        assertEquals("3m05s", UiMath.formatDuration(185_000));
        assertEquals("1h05m", UiMath.formatDuration(65 * 60_000));
        assertEquals("oak planks", UiMath.prettyId("minecraft:oak_planks"));
        assertEquals("abc…", UiMath.ellipsize("abcdefg", 4));
    }

    @Test
    void animationHelpers() {
        double v = 0;
        for (int i = 0; i < 120; i++) v = UiMath.approach(v, 1, 1 / 60.0, 12);
        assertEquals(1, v, 1e-3);
        // frame-rate independent: 2 half steps == 1 full step
        double a = UiMath.approach(UiMath.approach(0, 1, 0.05, 8), 1, 0.05, 8);
        double b = UiMath.approach(0, 1, 0.1, 8);
        assertEquals(b, a, 1e-9);
        assertEquals(0.5, UiMath.fade(125, 1000, 250, 250), 1e-9);
        assertEquals(1, UiMath.fade(500, 1000, 250, 250), 1e-9);
        assertEquals(0, UiMath.fade(1000, 1000, 250, 250), 1e-9);
        assertEquals(0x80FFFFFF, UiMath.withAlpha(0xFFFFFFFF, 128 / 255.0));
        int c = UiMath.lerpColor(0xFF000000, 0xFFFFFFFF, 0.5);
        assertEquals(0xFF, (c >>> 24) & 0xFF);
        assertTrue(((c >> 16) & 0xFF) >= 127 && ((c >> 16) & 0xFF) <= 128);
        assertEquals(0xFF4CE06A, UiMath.healthColor(1));
        assertEquals(0xFFFF4545, UiMath.healthColor(0));
    }

    // ------------------------------------------------------------ layout

    @Test
    void anchorsPlaceAtEdges() {
        int sw = 480, sh = 270;
        assertEquals(new Rect(4, 4, 100, 50), HudLayout.place(new Placement(Anchor.TOP_LEFT, 0, 0), 100, 50, sw, sh));
        assertEquals(new Rect(sw - 104, 4, 100, 50), HudLayout.place(new Placement(Anchor.TOP_RIGHT, 0, 0), 100, 50, sw, sh));
        assertEquals(new Rect(190, sh - 54, 100, 50), HudLayout.place(new Placement(Anchor.BOTTOM_CENTER, 0, 0), 100, 50, sw, sh));
        assertEquals(new Rect(14, 24, 100, 50), HudLayout.place(new Placement(Anchor.TOP_LEFT, 10, 20), 100, 50, sw, sh));
    }

    @Test
    void clampsIntoScreen() {
        Rect r = HudLayout.resolve(new Placement(Anchor.TOP_RIGHT, 500, -300), 100, 50, 480, 270, List.of());
        assertEquals(new Rect(380, 0, 100, 50), r);
    }

    @Test
    void neverCoversCrosshairOrHotbar() {
        int[][] screens = {{320, 240}, {427, 240}, {480, 270}, {640, 360}, {960, 540}};
        for (int[] s : screens) {
            int sw = s[0], sh = s[1];
            List<Rect> keep = HudLayout.vanillaKeepClear(sw, sh);
            for (Anchor a : Anchor.values()) {
                for (int dx = -60; dx <= 60; dx += 30) {
                    Rect r = HudLayout.resolve(new Placement(a, dx, 0), 90, 40, sw, sh, keep);
                    for (Rect k : keep) assertFalse(r.intersects(k), a + " dx=" + dx + " " + sw + "x" + sh + " " + r + " hits " + k);
                    assertTrue(r.x() >= 0 && r.y() >= 0 && r.right() <= sw && r.bottom() <= sh, "on screen " + r);
                }
            }
        }
    }

    @Test
    void dropPicksNearestAnchorAndRoundTrips() {
        int sw = 480, sh = 270;
        Rect dropped = new Rect(400, 220, 70, 40); // bottom-right area
        Placement p = HudLayout.fromRect(dropped, sw, sh);
        assertEquals(Anchor.BOTTOM_RIGHT, p.anchor());
        assertEquals(dropped, HudLayout.place(p, 70, 40, sw, sh));
        // after a window resize it stays glued to the bottom-right corner
        Rect after = HudLayout.place(p, 70, 40, 640, 360);
        assertEquals(640 - (sw - dropped.right()), after.right());
        assertEquals(Anchor.TOP_LEFT, HudLayout.fromRect(new Rect(10, 10, 50, 20), sw, sh).anchor());
        assertEquals(Anchor.CENTER, HudLayout.fromRect(new Rect(215, 120, 50, 30), sw, sh).anchor());
    }

    @Test
    void stackAndColumns() {
        assertArrayEquals(new int[]{10, 32, 44}, HudLayout.stack(10, new int[]{20, 10, 5}, 2));
        assertEquals(3, HudLayout.columns(300, 90, 6, 8));
        assertEquals(2, HudLayout.columns(300, 90, 6, 2));
        assertEquals(1, HudLayout.columns(50, 90, 6, 5));
    }

    // ------------------------------------------------------------ ticker

    @Test
    void tickerMergesBlocksAndExpires() {
        Ticker t = new Ticker(6, 8000);
        t.blocks("Ash", 0xF2B134, "placed", "oak_planks", 1, 0);
        t.blocks("Ash", 0xF2B134, "placed", "oak_planks", 1, 500);
        t.blocks("Flint", 0x4FC3F7, "broke", "iron_ore", 1, 600);
        t.blocks("Ash", 0xF2B134, "placed", "oak_planks", 10, 1000);
        List<Ticker.Entry> v = t.visible(1000);
        assertEquals(2, v.size());
        assertEquals("Ash placed 12 oak planks", v.get(1).plain()); // merged + moved to newest
        assertEquals("Flint broke 1 iron ore", v.get(0).plain());
        long later = 1000 + Ticker.MERGE_MS + 1;
        t.blocks("Ash", 0xF2B134, "placed", "oak_planks", 1, later);
        assertEquals(3, t.visible(later).size());
        assertEquals(0, t.visible(100_000).size());
    }

    @Test
    void tickerFadeAndCap() {
        Ticker t = new Ticker(3, 8000);
        for (int i = 0; i < 5; i++) t.push(Ticker.Kind.CHAT, 0, null, i, List.of());
        assertEquals(3, t.size());
        Ticker.Entry e = t.push(Ticker.Kind.CHAT, 0, null, 0, List.of());
        assertEquals(0, e.alpha(0, 8000), 1e-9);
        assertEquals(1, e.alpha(4000, 8000), 1e-9);
        assertEquals(0.5, e.alpha(8000 - 750, 8000), 1e-9);
    }
}
