package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.Econ;
import com.hivecraft.overlay.core.EconState;
import com.hivecraft.overlay.core.EconText;
import com.hivecraft.overlay.core.J;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.screen.tabs.Tab;
import com.hivecraft.overlay.ui.draw.Gfx;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.widget.TextFieldWidget;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Server shop: searchable catalog grid with real item icons; detail panel with quantity, Buy and Sell. */
public final class ShopView implements EconView {
    private TextFieldWidget search;
    private String searchText = "";
    private String cat = null;
    private String selected;
    private final NumField qty = new NumField("qty", 1, 640);
    private final Act act = new Act();
    private int scroll, contentH, viewH;
    private int gx, gy, gw, gh;

    @Override public String title() { return "Shop"; }
    @Override public String icon() { return "⛁"; }

    @Override
    public void open(EconHost h) {
        search = h.textField(-500, -500, 100, "search items…");
        search.setMaxLength(40);
        search.setText(searchText);
        search.setChangedListener(s -> scroll = 0);
        qty.open(h);
        if (qty.value() == null) qty.set(1);
    }

    @Override
    public void close(EconHost h) {
        if (search != null) { searchText = search.getText(); h.removeWidget(search); }
        search = null;
        qty.close(h);
    }

    @Override
    public void hideFields() {
        qty.hide();
        if (search != null) { search.setX(-500); search.setY(-500); }
    }

    @Override
    public boolean typing() { return qty.focused() || (search != null && search.isFocused()); }

    private List<EconState.ShopItem> filtered(EconState es) {
        String q = search == null ? searchText : search.getText();
        q = q == null ? "" : q.strip().toLowerCase(Locale.ROOT);
        List<EconState.ShopItem> out = new ArrayList<>();
        for (EconState.ShopItem s : es.shop()) {
            if (cat != null && !cat.equals(s.cat())) continue;
            if (!q.isEmpty() && !s.item().contains(q.replace(' ', '_')) && !EconGfx.name(s.item()).toLowerCase(Locale.ROOT).contains(q)) continue;
            out.add(s);
        }
        return out;
    }

    private void buy(EconHost h, EconState.ShopItem it, int n) {
        EconState es = EconPanel.es();
        if (it.buy() == null) { act.error(h, "the shop doesn't sell " + EconGfx.name(it.item())); return; }
        long cost = (long) it.buy() * n;
        if (cost > es.balance()) { act.error(h, "not enough coins: have " + EconText.coins(es.balance()) + ", need " + EconText.coins(cost)); return; }
        act.run(h, "buying " + n + " " + EconGfx.name(it.item()) + "…", Econ.get().buy(it.item(), n),
                r -> "bought " + J.integer(r.body(), "count", n) + " " + EconGfx.name(it.item()) + " for " + EconText.coins(J.lng(r.body(), "cost", cost)), null);
    }

    private void sell(EconHost h, EconState.ShopItem it, int n) {
        if (it.sell() == null) { act.error(h, "the shop doesn't buy " + EconGfx.name(it.item())); return; }
        int have = Inv.count(it.item());
        if (have <= 0) { act.error(h, "you have no " + EconGfx.name(it.item()) + " in your inventory"); return; }
        int c = Math.min(n, have);
        act.run(h, "selling " + c + " " + EconGfx.name(it.item()) + "…", Econ.get().sell(it.item(), c),
                r -> "sold " + J.integer(r.body(), "count", c) + " " + EconGfx.name(it.item()) + " for " + EconText.coins(J.lng(r.body(), "earned", (long) c * it.sell())), null);
    }

    @Override
    public void render(EconHost h, Ui ui, ControlScreen.Area a, long now) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        EconState es = EconPanel.es();
        int dw = Math.max(150, Math.min(196, (int) (a.w() * 0.36)));
        int lw = a.w() - dw - 6;

        // ---- search + categories
        int sw = Math.min(130, lw / 2);
        if (search != null) { search.setX(a.x()); search.setY(a.y()); search.setWidth(sw); }
        Set<String> cats = new LinkedHashSet<>();
        for (EconState.ShopItem s : es.shop()) if (s.cat() != null) cats.add(s.cat());
        int cx = a.x() + sw + 6;
        cx += ui.chip(cx, a.y() + 1, "All", Gfx.GOLD, cat == null, () -> { cat = null; scroll = 0; }) + 2;
        for (String c : cats) {
            String label = c;
            int w = tr.getWidth(label) + 8;
            if (cx + w > a.x() + lw) break;
            cx += ui.chip(cx, a.y() + 1, label, Gfx.GOLD, c.equals(cat), () -> { cat = c.equals(cat) ? null : c; scroll = 0; }) + 2;
        }

