package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.EarnState;
import com.hivecraft.overlay.core.EarnText;
import com.hivecraft.overlay.core.EarnText.Row;
import com.hivecraft.overlay.core.Econ;
import com.hivecraft.overlay.core.EconState;
import com.hivecraft.overlay.core.EconText;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.J;
import com.hivecraft.overlay.core.TaskInfo;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.screen.tabs.Tab;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.widget.TextFieldWidget;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Jobs: ways to earn coins (MOD_PROTOCOL.md §5 "Earning coins"). Left: server jobs (deliver items at a premium) or
 * board bounties (post / raise / withdraw). Right: today's earnings + daily wage, mob bounty prices, milestones.
 */
public final class JobsView implements EconView {
    private static final int JOB_ROW = 32, BOUNTY_ROW = 23, FOOT = 36;
    private static boolean showBounties = false;

    private final NumField qty = new NumField("qty", 1, 640);
    private final NumField reward = new NumField("coins", 1, 1_000_000);
    private TextFieldWidget title;
    private String titleText = "";
    private final Act act = new Act();
    private int selJob = -1, selTask = -1;
    private int scroll, contentH, viewH, lx, ly, lw, lh;
    private int msScroll, msContentH, msViewH, mx0, my0, mw0, mh0;

    @Override public String title() { return "Jobs"; }
    @Override public String icon() { return "⚒"; }

    @Override
    public void open(EconHost h) {
        qty.open(h);
        reward.open(h);
        title = h.textField(-500, -500, 100, "bounty: what needs doing…");
        title.setMaxLength(120);
        title.setText(titleText);
    }

    @Override
    public void close(EconHost h) {
        qty.close(h);
        reward.close(h);
        if (title != null) { titleText = title.getText(); h.removeWidget(title); }
        title = null;
    }

    @Override
    public void hideFields() {
        qty.hide();
        reward.hide();
        hideTitle();
    }

    private void hideTitle() {
        if (title != null) { title.setX(-500); title.setY(-500); if (title.isFocused()) title.setFocused(false); }
    }

    @Override
    public boolean typing() { return qty.focused() || reward.focused() || (title != null && title.isFocused()); }

    // ------------------------------------------------------------------ actions

    private void deliver(EconHost h, EarnState.Job j) {
        if (j == null || !j.open()) { act.error(h, "that job is closed"); return; }
        int have = Inv.count(j.item());
        if (have <= 0) { act.error(h, "you have no " + EconGfx.name(j.item()) + " in your inventory"); return; }
        int n = (int) Math.min(qty.valueOr(EarnText.deliverable(j, have)), EarnText.deliverable(j, have));
        if (n <= 0) { act.error(h, "type how many to deliver"); return; }
        long est = j.payFor(n);
        act.run(h, "delivering " + n + " " + EconGfx.name(j.item()) + "…", Econ.get().deliver(j.id(), n),
                r -> "delivered " + J.integer(r.body(), "count", n) + " " + EconGfx.name(j.item()) + " · +" + EconText.coins(J.lng(r.body(), "earned", est)),
                r -> qty.clear());
    }

    private void raise(EconHost h, Row row) {
        EconState es = EconPanel.es();
        Long v = reward.value();
        if (v == null || v <= 0) { act.error(h, "type how many coins to add"); return; }
        if (v > es.balance()) { act.error(h, "not enough coins: have " + EconText.coins(es.balance()) + ", need " + EconText.coins(v)); return; }
        long before = row.reward();
        act.run(h, "adding " + EconText.coins(v) + " to #" + row.task() + "…", Econ.get().bounty(row.task(), v),
                r -> {
                    long total = J.lng(J.obj(r.body(), "bounty"), "total", before + v);
                    return "#" + row.task() + " now pays " + EconText.coins(total) + " coins";
                }, r -> reward.clear());
    }

    private void withdraw(EconHost h, Row row) {
        act.run(h, "taking back your coins from #" + row.task() + "…", Econ.get().cancelBounty(row.task()),
                r -> "got back " + EconText.coins(J.lng(r.body(), "refunded", row.myShare())) + " coins", null);
    }

