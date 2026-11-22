package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.Econ;
import com.hivecraft.overlay.core.EconState;
import com.hivecraft.overlay.core.EconText;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.screen.tabs.Tab;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.gui.DrawContext;
import org.lwjgl.glfw.GLFW;

import java.util.List;

/** Auctions: live list (current bid, top bidder, countdown) with Bid; create an auction from the inventory. */
public final class AuctionsView implements EconView {
    private static final int[] DURATIONS = {5, 15, 30, 60, 240};

    private int selectedId = -1;
    private final NumField bidAmount = new NumField("bid", 1, 1_000_000);
    private long prefilled = -1;
    private final NumField count = new NumField("count", 1, 640);
    private final NumField start = new NumField("start", 1, 1_000_000);
    private int minutes = 15;
    private final InvPicker picker = new InvPicker();
    private final Act bidAct = new Act();
    private final Act createAct = new Act();
    private String lastPicked;
    private int scroll, contentH, viewH, lx, ly, lw, lh;

    @Override public String title() { return "Auctions"; }
    @Override public String icon() { return "⚖"; }

    @Override
    public void open(EconHost h) {
        bidAmount.open(h);
        count.open(h);
        start.open(h);
    }

    @Override
    public void close(EconHost h) {
        bidAmount.close(h);
        count.close(h);
        start.close(h);
    }

    @Override
    public void hideFields() {
        bidAmount.hide();
        count.hide();
        start.hide();
    }

    @Override
    public boolean typing() { return bidAmount.focused() || count.focused() || start.focused(); }

    private void bid(EconHost h, EconState.Auction a) {
        EconState es = EconPanel.es();
        Long v = bidAmount.value();
        if (v == null) { bidAct.error(h, "type your bid (total for the lot)"); return; }
        if (v < a.minNext()) { bidAct.error(h, "bid too low: minimum next bid is " + EconText.coins(a.minNext())); return; }
        long extra = es.isMe(a.bidder()) && a.bid() != null ? v - a.bid() : v;
        if (extra > es.balance()) { bidAct.error(h, "not enough coins: have " + EconText.coins(es.balance()) + ", need " + EconText.coins(extra)); return; }
        long amt = v;
        bidAct.run(h, "bidding " + EconText.coins(amt) + " on #" + a.id() + "…", Econ.get().bid(a.id(), amt),
                r -> "you lead auction #" + a.id() + " at " + EconText.coins(amt), null);
    }

    private void cancel(EconHost h, EconState.Auction a) {
        bidAct.run(h, "cancelling auction #" + a.id() + "…", Econ.get().cancelAuction(a.id()), r -> "auction #" + a.id() + " cancelled: items back", null);
    }

    private void create(EconHost h) {
        String item = picker.selected();
        if (item == null) { createAct.error(h, "pick an item from your inventory"); return; }
        int have = Inv.count(item);
        if (have <= 0) { createAct.error(h, "you have no " + EconGfx.name(item) + " in your inventory"); return; }
        Long c = count.value(), s = start.value();
        if (c == null || c <= 0) { createAct.error(h, "type how many to auction"); return; }
        if (s == null || s <= 0) { createAct.error(h, "type a start price (for the lot)"); return; }
        int n = (int) Math.min(c, have);
        long st = s;
        int mins = minutes;
        createAct.run(h, "starting auction…", Econ.get().auction(item, n, st, mins),
                r -> "auction started: " + n + " " + EconGfx.name(item) + " from " + EconText.coins(st) + ", " + mins + " min",
                r -> { count.clear(); start.clear(); });
    }

    @Override
    public void render(EconHost h, Ui ui, ControlScreen.Area a, long now) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        EconState es = EconPanel.es();
        long serverNow = now + Hive.state().serverTimeOffset();
        int rw = Math.max(160, Math.min(206, (int) (a.w() * 0.37)));
        lx = a.x(); lw = a.w() - rw - 6;

        List<EconState.Auction> list = es.auctions();
        int open = 0;
        for (EconState.Auction x : list) if (x.open()) open++;
        g.drawText(tr, "LIVE", lx + 2, a.y() + 3, open > 0 ? Gfx.BAD : Gfx.FAINT, false);
        if (open > 0) Gfx.dot(g, lx + 26, a.y() + 5, Gfx.BAD, now, true);
        g.drawText(tr, open + " open" + (list.size() > open ? " · " + (list.size() - open) + " ended" : ""), lx + 34, a.y() + 3, Gfx.MUTED, false);
        if (bidAct.active(now)) bidAct.render(ui, lx + 120, a.y() + 3, lw - 120, now);

