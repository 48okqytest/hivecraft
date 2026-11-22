package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.Econ;
import com.hivecraft.overlay.core.EconState;
import com.hivecraft.overlay.core.EconText;
import com.hivecraft.overlay.core.J;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.screen.tabs.Tab;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.widget.TextFieldWidget;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Market: every bot/player listing (search, buy with quantity) on the left; "My shop" on the right: pick an item
 * from the inventory, count + price each → List; your open listings with Cancel.
 */
public final class MarketView implements EconView {
    private TextFieldWidget search;
    private String searchText = "";
    private boolean hideMine = false;
    private int selectedId = -1;
    private final NumField buyQty = new NumField("qty", 1, 640);
    private final NumField listCount = new NumField("count", 1, 640);
    private final NumField listPrice = new NumField("price each", 1, 1_000_000);
    private final InvPicker picker = new InvPicker();
    private final Act buyAct = new Act();
    private final Act listAct = new Act();
    private int scroll, contentH, viewH, lx, ly, lw, lh;
    private int myScroll, myContentH, myViewH, mx0, my0, mw, mh;
    private String lastPicked;

    @Override public String title() { return "Market"; }
    @Override public String icon() { return "⇄"; }

    @Override
    public void open(EconHost h) {
        search = h.textField(-500, -500, 100, "search listings…");
        search.setMaxLength(40);
        search.setText(searchText);
        search.setChangedListener(s -> scroll = 0);
        buyQty.open(h);
        listCount.open(h);
        listPrice.open(h);
    }

    @Override
    public void close(EconHost h) {
        if (search != null) { searchText = search.getText(); h.removeWidget(search); }
        search = null;
        buyQty.close(h);
        listCount.close(h);
        listPrice.close(h);
    }

    @Override
    public void hideFields() {
        buyQty.hide();
        listCount.hide();
        listPrice.hide();
        if (search != null) { search.setX(-500); search.setY(-500); }
    }

    @Override
    public boolean typing() {
        return buyQty.focused() || listCount.focused() || listPrice.focused() || (search != null && search.isFocused());
    }

    private List<EconState.Listing> filtered(EconState es) {
        String q = search == null ? searchText : search.getText();
        q = q == null ? "" : q.strip().toLowerCase(Locale.ROOT);
        List<EconState.Listing> out = new ArrayList<>();
        for (EconState.Listing l : es.listings()) {
            if (hideMine && es.isMe(l.seller())) continue;
            if (!q.isEmpty() && !l.item().contains(q.replace(' ', '_')) && !EconGfx.name(l.item()).toLowerCase(Locale.ROOT).contains(q)
                    && !l.seller().toLowerCase(Locale.ROOT).contains(q) && !(l.shop() != null && l.shop().toLowerCase(Locale.ROOT).contains(q))) continue;
            out.add(l);
        }
        return out;
    }

    private void buy(EconHost h, EconState.Listing l, int n) {
        EconState es = EconPanel.es();
        int c = Math.min(n, l.count());
        long cost = (long) c * l.price();
        if (cost > es.balance()) { buyAct.error(h, "not enough coins: have " + EconText.coins(es.balance()) + ", need " + EconText.coins(cost)); return; }
        buyAct.run(h, "buying " + c + " " + EconGfx.name(l.item()) + " from " + l.seller() + "…", Econ.get().marketBuy(l.id(), c),
                r -> "bought " + J.integer(r.body(), "count", c) + " " + EconGfx.name(l.item()) + " for " + EconText.coins(J.lng(r.body(), "cost", cost))
                        + (r.body() != null && !J.bool(r.body(), "delivered", true) ? " (queued: you're offline)" : ""), null);
    }

    private void unlist(EconHost h, EconState.Listing l) {
        listAct.run(h, "cancelling listing #" + l.id() + "…", Econ.get().unlist(l.id()),
                r -> "listing #" + l.id() + " cancelled: " + J.integer(r.body(), "returned", l.count()) + " " + EconGfx.name(l.item()) + " back", null);
    }

    private void list(EconHost h) {
        String item = picker.selected();
        if (item == null) { listAct.error(h, "pick an item from your inventory"); return; }
        int have = Inv.count(item);
        if (have <= 0) { listAct.error(h, "you have no " + EconGfx.name(item) + " in your inventory"); return; }
        Long c = listCount.value(), p = listPrice.value();
        if (c == null || c <= 0) { listAct.error(h, "type how many to list"); return; }
        if (p == null || p <= 0) { listAct.error(h, "type a price for each item"); return; }
        int n = (int) Math.min(c, have);
        long price = p;
        listAct.run(h, "listing " + n + " " + EconGfx.name(item) + " at " + price + " each…", Econ.get().list(item, n, price),
                r -> "listed " + J.integer(r.body(), "removed", n) + " " + EconGfx.name(item) + " at " + EconText.coins(price) + " each",
                r -> listCount.clear());
    }