    private void post(EconHost h) {
        EconState es = EconPanel.es();
        String t = title == null ? "" : title.getText().strip();
        if (t.isEmpty()) { act.error(h, "type what the task is"); return; }
        Long v = reward.value();
        if (v == null || v <= 0) { act.error(h, "type a reward (whole coins)"); return; }
        if (v > es.balance()) { act.error(h, "not enough coins: have " + EconText.coins(es.balance()) + ", need " + EconText.coins(v)); return; }
        act.run(h, "posting bounty…", Econ.get().postTask(t, v),
                r -> "posted #" + J.integer(r.body(), "id", 0) + " · reward " + EconText.coins(v),
                r -> {
                    if (title != null) title.setText("");
                    reward.clear();
                    int id = J.integer(r.body(), "id", -1);
                    if (id >= 0) selTask = id;
                });
    }

    // ------------------------------------------------------------------ data

    private static List<Row> rows(List<TaskInfo> board, List<EarnState.Bounty> bounties, String me) { return EarnText.rows(board, bounties, me); }

    private static boolean canWithdraw(Row r, String me) { return EarnText.canWithdraw(r, me); }

    // ------------------------------------------------------------------ render

    @Override
    public void render(EconHost h, Ui ui, ControlScreen.Area a, long now) {
        DrawContext g = ui.g;
        TextRenderer tr = ui.tr;
        EconState es = EconPanel.es();
        EarnState ea = es.earn();
        if (!ea.available()) {
            hideFields();
            int cx = a.x() + a.w() / 2, cy = a.y() + a.h() / 2;
            Gfx.item(g, "iron_pickaxe", cx - 12, cy - 40, 24);
            g.drawCenteredTextWithShadow(tr, "No jobs or bounties from this bridge", cx, cy - 8, Gfx.TEXT);
            g.drawCenteredTextWithShadow(tr, Gfx.fit(tr, "Earning coins needs a newer Hivecraft bridge (MOD_PROTOCOL §5 Earning coins).", a.w() - 20), cx, cy + 4, Gfx.MUTED);
            ui.button(cx - 30, cy + 18, 60, 14, "↻ Retry", Gfx.GOLD, true, () -> Econ.get().refresh(), null);
            return;
        }
        int rw = Math.max(170, Math.min(250, (int) (a.w() * 0.38)));
        int lwid = a.w() - rw - 6;
        renderLeft(h, ui, g, tr, es, ea, a.x(), a.y(), lwid, a.h(), now);
        renderRight(ui, g, tr, es, ea, a.right() - rw, a.y(), rw, a.h(), now);
    }

    private void renderLeft(EconHost h, Ui ui, DrawContext g, TextRenderer tr, EconState es, EarnState ea, int x, int y, int w, int hh, long now) {
        // ---- sub-tabs
        int openJobs = 0;
        for (EarnState.Job j : ea.jobs()) if (j.open()) openJobs++;
        List<Row> rows = rows(Hive.state().board(), ea.bounties(), es.me());
        int openB = 0;
        for (Row r : rows) if (r.rewardOpen()) openB++;
        int cx = x;
        cx += ui.chip(cx, y + 1, "⚒ Server jobs " + openJobs, Gfx.INFO, !showBounties, () -> { if (showBounties) { showBounties = false; scroll = 0; EconGfx.soundClick(); } }) + 2;
        ui.chip(cx, y + 1, "✎ Bounties " + openB, Gfx.GOLD, showBounties, () -> { if (!showBounties) { showBounties = true; scroll = 0; EconGfx.soundClick(); } });
        String info;
        if (!showBounties) {
            long nr = ea.nextRotation();
            info = nr > 0 ? "new jobs in " + EconText.countdown(nr - (now + Hive.state().serverTimeOffset())) : "";
        } else {
            info = "the claimer is paid when it's done";
        }
        if (!info.isEmpty()) g.drawText(tr, info, x + w - tr.getWidth(info), y + 3, Gfx.FAINT, false);

        // ---- list
        lx = x; ly = y + 16; lw = w; lh = hh - 16 - FOOT - 4;
        g.fill(lx, ly, lx + lw, ly + lh, 0x50080B10);
        if (!showBounties) renderJobs(ui, g, tr, es, ea, now);
        else renderBounties(ui, g, tr, es, rows, now);

        // ---- footer action bar
        int fy = ly + lh + 4;
        EconGfx.card(g, x, fy, w, FOOT);
        if (!showBounties) jobFooter(h, ui, g, tr, ea, x, fy, w, now);
        else bountyFooter(h, ui, g, tr, es, rows, x, fy, w, now);
    }

    private void scrollbar(DrawContext g) {
        if (contentH > viewH) {
            int bh = Math.max(10, viewH * viewH / contentH);
            int by = ly + 2 + (viewH - bh) * scroll / Math.max(1, contentH - viewH);
            g.fill(lx + lw - 3, by, lx + lw - 1, by + bh, 0x80FFFFFF);
        }
    }

