package com.hivecraft.overlay.screen.tabs;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.TaskInfo;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.text.OrderedText;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayList;
import java.util.List;

/** Task board as kanban columns (open · claimed · blocked · done) + add-task field. */
public final class BoardTab implements Tab {
    private static final String[] COLS = {"open", "claimed", "blocked", "done"};
    private static final int[] COL_COLORS = {0xFFFFC24A, 0xFF5CC8FF, 0xFFFFB13B, 0xFF4CE06A};
    private final int[] scroll = new int[4];
    private final int[] contentH = new int[4];
    private int colTop, colH, colW, colX0, gap = 6;
    private TextFieldWidget field;
    private ControlScreen screen;

    @Override public String title() { return "Board"; }
    @Override public String icon() { return "☰"; }

    @Override
    public void open(ControlScreen s, ControlScreen.Area a) {
        screen = s;
        field = s.textField(a.x(), a.bottom() - 14, a.w() - 74, "new task for the team… (end with $50 to add a coin reward)");
    }

    @Override
    public void close() {
        if (field != null && screen != null) screen.removeWidget(field);
        field = null;
    }

    private void submit() {
        if (field == null) return;
        String t = field.getText().strip();
        if (t.isEmpty()) return;
        screen.command("board add " + t);
        field.setText("");
    }

    @Override
    public void render(ControlScreen s, Ui ui, ControlScreen.Area a, long now, float delta) {
        DrawContext g = ui.g;
        var tr = ui.tr;
        List<TaskInfo> all = Hive.state().board();
        colTop = a.y();
        colH = a.h() - 20;
        colW = (a.w() - gap * 3) / 4;
        colX0 = a.x();
        for (int c = 0; c < 4; c++) {
            int x = a.x() + c * (colW + gap);
            List<TaskInfo> list = new ArrayList<>();
            for (TaskInfo t : all) if (COLS[c].equals(t.status())) list.add(t);
            // header
            g.fill(x, colTop, x + colW, colTop + 14, 0xFF161C27);
            g.fill(x, colTop + 13, x + colW, colTop + 14, COL_COLORS[c]);
            Gfx.text(g, tr, COLS[c].toUpperCase(), x + 5, colTop + 3, COL_COLORS[c]);
            String n = String.valueOf(list.size());
            Gfx.text(g, tr, n, x + colW - 5 - tr.getWidth(n), colTop + 3, Gfx.FAINT);
            g.fill(x, colTop + 14, x + colW, colTop + colH, 0x60101520);

            int y0 = colTop + 17;
            int viewH = colH - 17;
            int y = y0 - scroll[c];
            g.enableScissor(x, y0, x + colW, colTop + colH);
            int start = y;
            for (TaskInfo t : list) {
                int h = card(s, ui, t, x + 3, y, colW - 6, COL_COLORS[c], now, y >= y0 - 60 && y < colTop + colH);
                y += h + 4;
            }
            g.disableScissor();
            contentH[c] = y - start;
            scroll[c] = Tab.clampScroll(scroll[c], contentH[c], viewH);
            if (list.isEmpty()) Gfx.text(g, tr, "—", x + colW / 2 - 3, y0 + 6, Gfx.FAINT);
        }
        // add-task row
        if (field != null) {
            field.setX(a.x());
            field.setY(a.bottom() - 14);
            field.setWidth(a.w() - 74);
        }
        ui.button(a.right() - 70, a.bottom() - 14, 70, 14, "+ Add task", Gfx.GOLD, true, this::submit, "board add <text> (as you)");
    }