        EconState.Auction sel = selectedId < 0 ? null : es.auction(selectedId);
        if (sel == null) selectedId = -1;
        boolean bar = sel != null && (sel.open());
        int barH = bar ? 22 : 0;
        ly = a.y() + 16; lh = a.h() - 16 - barH;
        g.fill(lx, ly, lx + lw, ly + lh, 0x50080B10);
        int rowH = 27;
        contentH = list.size() * rowH;
        viewH = lh - 4;
        scroll = Tab.clampScroll(scroll, contentH, viewH);
        g.enableScissor(lx, ly + 1, lx + lw, ly + lh - 1);
        int y = ly + 2 - scroll;
        for (EconState.Auction au : list) {
            if (y + rowH >= ly && y <= ly + lh) row(ui, au, lx + 2, y, lw - 4, rowH - 2, serverNow, now, es,
                    y >= ly && y + rowH <= ly + lh, h);
            y += rowH;
        }
        g.disableScissor();
        if (list.isEmpty()) {
            g.drawCenteredTextWithShadow(tr, "no auctions running", lx + lw / 2, ly + 24, Gfx.FAINT);
            g.drawCenteredTextWithShadow(tr, "start one from your inventory →", lx + lw / 2, ly + 36, Gfx.FAINT);
        }
        if (contentH > viewH) {
            int bh = Math.max(10, viewH * viewH / contentH);
            int by = ly + 2 + (viewH - bh) * scroll / Math.max(1, contentH - viewH);
            g.fill(lx + lw - 3, by, lx + lw - 1, by + bh, 0x80FFFFFF);
        }

        // ---- bid bar
        if (bar) {
            int by = a.bottom() - 18;
            g.fill(lx, by - 2, lx + lw, a.bottom(), 0xC0141922);
            g.fill(lx, by - 2, lx + lw, by - 1, UiMath.withAlpha(EconGfx.COIN, 0.6));
            if (es.isMe(sel.seller())) {
                bidAmount.hide();
                g.drawText(tr, Gfx.fit(tr, "your auction #" + sel.id() + (sel.bids() > 0 ? " · " + sel.bids() + " bids" : " · no bids yet"), lw - 80), lx + 4, by + 3, Gfx.TEXT, false);
                if (sel.bids() == 0 && sel.bid() == null)
                    ui.button(lx + lw - 70, by, 68, 14, bidAct.busy() ? "…" : "✕ Cancel", Gfx.BAD, !bidAct.busy(), () -> cancel(h, sel), "only while nobody has bid");
            } else {
                // keep the field on the minimum next bid unless the player typed their own number
                Long cur = bidAmount.value();
                boolean refill = cur == null ? !bidAmount.focused() : cur == prefilled && prefilled != sel.minNext();
                if (refill) { bidAmount.set(sel.minNext()); prefilled = sel.minNext(); }
                g.drawText(tr, "Bid", lx + 4, by + 3, Gfx.MUTED, false);
                int fw = Math.min(90, lw - 170);
                bidAmount.render(ui, lx + 24, by, fw, true, Math.max(1, sel.minNext() - sel.price()));
                int bx = lx + 28 + fw;
                String min = "min " + EconText.coins(sel.minNext());
                g.drawText(tr, min, bx, by + 3, Gfx.FAINT, false);
                bx += tr.getWidth(min) + 4;
                if (bx + 30 < lx + lw - 58)
                    ui.button(bx, by + 1, 26, 12, "min", Gfx.INFO, true, () -> { bidAmount.set(sel.minNext()); prefilled = sel.minNext(); }, "reset to the minimum next bid");
                boolean can = bidAmount.valid() && bidAmount.valueOr(0) >= sel.minNext() && !bidAct.busy();
                ui.button(lx + lw - 56, by, 54, 14, bidAct.busy() ? "…" : "⚖ Bid", EconGfx.COIN, can, () -> bid(h, sel), "bid is the total for the whole lot");
                if (!can && !bidAct.busy()) ui.region(lx + lw - 56, by, 54, 14, null, "at least " + EconText.coins(sel.minNext()));
            }
        } else bidAmount.hide();

