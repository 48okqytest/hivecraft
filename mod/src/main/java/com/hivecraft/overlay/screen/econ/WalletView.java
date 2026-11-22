package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Econ;
import com.hivecraft.overlay.core.EconState;
import com.hivecraft.overlay.core.EconText;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.screen.tabs.Tab;
import com.hivecraft.overlay.ui.UiConfig;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.widget.TextFieldWidget;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Wallet: big balance, pay someone (bot picker + amount + note), richest list, recent transactions. */
public final class WalletView implements EconView {
    private final NumField amount = new NumField("amount", 1, 1_000_000);
    private TextFieldWidget note;
    private String noteText = "";
    private String payTo;
    private final Act act = new Act();
    private int txScroll, txContentH, txViewH;
    private int txX, txY, txW, txH;

    @Override public String title() { return "Wallet"; }
    @Override public String icon() { return "◉"; }

    @Override
    public void open(EconHost h) {
        amount.open(h);
        note = h.textField(-500, -500, 60, "note (optional)");
        note.setMaxLength(80);
        note.setText(noteText);
    }

    @Override
    public void close(EconHost h) {
        amount.close(h);
        if (note != null) { noteText = note.getText(); h.removeWidget(note); }
        note = null;
    }

    @Override
    public void hideFields() {
        amount.hide();
        if (note != null) { note.setX(-500); note.setY(-500); }
    }

    @Override
    public boolean typing() { return amount.focused() || (note != null && note.isFocused()); }

    private List<String> recipients(EconState es) {
        Set<String> s = new LinkedHashSet<>();
        for (BotState b : Hive.state().bots()) s.add(b.name());
        for (String n : es.wallets().keySet()) s.add(n);
        List<String> out = new ArrayList<>();
        for (String n : s) if (!es.isMe(n) && !n.equalsIgnoreCase("Server") && !n.equalsIgnoreCase("Escrow") && !n.equalsIgnoreCase("Bank")) out.add(n);
        return out;
    }

    private void pay(EconHost h) {
        EconState es = EconPanel.es();
        if (payTo == null) { act.error(h, "pick who to pay"); return; }
        Long v = amount.value();
        if (v == null || v <= 0) { act.error(h, "type an amount (whole coins)"); return; }
        if (v > es.balance()) { act.error(h, "not enough coins: have " + EconText.coins(es.balance()) + ", need " + EconText.coins(v)); return; }
        String to = payTo;
        String n = note == null ? "" : note.getText();
        act.run(h, "paying " + to + " " + EconText.coins(v) + "…", Econ.get().pay(to, v, n),
                r -> "paid " + to + " " + EconText.coins(v) + " coins", r -> { amount.clear(); if (note != null) note.setText(""); });
    }

    @Override
    public void render(EconHost h, Ui ui, ControlScreen.Area a, long now) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        EconState es = EconPanel.es();
        int lw = Math.max(170, Math.min(240, (int) (a.w() * 0.42)));
        int lx = a.x(), y = a.y();

        // ---- balance card
        int bh = 50;
        EconGfx.card(g, lx, y, lw, bh);
        g.fillGradient(lx + 1, y + 1, lx + lw - 1, y + bh - 1, 0x30FFC93C, 0x00FFC93C);
        g.drawText(tr, "BALANCE", lx + 8, y + 6, Gfx.FAINT, false);
        EconGfx.coin(g, lx + 8, y + 18, 2);
        String num = EconText.coins(es.balance());
        float sc = tr.getWidth(num) * 2.5f + 40 < lw ? 2.5f : 2f;
        EconGfx.big(g, tr, num, lx + 30, y + (sc > 2 ? 16 : 18), sc, 0xFFFFE9A8);
        String sub = es.held() > 0 ? "+" + EconText.coins(es.held()) + " held in bids" : es.currency();
        g.drawText(tr, sub, lx + 30, y + bh - 10, Gfx.MUTED, false);
        // earned today (jobs, bounties, mob kills, milestones, wage)
        var earn = es.earn();
        if (earn.available()) {
            long td = earn.today(now);
            int room = lx + lw - 6 - (lx + 30 + tr.getWidth(sub) + 6);
            String et = "earned today +" + EconText.coinsShort(td);
            if (tr.getWidth(et) > room) et = "+" + EconText.coinsShort(td) + " today";
            int ew = tr.getWidth(et);
            int ex = lx + lw - 6 - ew;
            if (ex > lx + 30 + tr.getWidth(sub) + 6) {
                g.drawText(tr, et, ex, y + bh - 10, td > 0 ? EconGfx.MONEY_IN : Gfx.FAINT, false);
                StringBuilder tip = new StringBuilder("earned today: ").append(EconText.coins(td));
                long tot = earn.total();
                if (tot > 0) {
                    tip.append(" · this world");
                    for (String src : com.hivecraft.overlay.core.EarnState.SOURCES) {
                        long v = earn.totals().getOrDefault(src, 0L);
                        if (v > 0) tip.append(" · ").append(src).append(' ').append(EconText.coinsShort(v));
                    }
                }
                ui.region(ex - 2, y + bh - 11, ew + 4, 10, null, tip.toString());
            }
        }
        String w = es.world().isBlank() ? "" : es.world();
        if (!w.isBlank()) g.drawText(tr, Gfx.fit(tr, w, lw / 2 - 8), lx + lw - 6 - Math.min(lw / 2 - 8, tr.getWidth(w)), y + 6, Gfx.FAINT, false);
        y += bh + 5;

