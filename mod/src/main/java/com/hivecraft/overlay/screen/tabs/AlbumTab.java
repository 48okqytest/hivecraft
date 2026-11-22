package com.hivecraft.overlay.screen.tabs;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.Photo;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.PhotoTextures;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.gui.DrawContext;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayList;
import java.util.List;

/** Photo album: thumbnails of the bots' photos (loaded as textures), click to enlarge, ←/→ to browse. */
public final class AlbumTab implements Tab {
    /** Set by the terminal (click on "photo <id>") to open a photo directly. */
    public static volatile String openRequest;

    private int scroll = 0, contentH = 0, viewH = 0;
    private String enlarged;      // photo id
    private long enlargedAt;
    private String botFilter;     // null = all
    private boolean requested = false;

    @Override public String title() { return "Album"; }
    @Override public String icon() { return "◉"; }

    @Override
    public void open(ControlScreen s, ControlScreen.Area a) {
        if (!requested && Hive.client() != null) {
            requested = true;
            Hive.client().loadPhotos(null, 60);
        }
        String req = openRequest;
        if (req != null) {
            openRequest = null;
            enlarged = req;
            enlargedAt = System.currentTimeMillis();
        }
    }

    private List<Photo> photos() {
        List<Photo> out = new ArrayList<>();
        for (Photo p : Hive.state().photos()) if (botFilter == null || botFilter.equalsIgnoreCase(p.agent())) out.add(p);
        return out;
    }

    @Override
    public void render(ControlScreen s, Ui ui, ControlScreen.Area a, long now, float delta) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        List<Photo> list = photos();

        // filter chips
        int x = a.x();
        x += ui.chip(x, a.y(), "All", Gfx.GOLD, botFilter == null, () -> { botFilter = null; scroll = 0; }) + 3;
        for (BotState b : Hive.state().bots()) {
            String n = b.name();
            x += ui.chip(x, a.y(), n, 0xFF000000 | b.color(), n.equalsIgnoreCase(botFilter == null ? "" : botFilter), () -> { botFilter = n; scroll = 0; }) + 3;
        }
        String count = list.size() + " photos";
        Gfx.text(g, tr, count, a.right() - tr.getWidth(count), a.y() + 2, Gfx.FAINT);

        int top = a.y() + 18;
        viewH = a.h() - 18;
        if (list.isEmpty()) {
            Gfx.text(g, tr, "No photos yet. Bots take them with photo_* tools (try asking one to photograph the base).", a.x(), top + 6, Gfx.MUTED);
            return;
        }
        int gap = 6;
        int tw = 120, th = 68;
        int cols = Math.max(1, (a.w() + gap) / (tw + gap));
        tw = (a.w() - gap * (cols - 1)) / cols;
        th = tw * 9 / 16;
        int rowH = th + 22;
        contentH = ((list.size() + cols - 1) / cols) * rowH;
        scroll = Tab.clampScroll(scroll, contentH, viewH);
        g.enableScissor(a.x() - 1, top, a.right() + 1, a.bottom());
        for (int i = 0; i < list.size(); i++) {
            Photo p = list.get(i);
            int px = a.x() + (i % cols) * (tw + gap);
            int py = top + (i / cols) * rowH - scroll;
            if (py > a.bottom() || py + rowH < top) continue;
            boolean hv = ui.hover(px, py, tw, th) && ui.my >= top && enlarged == null;
            g.fill(px - 1, py - 1, px + tw + 1, py + th + 1, hv ? 0xFFFFC24A : 0xFF2A3242);
            drawPhoto(g, tr, p, px, py, tw, th, now);
            int accent = botColor(p.agent());
            g.fill(px, py + th + 2, px + 2, py + th + 20, accent);
            Gfx.text(g, tr, Gfx.fit(tr, p.caption() == null || p.caption().isBlank() ? "(no caption)" : p.caption(), tw - 6), px + 5, py + th + 3, Gfx.TEXT);
            Gfx.text(g, tr, Gfx.fit(tr, p.agent() + " · " + UiMath.formatAge(now - p.ts()) + " ago", tw - 6), px + 5, py + th + 12, Gfx.FAINT);
            if (enlarged == null) ui.region(px, Math.max(py, top), tw, th, () -> { enlarged = p.id(); enlargedAt = System.currentTimeMillis(); }, null);
        }
        g.disableScissor();

