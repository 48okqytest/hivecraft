package com.hivecraft.overlay.screen.tabs;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveClient;
import com.hivecraft.overlay.core.LedgerEvent;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Block ledger browser: filter by bot / time / op, newest first. Click a row to highlight that
 * block in the world (pulsing outline + beam via ModWorld's highlights); "Highlight all" marks
 * the shown rows; "Load more" pulls a deeper history from GET /mod/ledger.
 */
public final class LedgerTab implements Tab {
    private static final long[] WINDOWS = {5 * 60_000L, 30 * 60_000L, 2 * 3600_000L, 0};
    private static final String[] WINDOW_LABELS = {"5m", "30m", "2h", "all"};

    private String bot;          // null = all
    private int window = 1;
    private String op;           // null | place | break
    private int scroll = 0, contentH = 0, viewH = 0;
    private final Map<Long, LedgerEvent> fetched = new LinkedHashMap<>();
    private volatile boolean loading = false;
    private String selectedKey;

    @Override public String title() { return "Ledger"; }
    @Override public String icon() { return "▤"; }

    private List<LedgerEvent> rows(long now) {
        long since = WINDOWS[window] == 0 ? 0 : now + Hive.state().serverTimeOffset() - WINDOWS[window];
        Map<Long, LedgerEvent> byId = new LinkedHashMap<>();
        for (LedgerEvent e : Hive.state().ledger().recent(2000, bot)) byId.put(e.id(), e);
        synchronized (fetched) {
            for (LedgerEvent e : fetched.values()) if (bot == null || bot.equalsIgnoreCase(e.bot())) byId.putIfAbsent(e.id(), e);
        }
        List<LedgerEvent> out = new ArrayList<>();
        for (LedgerEvent e : byId.values()) {
            if (e.ts() < since) continue;
            if (op != null && !op.equals(e.op())) continue;
            out.add(e);
        }
        out.sort((a, b) -> Long.compare(b.ts(), a.ts()));
        return out;
    }

    @Override
    public void render(ControlScreen s, Ui ui, ControlScreen.Area a, long now, float delta) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        // filters row 1: bots
        int x = a.x();
        x += ui.chip(x, a.y(), "All bots", Gfx.GOLD, bot == null, () -> { bot = null; scroll = 0; }) + 3;
        for (BotState b : Hive.state().bots()) {
            String n = b.name();
            x += ui.chip(x, a.y(), n, 0xFF000000 | b.color(), n.equalsIgnoreCase(bot == null ? "" : bot), () -> { bot = n; scroll = 0; }) + 3;
        }
        // row 2: time + op + actions
        int y2 = a.y() + 15;
        x = a.x();
        for (int i = 0; i < WINDOWS.length; i++) {
            final int w = i;
            x += ui.chip(x, y2, WINDOW_LABELS[i], Gfx.INFO, window == i, () -> { window = w; scroll = 0; }) + 3;
        }
        x += 8;
        x += ui.chip(x, y2, "both", Gfx.INFO, op == null, () -> op = null) + 3;
        x += ui.chip(x, y2, "+ placed", Gfx.GOOD, "place".equals(op), () -> op = "place") + 3;
        x += ui.chip(x, y2, "− broken", Gfx.BAD, "break".equals(op), () -> op = "break") + 3;

        List<LedgerEvent> list = rows(now);
        int bx = a.right();
        bx -= ui.button(a.right() - 70, y2 - 1, 70, 13, loading ? "loading…" : "Load more", Gfx.INFO, !loading, this::loadMore,
                "fetch older history from the bridge") + 3;
        final List<LedgerEvent> shown = list;
        ui.button(bx - 78, y2 - 1, 78, 13, "Highlight all", Gfx.GOLD, !list.isEmpty(), () -> highlightAll(s, shown),
                "outline up to 24 of the listed blocks in the world");

        // header
        int top = y2 + 16;
        int[] cols = {a.x() + 2, a.x() + 34, a.x() + 82, a.x() + 96, a.x() + 220, a.x() + 312};
        Gfx.text(g, tr, "age", cols[0], top, Gfx.FAINT);
        Gfx.text(g, tr, "bot", cols[1], top, Gfx.FAINT);
        Gfx.text(g, tr, "block", cols[3], top, Gfx.FAINT);
        Gfx.text(g, tr, "where", cols[4], top, Gfx.FAINT);
        Gfx.text(g, tr, "why", cols[5], top, Gfx.FAINT);
        String cnt = list.size() + " changes";
        Gfx.text(g, tr, cnt, a.right() - tr.getWidth(cnt), top, Gfx.FAINT);
        g.fill(a.x(), top + 10, a.right(), top + 11, 0xFF2A3242);

        int rowH = 12;
        int y0 = top + 13;
        viewH = a.bottom() - y0;
        contentH = list.size() * rowH;
        scroll = Tab.clampScroll(scroll, contentH, viewH);
        int first = scroll / rowH;
        long serverNow = now + Hive.state().serverTimeOffset();
        g.enableScissor(a.x(), y0, a.right(), a.bottom());
        for (int i = first; i < list.size(); i++) {
            int y = y0 + i * rowH - scroll;
            if (y > a.bottom()) break;
            LedgerEvent e = list.get(i);
            String key = e.x() + "," + e.y() + "," + e.z() + "," + e.dim();
            boolean hv = ui.hover(a.x(), y, a.w(), rowH) && ui.my >= y0;
            boolean sel = key.equals(selectedKey);
            if (sel) g.fill(a.x(), y, a.right(), y + rowH, 0x40FFC24A);
            else if (hv) g.fill(a.x(), y, a.right(), y + rowH, 0x30FFFFFF);
            else if (i % 2 == 1) g.fill(a.x(), y, a.right(), y + rowH, 0x10FFFFFF);
            BotState b = Hive.state().bot(e.bot());
            int bc = b != null ? 0xFF000000 | b.color() : Gfx.MUTED;
            Gfx.text(g, tr, UiMath.formatAge(serverNow - e.ts()), cols[0], y + 2, Gfx.MUTED);
            Gfx.text(g, tr, Gfx.fit(tr, e.bot(), 46), cols[1], y + 2, bc);
            Gfx.text(g, tr, e.isPlace() ? "+" : "−", cols[2], y + 2, e.isPlace() ? Gfx.GOOD : Gfx.BAD);
            Gfx.item(g, e.block(), cols[3], y + 1, 10);
            Gfx.text(g, tr, Gfx.fit(tr, UiMath.prettyId(e.block()), cols[4] - cols[3] - 16), cols[3] + 12, y + 2, Gfx.TEXT);
            Gfx.text(g, tr, e.x() + " " + e.y() + " " + e.z(), cols[4], y + 2, Gfx.MUTED);
            String why = e.cause() == null ? "" : e.cause();
            if (e.build() != null) why += " · " + e.build();
            Gfx.text(g, tr, Gfx.fit(tr, why, a.right() - cols[5] - 4), cols[5], y + 2, Gfx.FAINT);
            if (hv) {
                String tip = (e.isPlace() ? "placed" : "broke") + " " + e.block()
                        + (e.prev() != null && e.isPlace() && !"air".equals(e.prev()) ? " (was " + e.prev() + ")" : "")
                        + (e.action() != null ? " · during " + e.action() : "") + " · click to highlight";
                ui.tooltip(tip);
            }
            ui.region(a.x(), Math.max(y, y0), a.w(), rowH, () -> {
                selectedKey = key;
                Hive.highlights().highlight(e.x(), e.y(), e.z(), e.dim(), 20_000);
                s.toast("◎ highlighted " + e.block() + " at " + e.x() + " " + e.y() + " " + e.z() + " for 20s", Gfx.GOLD);
            }, null);
        }
        g.disableScissor();
        if (list.isEmpty()) Gfx.text(g, tr, "No block changes in this window.", a.x() + 2, y0 + 4, Gfx.FAINT);
        if (contentH > viewH) {
            int th = Math.max(10, viewH * viewH / contentH);
            int ty = y0 + (viewH - th) * scroll / Math.max(1, contentH - viewH);
            g.fill(a.right() - 2, ty, a.right(), ty + th, 0x80FFFFFF);
        }
    }

    private void highlightAll(ControlScreen s, List<LedgerEvent> list) {
        int n = 0;
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (LedgerEvent e : list) {
            if (!seen.add(e.x() + "," + e.y() + "," + e.z())) continue;
            Hive.highlights().highlight(e.x(), e.y(), e.z(), e.dim(), 20_000);
            if (++n >= 24) break;
        }
        s.toast("◎ highlighted " + n + " blocks for 20s", Gfx.GOLD);
    }

    private void loadMore() {
        HiveClient c = Hive.client();
        if (c == null || loading) return;
        loading = true;
        long now = System.currentTimeMillis() + Hive.state().serverTimeOffset();
        StringBuilder q = new StringBuilder("/mod/ledger?limit=3000");
        if (bot != null) q.append("&bot=").append(java.net.URLEncoder.encode(bot, java.nio.charset.StandardCharsets.UTF_8));
        if (WINDOWS[window] > 0) q.append("&since=").append(now - WINDOWS[window]);
        if (op != null) q.append("&op=").append(op);
        c.httpGet(q.toString()).whenComplete((o, err) -> MinecraftClient.getInstance().execute(() -> {
            loading = false;
            if (err != null || o == null) return;
            JsonArray arr = o.has("events") && o.get("events").isJsonArray() ? o.getAsJsonArray("events") : new JsonArray();
            synchronized (fetched) {
                for (var el : arr) {
                    if (!el.isJsonObject()) continue;
                    LedgerEvent e = LedgerEvent.parse((JsonObject) el);
                    fetched.put(e.id(), e);
                }
                // keep memory bounded
                while (fetched.size() > 20_000) fetched.remove(fetched.keySet().iterator().next());
            }
        }));
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        scroll = Tab.clampScroll(scroll - (int) (v * 24), contentH, viewH);
        return true;
    }
}