    private void renderJobs(Ui ui, DrawContext g, TextRenderer tr, EconState es, EarnState ea, long now) {
        List<EarnState.Job> jobs = ea.jobs();
        viewH = lh - 4;
        contentH = jobs.size() * (JOB_ROW + 2);
        scroll = Tab.clampScroll(scroll, contentH, viewH);
        if (selJob >= 0 && ea.job(selJob) == null) selJob = -1;
        g.enableScissor(lx + 1, ly + 1, lx + lw - 1, ly + lh - 1);
        int y = ly + 2 - scroll;
        long serverNow = now + Hive.state().serverTimeOffset();
        for (EarnState.Job j : jobs) {
            if (y + JOB_ROW >= ly && y <= ly + lh) {
                int rx = lx + 2, rw = lw - 4;
                boolean sel = j.id() == selJob;
                boolean hv = ui.hover(rx, y, rw, JOB_ROW) && ui.hover(lx, ly, lw, lh);
                boolean open = j.open();
                g.fill(rx, y, rx + rw, y + JOB_ROW, sel ? EconGfx.ROW_SEL : hv ? EconGfx.ROW_HOVER : EconGfx.ROW);
                if (sel) g.drawBorder(rx, y, rw, JOB_ROW, Gfx.INFO);
                g.fill(rx, y, rx + 2, y + JOB_ROW, open ? Gfx.INFO : 0xFF3A4252);
                EconGfx.slot(g, rx + 5, y + 7, 18, false, false);
                EconGfx.item(g, tr, j.item(), rx + 6, y + 8, 1);
                int have = Inv.count(j.item());
                int tx = rx + 28;
                // line 1: wanted item + pay
                String name = j.count() + " " + EconGfx.name(j.item());
                String price = EconText.coins(j.pay()) + " each";
                int pw = tr.getWidth(price);
                Integer pct = j.premiumPct();
                String prem = pct != null ? "+" + pct + "%" : "";
                int premW = prem.isEmpty() ? 0 : tr.getWidth(prem) + 6;
                int right = rx + rw - 6;
                g.drawText(tr, Gfx.fit(tr, name, right - tx - pw - premW - 20), tx, y + 4, open ? 0xFFFFFFFF : Gfx.MUTED, false);
                g.drawText(tr, price, right - pw, y + 4, open ? 0xFFFFE9A8 : Gfx.FAINT, true);
                EconGfx.coin(g, right - pw - 10, y + 4, 1);
                if (!prem.isEmpty()) {
                    int px = right - pw - 12 - premW;
                    g.fill(px, y + 3, px + premW - 2, y + 12, open ? 0x6033A852 : 0x40303846);
                    g.drawText(tr, prem, px + 2, y + 4, open ? 0xFF8CF5A6 : Gfx.FAINT, false);
                }
                // line 2: progress
                int barW = Math.max(30, Math.min(110, rw / 3));
                Gfx.bar(g, tx, y + 16, barW, 5, j.progress(), open ? Gfx.INFO : 0xFF4A5262, 0, 1);
                String left = switch (j.status()) {
                    case "filled" -> "filled";
                    case "expired" -> "expired";
                    default -> j.left() + " left of " + j.count();
                };
                g.drawText(tr, left, tx + barW + 4, y + 15, open ? Gfx.TEXT : Gfx.FAINT, false);
                // line 3: shop price · yours · expiry
                String shop = j.shopSell() != null ? "shop pays " + j.shopSell() : "shop doesn't buy it";
                int mine = j.deliveredBy(es.me());
                String exp = open && j.expiresAt() > 0 ? " · " + EconText.countdown(j.expiresAt() - serverNow) : "";
                g.drawText(tr, Gfx.fit(tr, shop + (mine > 0 ? " · you gave " + mine : "") + exp, rw - 28 - 70), tx, y + 23, Gfx.FAINT, false);
                String hs = "you have " + have;
                g.drawText(tr, hs, right - tr.getWidth(hs), y + 18, have > 0 && open ? 0xFF7FE08F : Gfx.FAINT, false);
                if (y >= ly && y + JOB_ROW <= ly + lh) {
                    String tip = "job #" + j.id() + " · " + j.done() + "/" + j.count() + " delivered" + (open ? " · deliver " + EarnText.deliverable(j, have) + " = +" + EconText.coins(j.payFor(EarnText.deliverable(j, have))) : "");
                    ui.region(rx, y, rw, JOB_ROW, () -> {
                        selJob = j.id();
                        int d = EarnText.deliverable(j, Inv.count(j.item()));
                        if (d > 0) qty.set(d);
                        EconGfx.soundClick();
                    }, tip);
                }
            }
            y += JOB_ROW + 2;
        }
        g.disableScissor();
        if (jobs.isEmpty()) {
            g.drawCenteredTextWithShadow(tr, "No server jobs right now", lx + lw / 2, ly + lh / 2 - 8, Gfx.TEXT);
            g.drawCenteredTextWithShadow(tr, "the server posts new ones every Minecraft day", lx + lw / 2, ly + lh / 2 + 4, Gfx.FAINT);
        }
        scrollbar(g);
    }