        if (enlarged != null) drawEnlarged(s, ui, a, list, now);
    }

    private void drawEnlarged(ControlScreen s, Ui ui, ControlScreen.Area a, List<Photo> list, long now) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        Photo p = null;
        int idx = -1;
        for (int i = 0; i < list.size(); i++) if (list.get(i).id().equals(enlarged)) { p = list.get(i); idx = i; }
        if (p == null) for (Photo q : Hive.state().photos()) if (q.id().equals(enlarged)) p = q;
        if (p == null) { enlarged = null; return; }
        double in = UiMath.easeOutCubic((now - enlargedAt) / 180.0);
        var m = g.getMatrices();
        m.push();
        m.translate(0, 0, 300);
        g.fill(a.x() - 4, a.y() - 4, a.right() + 4, a.bottom() + 4, UiMath.rgbA(0x05070A, (int) (235 * in)));
        int maxW = a.w() - 20, maxH = a.h() - 34;
        double ar = p.width() > 0 && p.height() > 0 ? p.width() / (double) p.height() : 16 / 9.0;
        PhotoTextures.Tex t = PhotoTextures.get(p);
        if (t != null) ar = t.width() / (double) t.height();
        int w = maxW, h = (int) (w / ar);
        if (h > maxH) { h = maxH; w = (int) (h * ar); }
        w = (int) (w * (0.92 + 0.08 * in));
        h = (int) (h * (0.92 + 0.08 * in));
        int x = a.x() + (a.w() - w) / 2, y = a.y() + 4 + (maxH - h) / 2;
        g.fill(x - 2, y - 2, x + w + 2, y + h + 2, 0xFFFFC24A);
        drawPhoto(g, tr, p, x, y, w, h, now);
        String cap = (p.caption() == null || p.caption().isBlank() ? "(no caption)" : p.caption());
        Gfx.text(g, tr, Gfx.fit(tr, cap, a.w() - 20), a.x() + 10, a.bottom() - 24, Gfx.TEXT);
        String meta = p.agent() + " · " + UiMath.formatAge(now - p.ts()) + " ago" + (p.mode() == null || p.mode().isBlank() ? "" : " · " + p.mode())
                + (idx >= 0 ? "   " + (idx + 1) + "/" + list.size() + "  ← →" : "") + "   click / Esc to close";
        Gfx.text(g, tr, Gfx.fit(tr, meta, a.w() - 20), a.x() + 10, a.bottom() - 13, botColor(p.agent()));
        m.pop();
        ui.region(a.x() - 4, a.y() - 4, a.w() + 8, a.h() + 8, () -> enlarged = null, null);
    }

    private static void drawPhoto(DrawContext g, net.minecraft.client.font.TextRenderer tr, Photo p, int x, int y, int w, int h, long now) {
        PhotoTextures.Tex t = PhotoTextures.get(p);
        if (t == null) {
            g.fill(x, y, x + w, y + h, 0xFF10141C);
            String msg = PhotoTextures.hasFailed(p) ? "unavailable" : "loading" + ".".repeat((int) (now / 300 % 4));
            Gfx.text(g, tr, msg, x + (w - tr.getWidth("loading...")) / 2, y + h / 2 - 4, Gfx.FAINT);
            return;
        }
        // cover-fit: crop the texture to the box aspect
        double boxAr = w / (double) h, texAr = t.width() / (double) t.height();
        int u = 0, v = 0, rw = t.width(), rh = t.height();
        if (texAr > boxAr) { rw = (int) (t.height() * boxAr); u = (t.width() - rw) / 2; }
        else if (texAr < boxAr) { rh = (int) (t.width() / boxAr); v = (t.height() - rh) / 2; }
        g.drawTexture(t.id(), x, y, w, h, u, v, rw, rh, t.width(), t.height());
    }

    private static int botColor(String name) {
        BotState b = name == null ? null : Hive.state().bot(name);
        return b != null ? 0xFF000000 | b.color() : Gfx.GOLD;
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        if (enlarged != null) return true;
        scroll = Tab.clampScroll(scroll - (int) (v * 30), contentH, viewH);
        return true;
    }

    @Override
    public boolean key(ControlScreen s, int key, int scan, int mods) {
        if (enlarged == null) return false;
        if (key == GLFW.GLFW_KEY_ESCAPE) { enlarged = null; return true; }
        if (key == GLFW.GLFW_KEY_LEFT || key == GLFW.GLFW_KEY_RIGHT) {
            List<Photo> list = photos();
            for (int i = 0; i < list.size(); i++) {
                if (list.get(i).id().equals(enlarged)) {
                    int j = Math.floorMod(i + (key == GLFW.GLFW_KEY_RIGHT ? 1 : -1), list.size());
                    enlarged = list.get(j).id();
                    enlargedAt = System.currentTimeMillis() - 120;
                    break;
                }
            }
            return true;
        }
        return false;
    }
}