    @Override
    public void render(EconHost h, Ui ui, ControlScreen.Area a, long now) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        EconState es = EconPanel.es();
        int rw = Math.max(160, Math.min(212, (int) (a.w() * 0.38)));
        lx = a.x(); lw = a.w() - rw - 6;

        // ---- search row
        int sw = Math.min(140, lw - 90);
        if (search != null) { search.setX(lx); search.setY(a.y()); search.setWidth(sw); }
        int cx = lx + sw + 6;
        ui.chip(cx, a.y() + 1, hideMine ? "others only" : "incl. mine", Gfx.INFO, hideMine, () -> hideMine = !hideMine);
        List<EconState.Listing> list = filtered(es);
        int chipEnd = cx + tr.getWidth(hideMine ? "others only" : "incl. mine") + 14;
        if (buyAct.active(now)) buyAct.render(ui, chipEnd, a.y() + 3, lx + lw - chipEnd, now);
        else {
            String cnt = list.size() + (list.size() == 1 ? " listing" : " listings");
            g.drawText(tr, cnt, lx + lw - tr.getWidth(cnt), a.y() + 3, Gfx.FAINT, false);
        }

        // ---- listing rows
        EconState.Listing sel = selectedId < 0 ? null : es.listing(selectedId);
        if (sel == null) selectedId = -1;
        int barH = sel != null ? 22 : 0;
        ly = a.y() + 18; lh = a.h() - 18 - barH;
        g.fill(lx, ly, lx + lw, ly + lh, 0x50080B10);
        int rowH = 23;
        contentH = list.size() * rowH;
        viewH = lh - 4;
        scroll = Tab.clampScroll(scroll, contentH, viewH);
        g.enableScissor(lx, ly + 1, lx + lw, ly + lh - 1);
        int y = ly + 2 - scroll;
        for (EconState.Listing l : list) {
            if (y + rowH >= ly && y <= ly + lh) {
                boolean mine = es.isMe(l.seller());
                boolean isSel = l.id() == selectedId;
                boolean hv = ui.hover(lx + 2, y, lw - 4, rowH - 2) && ui.hover(lx, ly, lw, lh);
                g.fill(lx + 2, y, lx + lw - 2, y + rowH - 2, isSel ? EconGfx.ROW_SEL : hv ? EconGfx.ROW_HOVER : EconGfx.ROW);
                if (isSel) g.drawBorder(lx + 2, y, lw - 4, rowH - 2, Gfx.GOLD);
                g.fill(lx + 2, y, lx + 4, y + rowH - 2, EconGfx.who(l.seller()));
                EconGfx.slot(g, lx + 6, y + 2, 18, false, false);
                EconGfx.item(g, tr, l.item(), lx + 7, y + 3, l.count());
                // price (right)
                String pe = EconText.coins(l.price());
                int pw = tr.getWidth(pe);
                int px = lx + lw - 8 - pw;
                g.drawText(tr, pe, px, y + 3, 0xFFFFE9A8, true);
                EconGfx.coin(g, px - 10, y + 3, 1);
                String tot = "each · " + EconText.coinsShort(l.total()) + " all";
                g.drawText(tr, tot, lx + lw - 8 - tr.getWidth(tot), y + 12, Gfx.FAINT, false);
                int textW = lw - 30 - Math.max(pw + 12, tr.getWidth(tot)) - 10;
                g.drawText(tr, Gfx.fit(tr, EconGfx.name(l.item()) + " × " + l.count(), textW), lx + 28, y + 3, Gfx.TEXT, false);
                String who = (mine ? "you" : l.seller()) + (l.shop() != null && !l.shop().isBlank() ? " · " + l.shop() : "");
                g.drawText(tr, Gfx.fit(tr, who, textW), lx + 28, y + 12, mine ? 0xFFFFFF55 : UiMath.lerpColor(EconGfx.who(l.seller()), Gfx.MUTED, 0.3), false);
                if (y >= ly && y + rowH <= ly + lh) {
                    ui.region(lx + 2, y, lw - 4, rowH - 2, () -> {
                        if (selectedId != l.id()) { selectedId = l.id(); buyQty.setMax(l.count()); buyQty.set(l.count()); }
                        EconGfx.soundClick();
                    }, "#" + l.id() + " · " + EconText.coins(l.price()) + " each" + (l.ts() > 0 ? " · listed " + UiMath.formatAge(Math.max(0, now - l.ts())) + " ago" : ""));
                }
            }
            y += rowH;
        }
        g.disableScissor();
        if (list.isEmpty()) {
            g.drawCenteredTextWithShadow(tr, es.listings().isEmpty() ? "no listings yet" : "nothing matches", lx + lw / 2, ly + 24, Gfx.FAINT);
            if (es.listings().isEmpty()) g.drawCenteredTextWithShadow(tr, "bots list items here; list yours on the right →", lx + lw / 2, ly + 36, Gfx.FAINT);
        }
        if (contentH > viewH) {
            int bh = Math.max(10, viewH * viewH / contentH);
            int by = ly + 2 + (viewH - bh) * scroll / Math.max(1, contentH - viewH);
            g.fill(lx + lw - 3, by, lx + lw - 1, by + bh, 0x80FFFFFF);
        }

