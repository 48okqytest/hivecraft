package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.Econ;
import com.hivecraft.overlay.core.EconState;
import com.hivecraft.overlay.core.EconText;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.gui.DrawContext;
import org.lwjgl.glfw.GLFW;

import java.util.List;

/**
 * The economy UI body shared by {@link com.hivecraft.overlay.screen.EconomyScreen} (V) and the Control screen's
 * Economy tab: section bar (Wallet · Shop · Market · Auctions · Jobs) with the live balance on the right, then the view.
 */
public final class EconPanel {
    private static int lastView = 0;

    private final List<EconView> views = List.of(new WalletView(), new ShopView(), new MarketView(), new AuctionsView(), new JobsView());
    private int current = lastView;
    private EconHost host;
    private long switchedAt = System.currentTimeMillis();
    private double shownBalance = Double.NaN;
    private long lastFrame;
    private long flashAt;
    private long flashDelta;
    private long lastBalance = Long.MIN_VALUE;

    public void open(EconHost h) {
        host = h;
        current = Math.max(0, Math.min(current, views.size() - 1));
        views.get(current).open(h);
        Econ.get().refreshIfStale(30_000);
    }

    public void close() {
        if (host != null) views.get(current).close(host);
    }

    public void show(int i) {
        if (i < 0 || i >= views.size() || i == current) return;
        if (host != null) views.get(current).close(host);
        current = i;
        lastView = i;
        switchedAt = System.currentTimeMillis();
        if (host != null) views.get(current).open(host);
        EconGfx.soundClick();
    }

    public int count() { return views.size(); }

    public boolean typing() { return views.get(current).typing(); }

    public void render(Ui ui, ControlScreen.Area a, long now) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        EconState es = Econ.state();
        // ---- section bar
        int x = a.x();
        for (int i = 0; i < views.size(); i++) {
            EconView v = views.get(i);
            String label = v.icon() + " " + v.title();
            int w = tr.getWidth(label) + 12;
            boolean sel = i == current;
            boolean hv = ui.hover(x, a.y(), w, 15);
            g.fill(x, a.y(), x + w, a.y() + 15, sel ? 0xFF2A2416 : hv ? 0x50303846 : 0x70141922);
            if (sel) {
                g.fill(x, a.y() + 14, x + w, a.y() + 15, EconGfx.COIN);
                g.fillGradient(x, a.y(), x + w, a.y() + 15, 0x00000000, 0x30FFC93C);
            }
            g.drawText(tr, label, x + 6, a.y() + 4, sel ? 0xFFFFE9A8 : hv ? Gfx.TEXT : Gfx.MUTED, false);
            final int idx = i;
            ui.region(x, a.y(), w, 15, () -> show(idx), null);
            x += w + 2;
        }
        // ---- balance (counts up/down smoothly, flashes the change)
        long bal = es.balance();
        double dt = lastFrame == 0 ? 0 : Math.min(0.25, (now - lastFrame) / 1000.0);
        lastFrame = now;
        if (Double.isNaN(shownBalance) || !es.loaded()) shownBalance = bal;
        if (lastBalance != Long.MIN_VALUE && bal != lastBalance && es.loaded()) { flashAt = now; flashDelta = bal - lastBalance; }
        lastBalance = bal;
        shownBalance = Math.abs(shownBalance - bal) < 0.5 ? bal : shownBalance + (bal - shownBalance) * Math.min(1, dt * 9);
        long shown = Math.round(shownBalance);
        String num = es.loaded() ? EconText.coins(shown) : "—";
        int nw = tr.getWidth(num);
        int rx = a.right() - 2;
        int bx = rx - nw - 12;
        if (es.held() > 0) {
            String h = "+" + EconText.coins(es.held()) + " in bids";
            int hw = tr.getWidth(h);
            g.drawText(tr, h, bx - hw - 6, a.y() + 4, Gfx.FAINT, false);
            ui.region(bx - hw - 6, a.y() + 2, hw, 11, null, "coins locked in your winning bids (refunded if outbid)");
        }
        EconGfx.coin(g, bx, a.y() + 3, 1);
        int flashCol = flashDelta >= 0 ? EconGfx.MONEY_IN : EconGfx.MONEY_OUT;
        double f = now - flashAt < 900 ? 1 - (now - flashAt) / 900.0 : 0;
        g.drawText(tr, num, bx + 11, a.y() + 4, f > 0 ? UiMath.lerpColor(0xFFFFE9A8, flashCol, f) : 0xFFFFE9A8, true);
        ui.region(bx, a.y() + 2, nw + 12, 11, null, "your " + es.currency() + (es.world().isBlank() ? "" : " · world " + es.world()));
        if (f > 0) {
            String d = EconText.signed(flashDelta);
            Gfx.textA(g, tr, d, rx - tr.getWidth(d), a.y() + 16 - (int) ((1 - f) * 6), flashCol, f);
        }
        g.fill(a.x(), a.y() + 15, a.right(), a.y() + 16, 0xFF2A3242);