    private void jobFooter(EconHost h, Ui ui, DrawContext g, TextRenderer tr, EarnState ea, int x, int y, int w, long now) {
        reward.hide();
        hideTitle();
        EarnState.Job j = selJob >= 0 ? ea.job(selJob) : null;
        if (j == null) {
            qty.hide();
            int pct = ea.rates().jobPremiumPct();
            g.drawText(tr, "Pick a job", x + 6, y + 5, Gfx.TEXT, false);
            g.drawText(tr, Gfx.fit(tr, "deliver items from your inventory" + (pct > 0 ? " for +" + pct + "% over the shop price" : " at a premium"), w - 12), x + 6, y + 16, Gfx.MUTED, false);
            if (!act.active(now)) return;
            act.render(ui, x + 6, y + 26, w - 12, now);
            return;
        }
        int have = Inv.count(j.item());
        int max = EarnText.deliverable(j, have);
        EconGfx.item(g, tr, j.item(), x + 5, y + 3, 1);
        g.drawText(tr, Gfx.fit(tr, "Job #" + j.id(), 60), x + 24, y + 7, Gfx.INFO, false);
        int fx = x + 24 + Math.min(60, tr.getWidth("Job #" + j.id())) + 6;
        qty.setMax(Math.max(1, Math.min(640, j.left())));
        qty.render(ui, fx, y + 4, 70, true, 1);
        fx += 74;
        String mx = "Max " + max;
        int mw = tr.getWidth(mx) + 6;
        ui.button(fx, y + 5, mw, 12, mx, Gfx.INFO, max > 0, () -> qty.set(max), max > 0 ? "everything you can deliver" : null);
        fx += mw + 4;
        int n = (int) Math.min(qty.valueOr(max), max);
        boolean can = j.open() && max > 0 && qty.valid() && !act.busy();
        String bl = act.busy() ? "…" : !j.open() ? "Closed" : "Deliver +" + EconText.coinsShort(j.payFor(n));
        int bw = Math.max(70, tr.getWidth(bl) + 12);
        int bx = x + w - 6 - bw;
        ui.button(bx, y + 4, bw, 15, bl, Gfx.GOOD, can, () -> deliver(h, j), "deliver " + n + " " + EconGfx.name(j.item()) + " from your inventory");
        if (!can && !act.busy())
            ui.region(bx, y + 4, bw, 15, null, !j.open() ? "this job is " + j.status() : have <= 0 ? "you have no " + EconGfx.name(j.item()) : "type a quantity");
        if (act.active(now)) act.render(ui, x + 6, y + 24, w - 12, now);
        else {
            String s = "you have " + have + " · " + j.left() + " still wanted · " + EconText.coins(j.pay()) + " coins each";
            g.drawText(tr, Gfx.fit(tr, s, w - 12), x + 6, y + 24, Gfx.FAINT, false);
        }
    }