        // ---- buy bar
        if (sel != null) {
            int by = a.bottom() - 18;
            boolean mine = es.isMe(sel.seller());
            g.fill(lx, by - 2, lx + lw, a.bottom(), 0xC0141922);
            g.fill(lx, by - 2, lx + lw, by - 1, UiMath.withAlpha(EconGfx.COIN, 0.6));
            if (mine) {
                buyQty.hide();
                g.drawText(tr, Gfx.fit(tr, "your listing #" + sel.id() + ": " + sel.count() + " " + EconGfx.name(sel.item()), lw - 80), lx + 4, by + 3, Gfx.TEXT, false);
                ui.button(lx + lw - 70, by, 68, 14, listAct.busy() ? "…" : "✕ Cancel", Gfx.BAD, !listAct.busy(), () -> unlist(h, sel), "items come back to you");
            } else {
                buyQty.setMax(sel.count());
                g.drawText(tr, "Buy", lx + 4, by + 3, Gfx.MUTED, false);
                buyQty.render(ui, lx + 26, by, 70, true, 1);
                int n = (int) buyQty.valueOr(1);
                long cost = (long) n * sel.price();
                String of = "of " + sel.count() + " =";
                g.drawText(tr, of, lx + 100, by + 3, Gfx.MUTED, false);
                int ax = lx + 104 + tr.getWidth(of);
                EconGfx.amount(g, tr, cost, ax, by + 3, cost > es.balance() ? EconGfx.MONEY_OUT : 0xFFFFE9A8);
                boolean can = buyQty.valid() && cost <= es.balance() && !buyAct.busy();
                ui.button(lx + lw - 56, by, 54, 14, buyAct.busy() ? "…" : "Buy", EconGfx.COIN, can, () -> buy(h, sel, n), "buy " + n + " " + EconGfx.name(sel.item()) + " from " + sel.seller());
                if (!can && !buyAct.busy()) ui.region(lx + lw - 56, by, 54, 14, null, cost > es.balance() ? "not enough coins" : "type a quantity");
            }
        } else buyQty.hide();