        // ---- view (no slide: the text fields are screen widgets and would not move with it)
        ControlScreen.Area va = new ControlScreen.Area(a.x(), a.y() + 20, a.w(), a.h() - 20);
        if (es.disabled() != null) { views.get(current).hideFields(); economyOff(ui, va, views.get(current) instanceof JobsView, es.disabled()); }
        else if (!EconGfx.notLoaded(ui, va.x(), va.y(), va.w(), va.h())) views.get(current).render(host, ui, va, now);
        else views.get(current).hideFields();
        double tin = UiMath.easeOutCubic((now - switchedAt) / 160.0);
        if (tin < 1) g.fill(va.x(), va.y() - 4, va.x() + (int) (va.w() * tin), va.y() - 3, UiMath.withAlpha(EconGfx.COIN, 0.5 * (1 - tin)));
    }

    /** The bridge runs without an economy (Hivecraft.exe "Economy: Off"): a calm card instead of a load error. */
    private static void economyOff(Ui ui, ControlScreen.Area a, boolean jobs, String why) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        int cw = Math.min(a.w() - 20, 340), ch = 92;
        int x = a.x() + (a.w() - cw) / 2, y = a.y() + (a.h() - ch) / 2 - 6;
        EconGfx.card(g, x, y, cw, ch);
        int cx = x + cw / 2;
        EconGfx.coin(g, cx - 8, y + 8, 2);
        g.fill(cx - 10, y + 15, cx + 10, y + 17, 0xFFFF6B6B); // struck-through coin
        g.drawCenteredTextWithShadow(tr, "The economy is turned off", cx, y + 30, Gfx.TEXT);
        String l2 = jobs ? "No jobs, bounties, mob bounties, milestones or wage this game."
                : "No coins, shop, market or auctions this game.";
        g.drawCenteredTextWithShadow(tr, Gfx.fit(tr, l2, cw - 12), cx, y + 43, Gfx.MUTED);
        g.drawCenteredTextWithShadow(tr, Gfx.fit(tr, "Turn it on in Hivecraft.exe (Economy) and restart the game.", cw - 12), cx, y + 55, Gfx.FAINT);
        ui.button(cx - 30, y + 70, 60, 14, "↻ Check", Gfx.GOLD, true, () -> Econ.get().refresh(), why);
    }

    public boolean scrolled(double mx, double my, double v) { return views.get(current).scrolled(mx, my, v); }

    /** Section keys: 1-5 (when not typing), Ctrl+Tab cycles; then the view's own keys. */
    public boolean key(int key, int scan, int mods, boolean allowDigits) {
        if (views.get(current).key(host, key, scan, mods)) return true;
        if (allowDigits && !typing() && key >= GLFW.GLFW_KEY_1 && key < GLFW.GLFW_KEY_1 + views.size()) {
            show(key - GLFW.GLFW_KEY_1);
            return true;
        }
        return false;
    }

    public void cycle(boolean back) { show((current + (back ? views.size() - 1 : 1)) % views.size()); }

    /** Hive state accessor kept here so views stay short. */
    static EconState es() { return Hive.state().econ(); }
}