    private void renderBounties(Ui ui, DrawContext g, TextRenderer tr, EconState es, List<Row> rows, long now) {
        viewH = lh - 4;
        contentH = rows.size() * (BOUNTY_ROW + 2);
        scroll = Tab.clampScroll(scroll, contentH, viewH);
        if (selTask >= 0) {
            boolean found = false;
            for (Row r : rows) if (r.task() == selTask) { found = true; break; }
            if (!found && !act.busy()) selTask = -1;
        }
        g.enableScissor(lx + 1, ly + 1, lx + lw - 1, ly + lh - 1);
        int y = ly + 2 - scroll;
        for (Row r : rows) {
            if (y + BOUNTY_ROW >= ly && y <= ly + lh) {
                int rx = lx + 2, rw = lw - 4;
                boolean sel = r.task() == selTask;
                boolean hv = ui.hover(rx, y, rw, BOUNTY_ROW) && ui.hover(lx, ly, lw, lh);
                boolean live = r.open();
                g.fill(rx, y, rx + rw, y + BOUNTY_ROW, sel ? EconGfx.ROW_SEL : hv ? EconGfx.ROW_HOVER : EconGfx.ROW);
                if (sel) g.drawBorder(rx, y, rw, BOUNTY_ROW, Gfx.GOLD);
                int stripe = r.rewardOpen() ? EconGfx.COIN : !live ? 0xFF3A4252 : 0xFF5D6574;
                g.fill(rx, y, rx + 2, y + BOUNTY_ROW, stripe);
                int right = rx + rw - 6;
                String rs = r.reward() > 0 ? EconText.coins(r.reward()) : "no reward";
                int rsw = tr.getWidth(rs);
                if (r.reward() > 0) {
                    g.drawText(tr, rs, right - rsw, y + 3, r.rewardOpen() ? 0xFFFFE9A8 : Gfx.FAINT, true);
                    EconGfx.coin(g, right - rsw - 10, y + 3, 1);
                    rsw += 10;
                } else g.drawText(tr, rs, right - rsw, y + 3, Gfx.FAINT, false);
                g.drawText(tr, Gfx.fit(tr, r.title(), rw - 14 - rsw - 8), rx + 7, y + 3, live ? Gfx.TEXT : Gfx.MUTED, false);
                StringBuilder sb = new StringBuilder("#").append(r.task());
                if (r.by() != null && !r.by().isBlank()) sb.append(" · by ").append(EconGfx.display(r.by()));
                sb.append(" · ").append(r.status());
                if (r.funders() > 1) sb.append(" · ").append(r.funders()).append(" funders");
                String line2 = sb.toString();
                int stCol = r.status().startsWith("paid") ? EconGfx.MONEY_IN : r.status().startsWith("claimed") ? Gfx.INFO : r.status().startsWith("blocked") ? Gfx.WARN : Gfx.FAINT;
                g.drawText(tr, Gfx.fit(tr, line2, rw - 14 - 70), rx + 7, y + 13, stCol, false);
                if (r.myShare() > 0) {
                    String ms = "you put " + EconText.coinsShort(r.myShare());
                    g.drawText(tr, ms, right - tr.getWidth(ms), y + 13, 0xFFFFFF55, false);
                }
                if (y >= ly && y + BOUNTY_ROW <= ly + lh) {
                    String tip = r.t() != null && r.t().detail() != null && !r.t().detail().isBlank() ? UiMath.ellipsize(r.t().detail(), 80)
                            : r.rewardOpen() ? "click to add coins" : live ? "click to put a reward on it" : null;
                    ui.region(rx, y, rw, BOUNTY_ROW, () -> { selTask = r.task(); EconGfx.soundClick(); }, tip);
                }
            }
            y += BOUNTY_ROW + 2;
        }
        g.disableScissor();
        if (rows.isEmpty()) {
            g.drawCenteredTextWithShadow(tr, "The board is empty", lx + lw / 2, ly + lh / 2 - 8, Gfx.TEXT);
            g.drawCenteredTextWithShadow(tr, "post a bounty below: a task with a coin reward", lx + lw / 2, ly + lh / 2 + 4, Gfx.FAINT);
        }
        scrollbar(g);
    }