        // ---- create (right)
        int rx = a.right() - rw;
        EconGfx.card(g, rx, a.y(), rw, a.h());
        EconGfx.title(g, tr, "Start an auction", rx + 6, a.y() + 4, rw - 12, Gfx.GOLD);
        int py = a.y() + 17;
        int pickH = a.h() > 220 ? 3 * InvPicker.SLOT + 4 : 2 * InvPicker.SLOT + 4;
        picker.validate();
        picker.render(ui, rx + 5, py, rw - 10, pickH, null);
        py += pickH + 4;
        String item = picker.selected();
        if (item != null && !item.equals(lastPicked)) {
            lastPicked = item;
            count.set(Inv.count(item));
            EconState.ShopItem ref = es.shopItem(item);
            if (start.value() == null) {
                long per = ref == null ? 1 : ref.sell() != null ? ref.sell() : ref.buy() != null ? Math.max(1, ref.buy() / 2) : 1;
                start.set(Math.max(1, per * Math.min(640, Inv.count(item))));
            }
        }
        if (item == null) {
            g.drawText(tr, "pick an item to auction ↑", rx + 6, py + 1, Gfx.FAINT, false);
            count.hide();
            start.hide();
            py += 13;
        } else {
            int have = Inv.count(item);
            g.drawText(tr, Gfx.fit(tr, EconGfx.name(item) + " · you have " + have, rw - 12), rx + 6, py, Gfx.TEXT, false);
            py += 11;
            int half = (rw - 16) / 2;
            count.setMax(Math.min(640, Math.max(1, have)));
            g.drawText(tr, "count", rx + 6, py + 3, Gfx.FAINT, false);
            count.render(ui, rx + 36, py, half - 30, false, 1);
            g.drawText(tr, "start", rx + 10 + half, py + 3, Gfx.FAINT, false);
            start.render(ui, rx + 10 + half + 26, py, half - 26, false, 1);
            py += 17;
            int cx = rx + 6;
            for (int d : DURATIONS) {
                String l = d >= 60 ? (d / 60) + "h" : d + "m";
                cx += ui.chip(cx, py, l, Gfx.INFO, minutes == d, () -> minutes = d) + 2;
            }
            py += 15;
            if (Inv.risky(item)) { g.drawText(tr, Gfx.fit(tr, "⚠ enchants/damage/names are lost", rw - 12), rx + 6, py, Gfx.WARN, false); py += 10; }
            boolean can = count.valid() && start.valid() && !createAct.busy();
            ui.button(rx + 6, py, rw - 12, 15, createAct.busy() ? "…" : "⚖ Start auction · " + (minutes >= 60 ? minutes / 60 + " h" : minutes + " min"), EconGfx.COIN, can,
                    () -> create(h), "items go into escrow until it ends");
            if (!can && !createAct.busy()) ui.region(rx + 6, py, rw - 12, 15, null, "type a count and a start price");
            py += 18;
        }
        createAct.render(ui, rx + 6, py, rw - 12, now);
        py += 12;
        // rules hint
        if (a.bottom() - py > 30) {
            int hy = a.bottom() - 30;
            g.drawText(tr, Gfx.fit(tr, "Bids are the total for the lot.", rw - 12), rx + 6, hy, Gfx.FAINT, false);
            g.drawText(tr, Gfx.fit(tr, "Next bid ≥ +5%. Late bids add 30 s.", rw - 12), rx + 6, hy + 10, Gfx.FAINT, false);
            g.drawText(tr, Gfx.fit(tr, "Outbid? Your coins come back.", rw - 12), rx + 6, hy + 20, Gfx.FAINT, false);
        }
    }

    private void row(Ui ui, EconState.Auction au, int x, int y, int w, int h, long serverNow, long now, EconState es, boolean clickable, EconHost host) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        boolean isSel = au.id() == selectedId;
        boolean hv = ui.hover(x, y, w, h) && ui.hover(lx, ly, lw, lh);
        boolean live = au.open();
        boolean mine = es.isMe(au.seller());
        boolean leading = live && es.isMe(au.bidder());
        g.fill(x, y, x + w, y + h, isSel ? EconGfx.ROW_SEL : hv ? EconGfx.ROW_HOVER : live ? EconGfx.ROW : 0x70121620);
        if (isSel) g.drawBorder(x, y, w, h, Gfx.GOLD);
        g.fill(x, y, x + 2, y + h, leading ? EconGfx.MONEY_IN : EconGfx.who(au.seller()));
        EconGfx.slot(g, x + 4, y + 3, 18, false, false);
        EconGfx.item(g, tr, au.item(), x + 5, y + 4, au.count());
        if (!live) g.fill(x + 4, y + 3, x + 22, y + 21, 0x90101418);

        // countdown pill (right)
        long left = au.endsAt() - serverNow;
        String cd;
        int cdCol;
        if (live) {
            cd = EconText.countdown(left);
            cdCol = left < 30_000 ? Gfx.BAD : left < 120_000 ? Gfx.WARN : Gfx.TEXT;
        } else {
            cd = switch (au.status()) {
                case "sold" -> "SOLD";
                case "unsold" -> "UNSOLD";
                case "cancelled" -> "CANCELLED";
                default -> "ENDED";
            };
            cdCol = "sold".equals(au.status()) ? Gfx.GOOD : Gfx.FAINT;
        }
        int cw = tr.getWidth(cd) + 8;
        int cx = x + w - cw - 4;
        double pulse = live && left < 30_000 ? 0.5 + 0.5 * Math.sin(now / 140.0) : 0;
        g.fill(cx, y + 3, cx + cw, y + 14, UiMath.lerpColor(0xC0181D28, 0xC0601818, pulse));
        g.drawText(tr, cd, cx + 4, y + 5, cdCol, false);

        // price
        String price = EconText.coins(au.price());
        int pw = tr.getWidth(price);
        int px = cx - 8 - pw;
        g.drawText(tr, price, px, y + 5, live ? 0xFFFFE9A8 : Gfx.MUTED, true);
        EconGfx.coin(g, px - 10, y + 5, 1);
        String label = au.bid() != null ? "top bid" : "start";
        g.drawText(tr, label, x + w - 4 - tr.getWidth(label), y + 16, Gfx.FAINT, false);

        int tw = px - 14 - (x + 26);
        g.drawText(tr, Gfx.fit(tr, EconGfx.name(au.item()) + " × " + au.count(), tw), x + 26, y + 4, live ? Gfx.TEXT : Gfx.MUTED, false);
        String sub;
        int subCol;
        if (live) {
            if (leading) { sub = "▲ you're winning"; subCol = EconGfx.MONEY_IN; }
            else if (au.bidder() != null) { sub = "top: " + au.bidder() + " · " + au.bids() + (au.bids() == 1 ? " bid" : " bids"); subCol = UiMath.lerpColor(EconGfx.who(au.bidder()), Gfx.MUTED, 0.3); }
            else { sub = "no bids yet"; subCol = Gfx.FAINT; }
            if (mine) { sub = "your auction · " + sub; subCol = 0xFFFFFF55; }
        } else {
            String win = au.winner() != null ? au.winner() : "sold".equals(au.status()) ? au.bidder() : null;
            sub = win != null ? "won by " + (es.isMe(win) ? "you" : win) : "by " + EconGfx.display(au.seller());
            subCol = win != null && es.isMe(win) ? EconGfx.MONEY_IN : Gfx.FAINT;
        }
        g.drawText(tr, Gfx.fit(tr, sub, Math.max(20, x + w - 50 - (x + 26))), x + 26, y + 15, subCol, false);
        if (clickable) {
            String tip = "#" + au.id() + " by " + EconGfx.display(au.seller()) + " · start " + EconText.coins(au.start()) + (live ? " · min next " + EconText.coins(au.minNext()) : "");
            ui.region(x, y, w, h, () -> {
                if (selectedId != au.id()) { selectedId = au.id(); prefilled = -1; bidAmount.clear(); }
                EconGfx.soundClick();
            }, tip);
        }
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        if (picker.scrolled(mx, my, v)) return true;
        if (mx >= lx && mx < lx + lw && my >= ly && my < ly + lh) {
            scroll = Tab.clampScroll(scroll - (int) (v * 27), contentH, viewH);
            return true;
        }
        return false;
    }

    @Override
    public boolean key(EconHost h, int key, int scan, int mods) {
        if (key != GLFW.GLFW_KEY_ENTER && key != GLFW.GLFW_KEY_KP_ENTER) return false;
        if (count.focused() || start.focused()) { create(h); return true; }
        if (bidAmount.focused()) {
            EconState.Auction a = selectedId < 0 ? null : EconPanel.es().auction(selectedId);
            if (a != null && a.open()) bid(h, a);
            return true;
        }
        return false;
    }
}