        // ---- pay card
        List<String> rec = recipients(es);
        if (payTo != null && !rec.contains(payTo)) payTo = null;
        int chipRows = 1;
        { int cx = 0; for (String n : rec) { int cw = tr.getWidth(n) + 8 + 2; if (cx + cw > lw - 14 && cx > 0) { chipRows++; cx = 0; } cx += cw; } }
        chipRows = Math.min(chipRows, 3);
        int ph = 16 + chipRows * 14 + 4 + 16 + 16 + 12;
        EconGfx.card(g, lx, y, lw, ph);
        EconGfx.title(g, tr, "Pay someone", lx + 6, y + 4, lw - 12, Gfx.GOLD);
        int cy = y + 18, cx = lx + 6, row = 0;
        if (rec.isEmpty()) g.drawText(tr, "no one to pay yet", cx, cy + 2, Gfx.FAINT, false);
        for (String n : rec) {
            int cw = tr.getWidth(n) + 8;
            if (cx + cw > lx + lw - 6 && cx > lx + 6) { row++; cx = lx + 6; cy += 14; }
            if (row >= chipRows) break;
            boolean sel = n.equals(payTo);
            int col = EconGfx.who(n);
            boolean hv = ui.hover(cx, cy, cw, 12);
            g.fill(cx, cy, cx + cw, cy + 12, sel ? UiMath.withAlpha(col, 0.40) : hv ? 0x50FFFFFF : 0x80181D28);
            if (sel) g.fill(cx, cy + 11, cx + cw, cy + 12, col);
            g.drawText(tr, n, cx + 4, cy + 2, sel ? 0xFFFFFFFF : UiMath.lerpColor(col, Gfx.MUTED, 0.35), false);
            Long wb = es.wallets().get(n);
            ui.region(cx, cy, cw, 12, () -> { payTo = n; EconGfx.soundClick(); }, wb == null ? null : n + " has " + EconText.coins(wb));
            cx += cw + 2;
        }
        int fy = y + 18 + chipRows * 14 + 4;
        int aw = Math.min(90, (lw - 12) / 2);
        amount.render(ui, lx + 6, fy, aw, true, 5);
        // quick amounts
        int qx = lx + 6 + aw + 4;
        for (long q : new long[]{5, 10, 25, 100}) {
            String l = String.valueOf(q);
            int qw = tr.getWidth(l) + 6;
            if (qx + qw > lx + lw - 6) break;
            ui.button(qx, fy + 1, qw, 12, l, Gfx.INFO, true, () -> amount.set(q), null);
            qx += qw + 2;
        }
        if (note != null) { note.setX(lx + 6); note.setY(fy + 16); note.setWidth(lw - 12 - 58); }
        boolean can = payTo != null && amount.valid() && !act.busy();
        String pl = act.busy() ? "…" : "Pay";
        ui.button(lx + lw - 6 - 54, fy + 16, 54, 14, pl, Gfx.GOOD, can, () -> pay(h), payTo == null ? null : "pay " + payTo);
        if (!can && !act.busy()) ui.region(lx + lw - 60, fy + 16, 54, 14, null, payTo == null ? "pick who to pay" : "type an amount");
        act.render(ui, lx + 6, fy + 33, lw - 12, now);
        y += ph + 5;

        // ---- richest
        int left = a.bottom() - y;
        if (left > 26) {
            EconGfx.card(g, lx, y, lw, left);
            EconGfx.title(g, tr, "Richest", lx + 6, y + 4, lw - 12, Gfx.INFO);
            int ry = y + 18;
            long top = 1;
            for (long v : es.wallets().values()) top = Math.max(top, v);
            int rank = 0;
            for (var e : es.wallets().entrySet()) {
                if (ry + 10 > y + left) break;
                rank++;
                String n = e.getKey();
                boolean me = es.isMe(n);
                g.drawText(tr, rank + ".", lx + 6, ry, Gfx.FAINT, false);
                g.drawText(tr, Gfx.fit(tr, me ? "You" : n, 60), lx + 20, ry, EconGfx.who(n), false);
                int barX = lx + 84, barW = lw - 84 - 50;
                if (barW > 10) Gfx.bar(g, barX, ry + 1, barW, 6, e.getValue() / (double) top, me ? EconGfx.COIN : UiMath.withAlpha(EconGfx.who(n), 1), 0, 1);
                String v = EconText.coinsShort(e.getValue());
                g.drawText(tr, v, lx + lw - 6 - tr.getWidth(v), ry, me ? 0xFFFFE9A8 : Gfx.TEXT, false);
                ry += 11;
            }
        }