        // ---- grid
        List<EconState.ShopItem> items = filtered(es);
        gx = a.x(); gy = a.y() + 18; gw = lw; gh = a.h() - 18;
        g.fill(gx, gy, gx + gw, gy + gh, 0x50080B10);
        int cellW = 96, cellH = 30, gap = 3;
        int cols = Math.max(1, (gw - 6 + gap) / (cellW + gap));
        cellW = (gw - 6 - (cols - 1) * gap) / cols;
        int rows = (items.size() + cols - 1) / cols;
        contentH = rows * (cellH + gap);
        viewH = gh - 6;
        scroll = Tab.clampScroll(scroll, contentH, viewH);
        g.enableScissor(gx, gy + 1, gx + gw, gy + gh - 1);
        for (int i = 0; i < items.size(); i++) {
            EconState.ShopItem it = items.get(i);
            int x = gx + 3 + (i % cols) * (cellW + gap), y = gy + 3 + (i / cols) * (cellH + gap) - scroll;
            if (y + cellH < gy || y > gy + gh) continue;
            boolean sel = it.item().equals(selected);
            boolean hv = ui.hover(x, y, cellW, cellH) && ui.hover(gx, gy, gw, gh);
            g.fill(x, y, x + cellW, y + cellH, sel ? EconGfx.ROW_SEL : hv ? EconGfx.ROW_HOVER : EconGfx.ROW);
            if (sel) g.drawBorder(x, y, cellW, cellH, Gfx.GOLD);
            EconGfx.slot(g, x + 3, y + 6, 18, false, false);
            int have = Inv.count(it.item());
            EconGfx.item(g, tr, it.item(), x + 4, y + 7, 1);
            if (have > 0) {
                String hs = have > 999 ? "999+" : String.valueOf(have);
                var m = g.getMatrices();
                m.push();
                m.translate(0, 0, 200);
                g.drawText(tr, hs, x + 22 - tr.getWidth(hs), y + 2, 0xFF7FE08F, true);
                m.pop();
            }
            g.drawText(tr, Gfx.fit(tr, EconGfx.name(it.item()), cellW - 28), x + 25, y + 5, Gfx.TEXT, false);
            int px = x + 25;
            if (it.buy() != null) {
                EconGfx.coin(g, px, y + 17, 1);
                g.drawText(tr, EconText.coinsShort(it.buy()), px + 10, y + 17, 0xFFFFE9A8, false);
                px += 14 + tr.getWidth(EconText.coinsShort(it.buy()));
            }
            if (it.sell() != null) {
                String s = "▸" + EconText.coinsShort(it.sell());
                if (px + tr.getWidth(s) < x + cellW - 2) g.drawText(tr, s, px, y + 17, 0xFF7FE08F, false);
            }
            if (y >= gy && y + cellH <= gy + gh) {
                String tip = (it.buy() != null ? "buy " + it.buy() : "not sold") + " · " + (it.sell() != null ? "sell " + it.sell() : "not bought") + (have > 0 ? " · you have " + have : "");
                ui.region(x, y, cellW, cellH, () -> { selected = it.item(); EconGfx.soundClick(); }, tip);
            }
        }
        g.disableScissor();
        if (items.isEmpty()) g.drawCenteredTextWithShadow(tr, es.shop().isEmpty() ? "the server shop is empty" : "nothing matches", gx + gw / 2, gy + 30, Gfx.FAINT);
        if (contentH > viewH) {
            int bh = Math.max(10, viewH * viewH / contentH);
            int by = gy + 3 + (viewH - bh) * scroll / Math.max(1, contentH - viewH);
            g.fill(gx + gw - 3, by, gx + gw - 1, by + bh, 0x80FFFFFF);
        }