    private void bountyFooter(EconHost h, Ui ui, DrawContext g, TextRenderer tr, EconState es, List<Row> rows, int x, int y, int w, long now) {
        qty.hide();
        Row sel = null;
        for (Row r : rows) if (r.task() == selTask) { sel = r; break; }
        int fy = y + 4;
        if (sel == null) {
            // post a new bounty: title + reward + Post
            g.drawText(tr, "Post", x + 6, fy + 3, EconGfx.COIN, true);
            int fx = x + 6 + tr.getWidth("Post") + 6;
            int bw = 46, aw = 76;
            int tw = w - (fx - x) - aw - bw - 16;
            if (title != null) { title.setX(fx); title.setY(fy); title.setWidth(Math.max(40, tw)); }
            reward.render(ui, fx + tw + 4, fy, aw, false, 1);
            boolean can = title != null && !title.getText().isBlank() && reward.valid() && reward.valueOr(0) <= es.balance() && !act.busy();
            int bx = x + w - 6 - bw;
            ui.button(bx, fy, bw, 15, act.busy() ? "…" : "Post", EconGfx.COIN, can, () -> post(h), "post this task on the board with the reward (coins are held until it's done)");
            if (!can && !act.busy()) ui.region(bx, fy, bw, 15, null,
                    title == null || title.getText().isBlank() ? "type what needs doing" : !reward.valid() ? "type a reward" : "not enough coins");
            if (act.active(now)) act.render(ui, x + 6, y + 24, w - 12, now);
            else g.drawText(tr, Gfx.fit(tr, "or pick a task above to add coins to it", w - 12), x + 6, y + 24, Gfx.FAINT, false);
            return;
        }
        hideTitle();
        Row r = sel;
        boolean live = r.open();
        g.drawText(tr, "#" + r.task(), x + 6, fy + 3, EconGfx.COIN, true);
        int fx = x + 6 + tr.getWidth("#" + r.task()) + 6;
        if (live) {
            reward.render(ui, fx, fy, 76, true, 5);
            fx += 80;
            for (long q : new long[]{10, 25, 50}) {
                String l = "+" + q;
                int qw = tr.getWidth(l) + 6;
                if (fx + qw > x + w - 150) break;
                ui.button(fx, fy + 1, qw, 12, l, Gfx.INFO, true, () -> reward.set(reward.valueOr(0) + q), null);
                fx += qw + 2;
            }
        } else {
            reward.hide();
            g.drawText(tr, "this task is " + r.status(), fx, fy + 3, Gfx.MUTED, false);
        }
        int bx = x + w - 6;
        int cw = 14;
        bx -= cw;
        ui.button(bx, fy, cw, 15, "✕", Gfx.MUTED, true, () -> { selTask = -1; EconGfx.soundClick(); }, "back to posting a new bounty");
        if (canWithdraw(r, es.me())) {
            String wl = "Withdraw " + EconText.coinsShort(r.myShare());
            int ww = tr.getWidth(wl) + 10;
            bx -= ww + 3;
            ui.button(bx, fy, ww, 15, wl, Gfx.WARN, !act.busy(), () -> withdraw(h, r), "take back your " + EconText.coins(r.myShare()) + " coins");
        }
        if (live) {
            long v = reward.valueOr(0);
            String al = act.busy() ? "…" : r.reward() > 0 ? "Raise → " + EconText.coinsShort(r.reward() + v) : "Add reward";
            int aw = Math.max(58, tr.getWidth(al) + 10);
            bx -= aw + 3;
            boolean can = reward.valid() && v <= es.balance() && !act.busy();
            ui.button(bx, fy, aw, 15, al, EconGfx.COIN, can, () -> raise(h, r), "put " + EconText.coins(v) + " more coins on #" + r.task());
            if (!can && !act.busy()) ui.region(bx, fy, aw, 15, null, !reward.valid() ? "type how many coins" : "not enough coins");
        }
        if (act.active(now)) act.render(ui, x + 6, y + 24, w - 12, now);
        else g.drawText(tr, Gfx.fit(tr, r.title(), w - 12), x + 6, y + 24, Gfx.FAINT, false);
    }

    // ------------------------------------------------------------------ right column

