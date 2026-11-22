package com.hivecraft.overlay.ui.hud;

import com.hivecraft.overlay.core.EarnText;
import com.hivecraft.overlay.core.EconState;
import com.hivecraft.overlay.core.EconText;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.ui.UiConfig;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.layout.HudLayout;
import com.hivecraft.overlay.ui.layout.HudLayout.Rect;
import com.hivecraft.overlay.ui.term.TermLine;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * HUD coin chip (the player's balance, sits under/above the team panel; toggle: UiConfig.econChip) and the economy
 * ticker lines (bought / sold / paid / outbid / won). {@link #onNotice} runs on the network thread: it only touches
 * the thread-safe Ticker and volatile fields.
 */
public final class EconChip {
    private EconChip() {}

    private static double shown = Double.NaN;
    private static long lastFrame;
    private static volatile long flashAt;
    private static volatile long flashDelta;
    private static long lastBalance = Long.MIN_VALUE;

    /** A floating "+N source" rising off the chip for one earning. */
    private record Floater(long amount, String tag, int color, long at) {}
    private static final long FLOAT_MS = 2400, FLOAT_GAP_MS = 260;
    private static final ConcurrentLinkedQueue<Floater> floaters = new ConcurrentLinkedQueue<>();
    private static volatile long lastFloatAt;

    /** Queues a floating "+N tag" over the chip (any thread). Bursts are staggered so they don't overlap. */
    public static void floatEarning(long amount, String tag, int rgb) {
        if (amount == 0) return;
        long now = System.currentTimeMillis();
        long at = Math.max(now, lastFloatAt + FLOAT_GAP_MS);
        lastFloatAt = at;
        floaters.add(new Floater(amount, tag == null ? "" : tag, 0xFF000000 | rgb, at));
        while (floaters.size() > 8) floaters.poll();
    }

    // ------------------------------------------------------------------ HUD chip

    /** Called from a HudRenderCallback after the main HUD (uses this frame's team panel rect). */
    public static void render(DrawContext g, HudRenderer hud) {
        MinecraftClient mc = MinecraftClient.getInstance();
        UiConfig cfg = UiConfig.get();
        if (mc.player == null || mc.options.hudHidden || !cfg.hud || !cfg.econChip) return;
        if (mc.getDebugHud().shouldShowDebugHud()) return;
        EconState es = Hive.state().econ();
        if (!es.loaded() || es.disabled() != null) return;
        long now = System.currentTimeMillis();
        long bal = es.balance();
        if (lastBalance != Long.MIN_VALUE && bal != lastBalance) { flashAt = now; flashDelta = bal - lastBalance; }
        lastBalance = bal;
        double dt = lastFrame == 0 ? 0 : Math.min(0.25, (now - lastFrame) / 1000.0);
        lastFrame = now;
        if (Double.isNaN(shown)) shown = bal;
        shown = Math.abs(shown - bal) < 0.5 ? bal : shown + (bal - shown) * Math.min(1, dt * 7);

        float scale = hud.lastScale() <= 0 ? 1f : hud.lastScale();
        int sw = (int) Math.floor(g.getScaledWindowWidth() / scale);
        int sh = (int) Math.floor(g.getScaledWindowHeight() / scale);
        TextRenderer tr = mc.textRenderer;
        String num = EconText.coins(Math.round(shown));
        String heldS = es.held() > 0 ? " +" + EconText.coinsShort(es.held()) : "";
        int w = 8 + 10 + tr.getWidth(num) + (heldS.isEmpty() ? 0 : tr.getWidth(heldS)) + 6;
        int h = 14;
        Rect team = hud.lastRects().get(UiConfig.TEAM);
        int x, y;
        if (team != null && team.w() > 0) {
            x = team.x();
            boolean below = team.y() + team.h() + 3 + h < sh * 0.8;
            y = below ? team.y() + team.h() + 3 : team.y() - h - 3;
            if (x + w > sw) x = sw - w - 2;
        } else {
            Rect r = HudLayout.resolve(cfg.placement(UiConfig.TEAM), w, h, sw, sh, List.of());
            x = r.x();
            y = r.y();
        }
        y = Math.max(0, Math.min(sh - h, y));
        var m = g.getMatrices();
        m.push();
        m.scale(scale, scale, 1);
        try {
            double f = now - flashAt < 1200 ? 1 - (now - flashAt) / 1200.0 : 0;
            int flashCol = flashDelta >= 0 ? 0xFF5BE37D : 0xFFFF6B6B;
            Gfx.panel(g, x, y, w, h, 0xFFC93C, cfg.panelOpacity, 1);
            if (f > 0) g.fill(x + 1, y + 1, x + w - 1, y + h - 1, UiMath.withAlpha(0x40000000 | (flashCol & 0xFFFFFF), f));
            com.hivecraft.overlay.screen.econ.EconGfx.coin(g, x + 6, y + 3, 1);
            g.drawText(tr, num, x + 17, y + 3, f > 0 ? UiMath.lerpColor(0xFFFFE9A8, flashCol, f) : 0xFFFFE9A8, true);
            if (!heldS.isEmpty()) g.drawText(tr, heldS, x + 17 + tr.getWidth(num), y + 3, Gfx.FAINT, false);
            boolean floating = !floaters.isEmpty();
            if (f > 0 && !floating) {
                String d = EconText.signed(flashDelta);
                Gfx.textA(g, tr, d, x + w + 3, y + 3 - (int) ((1 - f) * 5), flashCol, f);
            }
            if (floating) renderFloaters(g, tr, x, y, w, h, sh, now);
        } finally {
            m.pop();
        }
    }

    /** Earnings rising off the chip: "+6 mob", fading out; above the chip when it sits low, else below. */
    private static void renderFloaters(DrawContext g, TextRenderer tr, int x, int y, int w, int h, int sh, long now) {
        floaters.removeIf(fl -> now - fl.at() > FLOAT_MS);
        boolean up = y > sh / 3;
        for (Floater fl : floaters) {
            long age = now - fl.at();
            if (age < 0) continue;
            double t = age / (double) FLOAT_MS;
            double a = age < 160 ? age / 160.0 : t > 0.65 ? Math.max(0, 1 - (t - 0.65) / 0.35) : 1;
            int rise = (int) Math.round(UiMath.easeOutCubic(Math.min(1, t * 1.4)) * 16);
            int fy = up ? y - 10 - rise : y + h + 2 + rise;
            String amt = EconText.signed(fl.amount());
            String tag = fl.tag().isEmpty() ? "" : " " + fl.tag();
            int aw = tr.getWidth(amt), tw = tr.getWidth(tag);
            int fx = x + 4;
            // pop: slight scale-in on arrival
            double pop = age < 200 ? 1.0 + 0.25 * (1 - age / 200.0) : 1.0;
            var m = g.getMatrices();
            m.push();
            m.translate(fx, fy + 4, 300);
            m.scale((float) pop, (float) pop, 1);
            m.translate(-fx, -(fy + 4), 0);
            g.fill(fx - 2, fy - 1, fx + aw + tw + 2, fy + 9, UiMath.withAlpha(0xFF000000, 0.45 * a));
            Gfx.textA(g, tr, amt, fx, fy, fl.amount() > 0 ? 0xFF5BE37D : 0xFFFF6B6B, a);
            if (!tag.isEmpty()) Gfx.textA(g, tr, tag, fx + aw, fy, fl.color(), a);
            m.pop();
        }
    }

    // ------------------------------------------------------------------ ticker

    /** Economy notice → ticker line (network thread). */
    public static void onNotice(EconState.Notice n, Ticker ticker) {
        if (n == null) return;
        if (n.kind() == EconState.Notice.Kind.EARNED) floatEarning(n.coins(), EarnText.tag(n.other()), EarnText.color(n.other()));
        if (ticker == null || !UiConfig.get().tickerEcon) return;
        int accent = switch (n.kind()) {
            case EARNED -> EarnText.color(n.other());
            case BOUNTY_REFUND -> 0x5BE37D;
            case WORLD_FIRST -> 0xC792FF;
            case SOLD, RECEIVED, AUCTION_SOLD -> 0x5BE37D;
            case OUTBID -> 0xFFB13B;
            case WON, BOUGHT -> 0xFFC93C;
            case RESET -> 0x5CC8FF;
            default -> 0x9099A8;
        };
        String tag = switch (n.kind()) {
            case BOUGHT -> "▼ ";
            case SOLD, AUCTION_SOLD -> "▲ ";
            case RECEIVED, PAID -> "◉ ";
            case OUTBID -> "⚠ ";
            case WON -> "★ ";
            case DELIVERED -> "▣ ";
            case RESET -> "↻ ";
            case AUCTION_UNSOLD -> "⚖ ";
            case EARNED -> switch (n.other() == null ? "" : n.other()) {
                case "mob" -> "⚔ ";
                case "job" -> "⚒ ";
                case "bounty" -> "✎ ";
                case "milestone" -> "★ ";
                case "wage" -> "☀ ";
                default -> "+ ";
            };
            case BOUNTY_REFUND -> "↩ ";
            case WORLD_FIRST -> "★ ";
        };
        List<TermLine.Seg> segs = new ArrayList<>();
        segs.add(TermLine.seg(tag, 0xFF000000 | accent));
        segs.add(TermLine.seg(UiMath.ellipsize(n.text(), 60), n.kind() == EconState.Notice.Kind.OUTBID ? 0xFFFFD08A : 0xFFE6E9EF));
        if (n.coins() != 0) segs.add(TermLine.seg("  " + EconText.signed(n.coins()), n.coins() > 0 ? 0xFF5BE37D : 0xFFFF6B6B));
        String icon = n.item() != null && !n.item().isEmpty() ? n.item() : "gold_nugget";
        ticker.push(Ticker.Kind.EVENT, accent, icon, n.ts() > 0 ? n.ts() : System.currentTimeMillis(), segs);
    }

    /** True for the bridge's Market chat lines, which the economy ticker already covers. */
    public static boolean coversChat(String from) {
        return UiConfig.get().tickerEcon && from != null && from.equalsIgnoreCase("Market");
    }
}