        // ---- detail panel
        int dx = a.right() - dw, dy = a.y();
        EconGfx.card(g, dx, dy, dw, a.h());
        EconState.ShopItem it = selected == null ? null : es.shopItem(selected);
        if (it == null) {
            qty.hide();
            EconGfx.coin(g, dx + dw / 2 - 12, dy + a.h() / 2 - 34, 3);
            g.drawCenteredTextWithShadow(tr, "Pick an item", dx + dw / 2, dy + a.h() / 2 - 4, Gfx.TEXT);
            g.drawCenteredTextWithShadow(tr, "to buy or sell it", dx + dw / 2, dy + a.h() / 2 + 8, Gfx.MUTED);
            act.render(ui, dx + 6, a.bottom() - 12, dw - 12, now);
            return;
        }
        int y = dy + 6;
        g.fill(dx + 6, y, dx + 40, y + 34, 0xFF141922);
        g.drawBorder(dx + 6, y, 34, 34, 0xFF363E4E);
        Gfx.item(g, it.item(), dx + 7, y + 1, 32);
        g.drawText(tr, Gfx.fit(tr, EconGfx.name(it.item()), dw - 52), dx + 46, y + 3, 0xFFFFFFFF, true);
        g.drawText(tr, Gfx.fit(tr, it.cat() == null ? "" : it.cat(), dw - 52), dx + 46, y + 14, Gfx.FAINT, false);
        int have = Inv.count(it.item());
        g.drawText(tr, "you have " + have, dx + 46, y + 24, have > 0 ? 0xFF7FE08F : Gfx.MUTED, false);
        y += 42;
        y = priceRow(g, tr, dx + 6, y, dw - 12, "Buy price", it.buy(), 0xFFFFE9A8);
        y = priceRow(g, tr, dx + 6, y, dw - 12, "Sell price", it.sell(), 0xFF7FE08F);
        y += 4;
        // quantity
        g.drawText(tr, "Quantity", dx + 6, y + 3, Gfx.MUTED, false);
        qty.setMax(640);
        qty.render(ui, dx + dw - 6 - 76, y, 76, true, 1);
        y += 17;
        int qx = dx + 6;
        for (int q : new int[]{1, 8, 16, 32, 64}) {
            String l = String.valueOf(q);
            int qw = tr.getWidth(l) + 6;
            ui.button(qx, y, qw, 12, l, Gfx.INFO, true, () -> qty.set(q), null);
            qx += qw + 2;
        }
        if (have > 0 && it.sell() != null) ui.button(qx, y, tr.getWidth("All") + 6, 12, "All", Gfx.GOOD, true, () -> qty.set(have), "everything you carry (" + have + ")");
        y += 16;
        int n = (int) qty.valueOr(1);
        // buy / sell buttons with totals
        int bw = (dw - 16) / 2;
        boolean canBuy = it.buy() != null && qty.valid() && (long) it.buy() * n <= es.balance() && !act.busy();
        boolean canSell = it.sell() != null && qty.valid() && have > 0 && !act.busy();
        String bl = it.buy() == null ? "Not sold" : "Buy " + EconText.coinsShort((long) it.buy() * n);
        String sl = it.sell() == null ? "Not bought" : "Sell " + EconText.coinsShort((long) it.sell() * Math.min(n, Math.max(have, 0)));
        ui.button(dx + 6, y, bw, 16, bl, EconGfx.COIN, canBuy, () -> buy(h, it, n), "buy " + n + " for " + (it.buy() == null ? "?" : EconText.coins((long) it.buy() * n)) + " coins");
        if (!canBuy && it.buy() != null && !act.busy())
            ui.region(dx + 6, y, bw, 16, null, (long) it.buy() * n > es.balance() ? "not enough coins (need " + EconText.coins((long) it.buy() * n) + ")" : "type a quantity");
        ui.button(dx + 10 + bw, y, bw, 16, sl, Gfx.GOOD, canSell, () -> sell(h, it, n), "sell " + Math.min(n, have) + " from your inventory");
        if (!canSell && it.sell() != null && !act.busy()) ui.region(dx + 10 + bw, y, bw, 16, null, have <= 0 ? "you have none to sell" : "type a quantity");
        y += 20;
        if (have > 0 && Inv.risky(it.item())) {
            g.drawText(tr, Gfx.fit(tr, "⚠ enchants/damage/names are lost", dw - 12), dx + 6, y, Gfx.WARN, false);
            y += 11;
        }
        act.render(ui, dx + 6, Math.max(y, a.bottom() - 12), dw - 12, now);
    }

    private static int priceRow(DrawContext g, net.minecraft.client.font.TextRenderer tr, int x, int y, int w, String label, Integer price, int color) {
        g.fill(x, y, x + w, y + 13, 0x40000000);
        g.drawText(tr, label, x + 4, y + 3, Gfx.MUTED, false);
        if (price == null) {
            String s = "—";
            g.drawText(tr, s, x + w - 4 - tr.getWidth(s), y + 3, Gfx.FAINT, false);
        } else {
            String s = EconText.coins(price) + " each";
            int sw = tr.getWidth(s);
            g.drawText(tr, s, x + w - 4 - sw, y + 3, color, false);
            EconGfx.coin(g, x + w - 14 - sw, y + 3, 1);
        }
        return y + 15;
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        if (mx >= gx && mx < gx + gw && my >= gy && my < gy + gh) {
            scroll = Tab.clampScroll(scroll - (int) (v * 33), contentH, viewH);
            return true;
        }
        return false;
    }

    @Override
    public boolean key(EconHost h, int key, int scan, int mods) {
        if ((key == GLFW.GLFW_KEY_ENTER || key == GLFW.GLFW_KEY_KP_ENTER) && search != null && search.isFocused()) {
            List<EconState.ShopItem> f = filtered(EconPanel.es());
            if (!f.isEmpty()) selected = f.get(0).item();
            return true;
        }
        if ((key == GLFW.GLFW_KEY_ENTER || key == GLFW.GLFW_KEY_KP_ENTER) && qty.focused() && selected != null) {
            EconState.ShopItem it = EconPanel.es().shopItem(selected);
            if (it != null && it.buy() != null) buy(h, it, (int) qty.valueOr(1));
            return true;
        }
        return false;
    }
}