    /** Draws one task card, returns its height. */
    private int card(ControlScreen s, Ui ui, TaskInfo t, int x, int y, int w, int colColor, long now, boolean visible) {
        var tr = ui.tr;
        List<OrderedText> lines = tr.wrapLines(Text.literal(t.title()), w - 10);
        int shown = Math.min(3, lines.size());
        int h = 8 + shown * 9 + 11;
        if (!visible) return h;
        DrawContext g = ui.g;
        boolean hv = ui.hover(x, y, w, h);
        g.fill(x, y, x + w, y + h, hv ? 0xE0222A38 : 0xD01A202B);
        g.fill(x, y, x + 2, y + h, colColor);
        int ty = y + 4;
        for (int i = 0; i < shown; i++) {
            g.drawText(tr, lines.get(i), x + 6, ty, "done".equals(t.status()) ? Gfx.MUTED : Gfx.TEXT, false);
            ty += 9;
        }
        // footer: #id · owner · priority
        int fy = y + h - 10;
        Gfx.text(g, tr, "#" + t.id(), x + 6, fy, Gfx.FAINT);
        int fx = x + 10 + tr.getWidth("#" + t.id());
        if (t.owner() != null && !t.owner().isBlank()) {
            BotState b = Hive.state().bot(t.owner());
            int oc = b != null ? 0xFF000000 | b.color() : Gfx.MUTED;
            Gfx.text(g, tr, t.owner(), fx, fy, oc);
            fx += tr.getWidth(t.owner()) + 4;
        }
        if (t.priority() > 0) { Gfx.text(g, tr, "!".repeat(Math.min(3, t.priority())), fx, fy, Gfx.WARN); fx += tr.getWidth("!!!") + 2; }
        // bounty: coin reward on the right of the footer (paid / refunded greyed)
        boolean rewardHover = false;
        if (t.hasReward()) {
            boolean paid = "paid".equals(t.rewardStatus()), refunded = "refunded".equals(t.rewardStatus());
            String rs = com.hivecraft.overlay.core.EconText.coinsShort(t.reward());
            int rsw = tr.getWidth(rs);
            int rx = x + w - 4 - rsw;
            if (rx - 10 > fx) {
                int col = paid ? 0xFF5BE37D : refunded ? Gfx.FAINT : 0xFFFFE9A8;
                com.hivecraft.overlay.screen.econ.EconGfx.coin(g, rx - 10, fy, 1);
                g.drawText(tr, rs, rx, fy, col, !refunded);
                if (refunded) g.fill(rx - 10, fy + 4, rx + rsw, fy + 5, 0xC0FF6B6B);
                rewardHover = ui.hover(rx - 11, fy - 1, rsw + 12, 10);
                if (rewardHover) ui.tooltip(paid ? "bounty " + com.hivecraft.overlay.core.EconText.coins(t.reward()) + " coins · paid to " + (t.rewardTo() == null ? "?" : t.rewardTo())
                        : refunded ? "bounty refunded" : "bounty: " + com.hivecraft.overlay.core.EconText.coins(t.reward()) + " coins to whoever claims and finishes it");
            }
            if (!paid && !refunded) g.fill(x + w - 1, y, x + w, y + h, 0xC0FFC93C);
        }
        if (!"done".equals(t.status()) && hv) {
            ui.button(x + w - 16, y + 2, 14, 11, "✔", Gfx.GOOD, true, () -> s.command("board done " + t.id()), "mark #" + t.id() + " done");
        }
        // tooltip: detail + age
        if (hv && !rewardHover && !ui.hover(x + w - 16, y + 2, 14, 11)) {
            String tip = (t.detail() != null && !t.detail().isBlank() ? UiMath.ellipsize(t.detail(), 80) + " · " : "")
                    + "by " + t.by() + " · " + UiMath.formatAge(now - t.updated()) + " ago";
            ui.tooltip(tip);
        }
        return h;
    }

    @Override
    public boolean scrolled(double mx, double my, double v) {
        if (colW <= 0) return false;
        int c = (int) ((mx - colX0) / (colW + gap));
        if (c < 0 || c > 3) return false;
        scroll[c] = Tab.clampScroll(scroll[c] - (int) (v * 20), contentH[c], colH - 17);
        return true;
    }

    @Override
    public boolean key(ControlScreen s, int key, int scan, int mods) {
        if (field != null && field.isFocused() && (key == GLFW.GLFW_KEY_ENTER || key == GLFW.GLFW_KEY_KP_ENTER)) {
            submit();
            return true;
        }
        return false;
    }
}