        // ---- my shop (right)
        int rx = a.right() - rw;
        EconGfx.card(g, rx, a.y(), rw, a.h());
        EconState.Shop shop = es.shopOf(es.me());
        EconGfx.title(g, tr, shop != null && !shop.name().isBlank() ? Gfx.fit(tr, "My shop · " + shop.name(), rw - 12) : "My shop", rx + 6, a.y() + 4, rw - 12, Gfx.GOLD);
        int py = a.y() + 17;
        int pickH = a.h() > 230 ? 3 * InvPicker.SLOT + 4 : 2 * InvPicker.SLOT + 4;
        picker.validate();
        picker.render(ui, rx + 5, py, rw - 10, pickH, null);
        py += pickH + 4;
        String item = picker.selected();
        if (item != null && !item.equals(lastPicked)) {
            lastPicked = item;
            listCount.set(Inv.count(item));
            EconState.ShopItem ref = es.shopItem(item);
            if (listPrice.value() == null && ref != null) {
                long hint = ref.buy() != null ? Math.max(1, ref.buy() - 1) : ref.sell() != null ? ref.sell() + 1 : 1;
                listPrice.set(hint);
            }
        }
        if (item == null) {
            g.drawText(tr, "pick an item to sell ↑", rx + 6, py + 1, Gfx.FAINT, false);
            listCount.hide();
            listPrice.hide();
            py += 13;
        } else {
            int have = Inv.count(item);
            g.drawText(tr, Gfx.fit(tr, EconGfx.name(item) + " · you have " + have, rw - 12), rx + 6, py, Gfx.TEXT, false);
            py += 11;
            int half = (rw - 16) / 2;
            listCount.setMax(Math.min(640, Math.max(1, have)));
            g.drawText(tr, "count", rx + 6, py + 3, Gfx.FAINT, false);
            listCount.render(ui, rx + 6 + 30, py, half - 30, false, 1);
            g.drawText(tr, "each", rx + 10 + half, py + 3, Gfx.FAINT, false);
            listPrice.render(ui, rx + 10 + half + 24, py, half - 24, false, 1);
            py += 16;
            EconState.ShopItem ref = es.shopItem(item);
            String refs = ref == null ? "no server price" : "server: " + (ref.buy() != null ? "sells " + ref.buy() : "—") + " · " + (ref.sell() != null ? "buys " + ref.sell() : "—");
            long total = (long) listCount.valueOr(0) * listPrice.valueOr(0);
            g.drawText(tr, Gfx.fit(tr, refs, rw - 70), rx + 6, py + 3, Gfx.FAINT, false);
            boolean can = listCount.valid() && listPrice.valid() && !listAct.busy();
            ui.button(rx + rw - 58, py, 52, 14, listAct.busy() ? "…" : "List", Gfx.GOOD, can, () -> list(h), "list for " + EconText.coins(total) + " total");
            if (!can && !listAct.busy()) ui.region(rx + rw - 58, py, 52, 14, null, "type a count and a price each");
            py += 16;
            if (Inv.risky(item)) { g.drawText(tr, Gfx.fit(tr, "⚠ enchants/damage/names are lost", rw - 12), rx + 6, py, Gfx.WARN, false); py += 10; }
        }
        listAct.render(ui, rx + 6, py, rw - 12, now);
        py += 12;

        // my listings
        List<EconState.Listing> mine = new ArrayList<>();
        for (EconState.Listing l : es.listings()) if (es.isMe(l.seller())) mine.add(l);
        g.drawText(tr, "My listings (" + mine.size() + ")", rx + 6, py, Gfx.MUTED, false);
        py += 11;
        mx0 = rx; my0 = py; mw = rw; mh = a.bottom() - 3 - py;
        myViewH = mh;
        int mRow = 14;
        myContentH = mine.size() * mRow;
        myScroll = Tab.clampScroll(myScroll, myContentH, myViewH);
        if (mh > 6) {
            g.enableScissor(rx + 1, py, rx + rw - 1, a.bottom() - 3);
            int my = py - myScroll;
            for (EconState.Listing l : mine) {
                if (my + mRow >= py && my <= a.bottom()) {
                    boolean hv = ui.hover(rx + 4, my, rw - 8, mRow - 1);
                    g.fill(rx + 4, my, rx + rw - 4, my + mRow - 1, hv ? EconGfx.ROW_HOVER : EconGfx.ROW);
                    Gfx.item(g, l.item(), rx + 6, my + 1, 12);
                    String s = l.count() + " " + EconGfx.name(l.item()) + " @ " + EconText.coins(l.price());
                    g.drawText(tr, Gfx.fit(tr, s, rw - 40), rx + 21, my + 3, Gfx.TEXT, false);
                    if (my >= py && my + mRow <= a.bottom())
                        ui.button(rx + rw - 18, my + 1, 12, 11, "✕", Gfx.BAD, !listAct.busy(), () -> unlist(h, l), "cancel #" + l.id() + ": items come back");
                }
                my += mRow;
            }
            g.disableScissor();
            if (mine.isEmpty()) g.drawText(tr, "nothing listed", rx + 8, py + 2, Gfx.FAINT, false);
        }
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        if (picker.scrolled(mx, my, v)) return true;
        if (mx >= lx && mx < lx + lw && my >= ly && my < ly + lh) {
            scroll = Tab.clampScroll(scroll - (int) (v * 23), contentH, viewH);
            return true;
        }
        if (mx >= mx0 && mx < mx0 + mw && my >= my0 && my < my0 + mh) {
            myScroll = Tab.clampScroll(myScroll - (int) (v * 14), myContentH, myViewH);
            return true;
        }
        return false;
    }

    @Override
    public boolean key(EconHost h, int key, int scan, int mods) {
        if (key != GLFW.GLFW_KEY_ENTER && key != GLFW.GLFW_KEY_KP_ENTER) return false;
        if (listCount.focused() || listPrice.focused()) { list(h); return true; }
        if (buyQty.focused()) {
            EconState.Listing l = selectedId < 0 ? null : EconPanel.es().listing(selectedId);
            if (l != null) buy(h, l, (int) buyQty.valueOr(1));
            return true;
        }
        return false;
    }
}
