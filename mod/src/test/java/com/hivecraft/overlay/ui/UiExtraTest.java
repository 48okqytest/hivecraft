package com.hivecraft.overlay.ui;

import com.google.gson.JsonObject;
import com.hivecraft.overlay.ui.layout.HudLayout;
import com.hivecraft.overlay.ui.layout.HudLayout.Anchor;
import com.hivecraft.overlay.ui.layout.HudLayout.Placement;
import com.hivecraft.overlay.ui.layout.HudLayout.Rect;
import com.hivecraft.overlay.ui.layout.MapProjection;
import com.hivecraft.overlay.ui.term.LineEditor;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class UiExtraTest {

    // ------------------------------------------------------------ line editor

    @Test
    void editorInsertsAtCursorAndDeletes() {
        LineEditor e = new LineEditor(50);
        e.insert("stat Ash");
        e.set(e.text(), 4);
        e.insert("us");
        assertEquals("status Ash", e.text());
        assertEquals(6, e.cursor());
        e.backspace();
        assertEquals("statu Ash", e.text());
        e.end();
        e.backspace();
        e.home();
        e.delete();
        assertEquals("tatu As", e.text());
    }

    @Test
    void editorWordOpsAndKills() {
        LineEditor e = new LineEditor(80);
        e.insert("say all  build a wall");
        e.deleteWordLeft();
        assertEquals("say all  build a ", e.text());
        e.jumpWordLeft();
        assertEquals("say all  build ".length(), e.cursor());
        e.jumpWordLeft();
        assertEquals("say all  ".length(), e.cursor());
        e.deleteWordRight();
        assertEquals("say all   a ", e.text());
        e.killToEnd();
        assertEquals("say all  ", e.text());
        e.set("abc def", 4);
        e.killToStart();
        assertEquals("def", e.text());
        assertEquals(0, e.cursor());
    }

    @Test
    void editorSanitizesAndCaps() {
        LineEditor e = new LineEditor(10);
        e.insert("a\nb\tc§d\u0007e");
        assertEquals("a b cde", e.text());
        e.insert("0123456789");
        assertEquals(10, e.text().length());
    }

    // ------------------------------------------------------------ layout on small screens

    @Test
    void tinyScreenStillAvoidsZones() {
        // 320x240 (e.g. 1280x960 at GUI scale 4): hotbar, tooltip and crosshair zones stack in the middle
        List<Rect> keep = HudLayout.vanillaKeepClear(320, 240);
        Rect r = HudLayout.resolve(new Placement(Anchor.BOTTOM_CENTER, 0, 0), 90, 40, 320, 240, keep);
        for (Rect k : keep) assertFalse(r.intersects(k), r + " hits " + k);
        assertTrue(r.bottom() <= 240 && r.y() >= 0);
    }

    @Test
    void freeSpotIsUntouched() {
        List<Rect> keep = HudLayout.vanillaKeepClear(480, 270);
        Rect r = HudLayout.resolve(new Placement(Anchor.TOP_LEFT, 0, 0), 156, 100, 480, 270, keep);
        assertEquals(new Rect(4, 4, 156, 100), r);
    }

    // ------------------------------------------------------------ map projection

    @Test
    void mapRoundTripsAndNorthIsUp() {
        MapProjection p = new MapProjection();
        p.setViewport(0, 0, 200, 100);
        p.setCenter(10, -20);
        p.setZoom(2);
        assertEquals(100, p.toScreenX(10), 1e-9);
        assertEquals(50, p.toScreenY(-20), 1e-9);
        assertTrue(p.toScreenY(-30) < p.toScreenY(-20)); // north (-Z) is up
        assertEquals(37.5, p.toWorldX(p.toScreenX(37.5)), 1e-9);
        assertEquals(-4, p.toWorldZ(p.toScreenY(-4)), 1e-9);
    }

    @Test
    void mapZoomKeepsCursorPointAndDragPans() {
        MapProjection p = new MapProjection();
        p.setViewport(10, 20, 300, 200);
        p.setCenter(0, 0);
        p.setZoom(1);
        double wx = p.toWorldX(50), wz = p.toWorldZ(60);
        p.zoomAt(50, 60, 2);
        assertEquals(2, p.zoom(), 1e-9);
        assertEquals(wx, p.toWorldX(50), 1e-9);
        assertEquals(wz, p.toWorldZ(60), 1e-9);
        double before = p.toWorldX(100);
        p.dragBy(20, 0); // content follows the mouse to the right
        assertEquals(before - 10, p.toWorldX(100), 1e-9);
        p.setZoom(1000);
        assertEquals(MapProjection.MAX_ZOOM, p.zoom(), 1e-9);
        p.setZoom(0.5);
        assertTrue(p.gridStep(18) * p.zoom() >= 18);
    }

    // ------------------------------------------------------------ config

    @Test
    void uiConfigRoundTripsAndSanitizes() {
        UiConfig c = new UiConfig();
        c.compact = true;
        c.hudScale = 1.25f;
        c.setPlacement(UiConfig.TICKER, new Placement(Anchor.MID_RIGHT, -3, 7));
        JsonObject o = c.toJson();
        UiConfig back = UiConfig.fromJson(o);
        assertTrue(back.compact);
        assertEquals(1.25f, back.hudScale);
        assertEquals(new Placement(Anchor.MID_RIGHT, -3, 7), back.placement(UiConfig.TICKER));
        // garbage / out of range values are fixed, missing panels get defaults
        JsonObject bad = new JsonObject();
        bad.addProperty("hudScale", 99);
        bad.addProperty("tickerSeconds", -4);
        bad.add("pos", new JsonObject());
        UiConfig s = UiConfig.fromJson(bad);
        assertEquals(2f, s.hudScale);
        assertEquals(3, s.tickerSeconds);
        assertEquals(Anchor.TOP_LEFT, s.placement(UiConfig.TEAM).anchor());
        assertEquals(Anchor.BOTTOM_RIGHT, UiConfig.fromJson(null).placement(UiConfig.TICKER).anchor());
    }
}