        // ---- transactions (right)
        int rx = lx + lw + 6, rw = a.right() - rx;
        txX = rx; txY = a.y(); txW = rw; txH = a.h();
        EconGfx.card(g, rx, a.y(), rw, a.h());
        EconGfx.title(g, tr, "Recent transactions", rx + 6, a.y() + 4, rw - 12, Gfx.GOLD);
        // HUD chip toggle in the title row
        UiConfig cfg = UiConfig.get();
        String tl = (cfg.econChip ? "■ " : "□ ") + "HUD chip";
        int tw = tr.getWidth(tl);
        boolean thv = ui.hover(rx + rw - 8 - tw, a.y() + 3, tw + 4, 10);
        g.drawText(tr, tl, rx + rw - 6 - tw, a.y() + 4, cfg.econChip ? (thv ? 0xFFFFFFFF : Gfx.GOOD) : (thv ? Gfx.TEXT : Gfx.FAINT), false);
        ui.region(rx + rw - 8 - tw, a.y() + 2, tw + 4, 11, () -> { cfg.econChip = !cfg.econChip; cfg.save(); EconGfx.soundClick(); }, "coin balance chip on the HUD");

        int ly = a.y() + 17;
        List<EconState.Delivery> dl = es.deliveries();
        if (!dl.isEmpty()) {
            int n = 0;
            for (EconState.Delivery d : dl) n += d.count();
            g.fill(rx + 4, ly, rx + rw - 4, ly + 12, 0x40FFB13B);
            g.drawText(tr, Gfx.fit(tr, "⏳ " + n + " items waiting for delivery (you were offline)", rw - 12), rx + 7, ly + 2, Gfx.WARN, false);
            ly += 14;
        }
        txViewH = a.bottom() - 2 - ly;
        List<EconState.Tx> txs = es.tx();
        int rowH = 21;
        txContentH = txs.size() * rowH;
        txScroll = Tab.clampScroll(txScroll, txContentH, txViewH);
        g.enableScissor(rx + 1, ly, rx + rw - 1, a.bottom() - 2);
        int ty = ly - txScroll;
        long serverNow = now + Hive.state().serverTimeOffset();
        for (EconState.Tx t : txs) {
            if (ty + rowH >= ly && ty <= a.bottom()) {
                boolean hv = ui.hover(rx + 3, ty, rw - 6, rowH - 1) && ui.my >= ly;
                g.fill(rx + 3, ty, rx + rw - 3, ty + rowH - 1, hv ? EconGfx.ROW_HOVER : EconGfx.ROW);
                if (t.item() != null && !t.item().isEmpty() && !Gfx.stack(t.item()).isEmpty()) EconGfx.item(g, tr, t.item(), rx + 6, ty + 2, 1);
                else EconGfx.coin(g, rx + 8, ty + 4, 1);
                long d = t.delta(es.me());
                String amt = d == 0 ? (t.amount() > 0 ? EconText.coins(t.amount()) : "") : EconText.signed(d);
                int amtW = tr.getWidth(amt);
                g.drawText(tr, amt, rx + rw - 8 - amtW, ty + 6, d > 0 ? EconGfx.MONEY_IN : d < 0 ? EconGfx.MONEY_OUT : Gfx.MUTED, true);
                g.drawText(tr, Gfx.fit(tr, EconText.describe(t, es.me()), rw - 34 - amtW - 8), rx + 26, ty + 2, Gfx.TEXT, false);
                String age = t.ts() > 0 ? UiMath.formatAge(Math.max(0, serverNow - t.ts())) + " ago" : "";
                g.drawText(tr, age + "  ·  " + t.kind().replace('_', ' '), rx + 26, ty + 11, Gfx.FAINT, false);
                if (hv && t.note() != null && !t.note().isBlank()) ui.tooltip(UiMath.ellipsize(t.note(), 80));
            }
            ty += rowH;
        }
        g.disableScissor();
        if (txs.isEmpty()) g.drawCenteredTextWithShadow(tr, "no transactions yet", rx + rw / 2, ly + 20, Gfx.FAINT);
        if (txContentH > txViewH) {
            int bh2 = Math.max(10, txViewH * txViewH / txContentH);
            int by = ly + (txViewH - bh2) * txScroll / Math.max(1, txContentH - txViewH);
            g.fill(rx + rw - 3, by, rx + rw - 1, by + bh2, 0x80FFFFFF);
        }
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        if (mx >= txX && mx < txX + txW && my >= txY && my < txY + txH) {
            txScroll = Tab.clampScroll(txScroll - (int) (v * 21), txContentH, txViewH);
            return true;
        }
        return false;
    }

    @Override
    public boolean key(EconHost h, int key, int scan, int mods) {
        if ((key == GLFW.GLFW_KEY_ENTER || key == GLFW.GLFW_KEY_KP_ENTER) && typing()) {
            pay(h);
            return true;
        }
        return false;
    }
}