    private void renderRight(Ui ui, DrawContext g, TextRenderer tr, EconState es, EarnState ea, int x, int y, int w, int hh, long now) {
        int bottom = y + hh;
        // ---- today + wage
        int ch = 52;
        EconGfx.card(g, x, y, w, ch);
        g.fillGradient(x + 1, y + 1, x + w - 1, y + ch - 1, 0x2833A852, 0x0033A852);
        g.drawText(tr, "EARNED TODAY", x + 6, y + 5, Gfx.FAINT, false);
        long today = ea.today(now);
        String ts = "+" + EconText.coins(today);
        EconGfx.big(g, tr, ts, x + 6, y + 15, 1.5f, today > 0 ? EconGfx.MONEY_IN : Gfx.MUTED);
        String tot = "world total " + EconText.coinsShort(ea.total());
        g.drawText(tr, tot, x + w - 6 - tr.getWidth(tot), y + 5, Gfx.FAINT, false);
        // per-source totals
        int sx = x + 6, sy = y + 30;
        for (String src : EarnState.SOURCES) {
            long v = ea.totals().getOrDefault(src, 0L);
            String icon = EarnText.icon(src, null, null);
            if ("mob".equals(src)) icon = "iron_sword";
            if ("job".equals(src)) icon = "chest";
            String l = EconText.coinsShort(v);
            int cw = 12 + tr.getWidth(l) + 4;
            if (sx + cw > x + w - 4) break;
            Gfx.item(g, icon, sx, sy, 10);
            g.drawText(tr, l, sx + 12, sy + 1, v > 0 ? 0xFFFFE9A8 : Gfx.FAINT, false);
            ui.region(sx, sy - 1, cw, 11, null, EarnText.label(src) + ": " + EconText.coins(v) + " coins this world");
            sx += cw + 2;
        }
        // wage line
        long wage = ea.rates().wage();
        long ns = ea.nextSunrise(now);
        long msLeft = ns > 0 ? ns - now : clientSunrise();
        String wl;
        if (wage <= 0) wl = "☀ no daily wage this world";
        else wl = "☀ wage " + EconText.coins(wage) + " at sunrise" + (msLeft > 0 ? " · in " + EconText.countdown(msLeft) : "");
        g.drawText(tr, Gfx.fit(tr, wl, w - 12), x + 6, y + 41, wage > 0 ? 0xFFFFE27A : Gfx.FAINT, false);
        if (wage > 0) ui.region(x + 4, y + 40, w - 8, 10, null, "paid to everyone online when a new Minecraft day starts");
        y += ch + 4;

        // ---- mob bounties
        Map<String, Integer> mobs = ea.rates().mobs();
        int cols = Math.max(1, (w - 8) / 76);
        int cellW = (w - 8) / cols;
        int mobRows = Math.min(4, (mobs.size() + cols - 1) / cols);
        int mh = 18 + Math.max(1, mobRows) * 12 + 2;
        EconGfx.card(g, x, y, w, mh);
        int cap = ea.rates().mobCapPerMinute();
        EconGfx.title(g, tr, "Mob bounties", x + 6, y + 4, w - 12, 0xFFFF7A7A);
        if (cap > 0) { String c = "cap " + cap + "/min"; g.drawText(tr, c, x + w - 6 - tr.getWidth(c), y + 4, Gfx.FAINT, false); }
        int i = 0, shownMobs = cols * mobRows;
        for (var e : mobs.entrySet()) {
            if (i >= shownMobs) break;
            int cx = x + 4 + (i % cols) * cellW, cy = y + 17 + (i / cols) * 12;
            boolean last = i == shownMobs - 1 && mobs.size() > shownMobs;
            if (last) {
                int more = mobs.size() - shownMobs + 1;
                StringBuilder sb = new StringBuilder();
                int k = 0;
                for (var e2 : mobs.entrySet()) { if (k++ >= shownMobs - 1) sb.append(sb.length() > 0 ? ", " : "").append(EconText.pretty(e2.getKey())).append(' ').append(e2.getValue()); }
                g.drawText(tr, "+" + more + " more", cx + 2, cy + 1, Gfx.MUTED, false);
                ui.region(cx, cy, cellW, 11, null, UiMath.ellipsize(sb.toString(), 90));
            } else {
                Gfx.item(g, EarnText.mobIcon(e.getKey()), cx, cy, 10);
                String v = String.valueOf(e.getValue());
                g.drawText(tr, Gfx.fit(tr, EconText.pretty(e.getKey()), cellW - 22 - tr.getWidth(v)), cx + 12, cy + 1, Gfx.TEXT, false);
                g.drawText(tr, v, cx + cellW - 4 - tr.getWidth(v), cy + 1, 0xFFFFE9A8, false);
                ui.region(cx, cy, cellW, 11, null, EconText.pretty(e.getKey()) + ": " + e.getValue() + " coins per kill");
            }
            i++;
        }
        if (mobs.isEmpty()) g.drawText(tr, "no mob bounties this world", x + 6, y + 18, Gfx.FAINT, false);
        y += mh + 4;

        // ---- milestones (rest, scrollable)
        int msh = bottom - y;
        if (msh < 28) return;
        EconGfx.card(g, x, y, w, msh);
        List<EarnState.Milestone> ms = ea.milestones();
        int done = 0;
        for (EarnState.Milestone m : ms) if (m.done()) done++;
        EconGfx.title(g, tr, "Milestones", x + 6, y + 4, w - 12, 0xFFC792FF);
        String dc = done + "/" + ms.size();
        g.drawText(tr, dc, x + w - 6 - tr.getWidth(dc), y + 4, Gfx.FAINT, false);
        mx0 = x; my0 = y + 16; mw0 = w; mh0 = msh - 17;
        msViewH = mh0;
        msContentH = ms.size() * 13;
        msScroll = Tab.clampScroll(msScroll, msContentH, msViewH);
        g.enableScissor(x + 1, my0, x + w - 1, y + msh - 1);
        int ry = my0 + 1 - msScroll;
        for (EarnState.Milestone m : ms) {
            if (ry + 13 >= my0 && ry <= y + msh) {
                boolean hv = ui.hover(x + 3, ry, w - 6, 12) && ui.hover(mx0, my0, mw0, mh0);
                if (hv) g.fill(x + 3, ry, x + w - 3, ry + 12, 0x30FFFFFF);
                Gfx.item(g, EarnText.milestoneIcon(m.id()), x + 6, ry + 1, 10);
                String mark = m.done() ? "✔" : "○";
                g.drawText(tr, mark, x + 18, ry + 2, m.done() ? Gfx.GOOD : Gfx.FAINT, false);
                String rv = "+" + EconText.coins(m.reward());
                boolean firstOpen = m.first() > 0 && m.firstBy() == null && !m.done();
                String fs = firstOpen ? " ★+" + EconText.coinsShort(m.first()) : m.worldFirst() ? " ★" : "";
                int rvw = tr.getWidth(rv) + tr.getWidth(fs);
                g.drawText(tr, Gfx.fit(tr, EarnText.cap(m.label()), w - 34 - rvw - 6), x + 28, ry + 2, m.done() ? Gfx.MUTED : Gfx.TEXT, false);
                int vx = x + w - 6 - rvw;
                g.drawText(tr, rv, vx, ry + 2, m.done() ? Gfx.FAINT : 0xFFFFE9A8, false);
                if (!fs.isEmpty()) g.drawText(tr, fs, vx + tr.getWidth(rv), ry + 2, 0xFFC792FF, false);
                if (ry >= my0 && ry + 12 <= y + msh) {
                    String tip;
                    if (m.done()) tip = "done" + (m.worldFirst() ? " · world first!" : "") + (m.ts() > 0 ? " · " + UiMath.formatAge(Math.max(0, now + Hive.state().serverTimeOffset() - m.ts())) + " ago" : "");
                    else if (m.firstBy() != null) tip = "world first went to " + m.firstBy() + " · still pays " + EconText.coins(m.reward());
                    else tip = m.first() > 0 ? "first in the world gets +" + EconText.coins(m.first()) + " extra" : "one-time bonus";
                    ui.region(x + 3, ry, w - 6, 12, null, tip);
                }
            }
            ry += 13;
        }
        g.disableScissor();
        if (ms.isEmpty()) g.drawText(tr, "no milestones this world", x + 6, y + 19, Gfx.FAINT, false);
        if (msContentH > msViewH) {
            int bh = Math.max(8, msViewH * msViewH / msContentH);
            int by = my0 + (msViewH - bh) * msScroll / Math.max(1, msContentH - msViewH);
            g.fill(x + w - 3, by, x + w - 1, by + bh, 0x80FFFFFF);
        }
    }

    /** ms until the next sunrise from the client's world clock (0 when not in a world). */
    private static long clientSunrise() {
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc.world == null) return 0;
        return EarnText.msToSunrise(mc.world.getTimeOfDay());
    }

    // ------------------------------------------------------------------ input

    @Override
    public boolean scrolled(double mx, double my, double v) {
        if (mx >= lx && mx < lx + lw && my >= ly && my < ly + lh) {
            scroll = Tab.clampScroll(scroll - (int) (v * (showBounties ? BOUNTY_ROW + 2 : JOB_ROW + 2)), contentH, viewH);
            return true;
        }
        if (mx >= mx0 && mx < mx0 + mw0 && my >= my0 && my < my0 + mh0) {
            msScroll = Tab.clampScroll(msScroll - (int) (v * 13), msContentH, msViewH);
            return true;
        }
        return false;
    }

    @Override
    public boolean key(EconHost h, int key, int scan, int mods) {
        if (key != GLFW.GLFW_KEY_ENTER && key != GLFW.GLFW_KEY_KP_ENTER) return false;
        if (!showBounties && qty.focused()) {
            EarnState.Job j = selJob >= 0 ? EconPanel.es().earn().job(selJob) : null;
            if (j != null) deliver(h, j);
            return true;
        }
        if (showBounties && (reward.focused() || (title != null && title.isFocused()))) {
            Row sel = null;
            EconState es = EconPanel.es();
            for (Row r : rows(Hive.state().board(), es.earn().bounties(), es.me())) if (r.task() == selTask) { sel = r; break; }
            if (sel != null && sel.open()) raise(h, sel);
            else if (sel == null) post(h);
            return true;
        }
        return false;
    }
}
