package com.hivecraft.overlay.screen;

import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveClient;
import com.hivecraft.overlay.core.HiveState;
import com.hivecraft.overlay.screen.tabs.AlbumTab;
import com.hivecraft.overlay.screen.tabs.BoardTab;
import com.hivecraft.overlay.screen.tabs.BotsTab;
import com.hivecraft.overlay.screen.tabs.EconTab;
import com.hivecraft.overlay.screen.tabs.LedgerTab;
import com.hivecraft.overlay.screen.tabs.MapTab;
import com.hivecraft.overlay.screen.tabs.Tab;
import com.hivecraft.overlay.screen.tabs.TogglesTab;
import com.hivecraft.overlay.ui.HiveUI;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.term.TermLine;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

import java.util.List;

/** The control screen (default key H): Bots · Board · Album · Map · Ledger · Toggles · Economy. */
public final class ControlScreen extends Screen {
    private static int lastTab = 0;

    private final List<Tab> tabs = List.of(new BotsTab(), new BoardTab(), new AlbumTab(), new MapTab(), new LedgerTab(), new TogglesTab(), new EconTab());
    private int current;
    private final Ui ui = new Ui();
    private final long openedAt = System.currentTimeMillis();
    private long tabSwitchedAt = System.currentTimeMillis();
    private String toast;
    private int toastColor = Gfx.TEXT;
    private long toastAt;

    public ControlScreen() {
        this(lastTab);
    }

    /** Opens on tab {@code tab} (0 Bots, 1 Board, 2 Album, 3 Map, 4 Ledger, 5 Toggles). */
    public ControlScreen(int tab) {
        super(Text.literal("Hivecraft"));
        current = Math.max(0, Math.min(tab, tabs.size() - 1));
        lastTab = current;
    }

    public static final int TAB_ALBUM = 2;
    public static final int TAB_ECON = 6;

    public record Area(int x, int y, int w, int h) {
        public int right() { return x + w; }
        public int bottom() { return y + h; }
    }

    @Override
    protected void init() {
        clearChildren();
        tabs.get(current).open(this, contentArea());
    }

    @Override
    public boolean shouldPause() {
        return false;
    }

    @Override
    public void renderBackground(DrawContext g, int mouseX, int mouseY, float delta) {
        g.fillGradient(0, 0, width, height, 0x90000000, 0xB0000000);
    }

    private Area panelArea() {
        int w = Math.min(width - 24, 560);
        int h = Math.min(height - 24, 330);
        return new Area((width - w) / 2, (height - h) / 2, w, h);
    }

    public Area contentArea() {
        Area p = panelArea();
        return new Area(p.x() + 8, p.y() + 34, p.w() - 16, p.h() - 34 - 18);
    }

    public void switchTab(int i) {
        if (i == current || i < 0 || i >= tabs.size()) return;
        tabs.get(current).close();
        clearChildren();
        current = i;
        lastTab = i;
        tabSwitchedAt = System.currentTimeMillis();
        tabs.get(current).open(this, contentArea());
    }

    @Override
    public void resize(net.minecraft.client.MinecraftClient client, int width, int height) {
        tabs.get(current).close();
        super.resize(client, width, height);
    }

    @Override
    public void render(DrawContext g, int mouseX, int mouseY, float delta) {
        renderBackground(g, mouseX, mouseY, delta);
        long now = System.currentTimeMillis();
        double in = UiMath.easeOutCubic((now - openedAt) / 200.0);
        Area p = panelArea();
        var m = g.getMatrices();
        m.push();
        // pop-in: slight scale from centre
        float s = (float) (0.96 + 0.04 * in);
        m.translate(width / 2f, height / 2f, 0);
        m.scale(s, s, 1);
        m.translate(-width / 2f, -height / 2f, 0);

        Gfx.panel(g, p.x(), p.y(), p.w(), p.h(), -1, 0.94, 1);
        // title row
        g.fill(p.x() + 1, p.y() + 1, p.right() - 1, p.y() + 16, 0xFF141A24);
        Gfx.text(g, textRenderer, "⬢ HIVECRAFT", p.x() + 7, p.y() + 5, Gfx.GOLD);
        Gfx.text(g, textRenderer, "control", p.x() + 9 + textRenderer.getWidth("⬢ HIVECRAFT"), p.y() + 5, Gfx.FAINT);
        drawConn(g, p, now);

        ui.begin(g, textRenderer, mouseX, mouseY);
        // tabs
        int tx = p.x() + 6;
        int ty = p.y() + 18;
        for (int i = 0; i < tabs.size(); i++) {
            Tab t = tabs.get(i);
            String label = t.icon() + " " + t.title() + (i < 9 ? "" : "");
            int w = textRenderer.getWidth(label) + 14;
            boolean sel = i == current;
            boolean hv = ui.hover(tx, ty, w, 14);
            g.fill(tx, ty, tx + w, ty + 14, sel ? 0xFF1F2733 : hv ? 0x60303846 : 0x00000000);
            if (sel) g.fill(tx, ty + 13, tx + w, ty + 14, Gfx.GOLD);
            g.drawText(textRenderer, label, tx + 7, ty + 3, sel ? 0xFFFFFFFF : hv ? Gfx.TEXT : Gfx.MUTED, false);
            final int idx = i;
            ui.region(tx, ty, w, 14, () -> switchTab(idx), (i + 1) + " / Ctrl+Tab");
            tx += w + 2;
        }
        g.fill(p.x() + 1, ty + 14, p.right() - 1, ty + 15, 0xFF2A3242);

        // content (fade/slide in on tab switch)
        Area c = contentArea();
        double tin = UiMath.easeOutCubic((now - tabSwitchedAt) / 160.0);
        m.push();
        m.translate(0, (float) ((1 - tin) * 6), 0);
        g.enableScissor(c.x() - 2, c.y() - 2, c.right() + 2, c.bottom() + 2);
        try {
            tabs.get(current).render(this, ui, c, now, delta);
        } catch (RuntimeException e) {
            Gfx.text(g, textRenderer, "tab error: " + e, c.x(), c.y(), Gfx.BAD);
        }
        g.disableScissor();
        m.pop();

        // footer: toast / hints
        int fy = p.bottom() - 13;
        g.fill(p.x() + 1, fy - 3, p.right() - 1, fy - 2, 0xFF1C2230);
        if (toast != null && now - toastAt < 6000) {
            double a = UiMath.fade(now - toastAt, 6000, 120, 800);
            Gfx.textA(g, textRenderer, Gfx.fit(textRenderer, toast, p.w() - 20), p.x() + 8, fy, toastColor, a);
        } else {
            Gfx.text(g, textRenderer, "Esc close · 1-" + tabs.size() + " tabs · " + HiveUI.keys().terminal.getBoundKeyLocalizedText().getString() + " terminal", p.x() + 8, fy, Gfx.FAINT);
        }
        // widgets (text fields) over our drawing
        for (var child : this.children()) {
            if (child instanceof net.minecraft.client.gui.Drawable d) d.render(g, mouseX, mouseY, delta);
        }
        ui.end();
        m.pop();
    }

    private void drawConn(DrawContext g, Area p, long now) {
        HiveState st = Hive.state();
        String s = switch (st.connection()) {
            case ONLINE -> "● live";
            case CONNECTING -> "◌ connecting";
            default -> "○ offline";
        };
        int c = st.online() ? Gfx.GOOD : st.connection() == HiveState.Connection.CONNECTING ? Gfx.WARN : Gfx.BAD;
        int w = textRenderer.getWidth(s);
        Gfx.text(g, textRenderer, s, p.right() - 8 - w, p.y() + 5, c);
    }

    // ------------------------------------------------------------------ services for tabs

    public void toast(String msg, int color) {
        toast = msg;
        toastColor = color;
        toastAt = System.currentTimeMillis();
    }

    /** Sends a terminal command; shows the first output line as a toast. */
    public void command(String text) {
        HiveClient c = Hive.client();
        if (c == null) {
            toast("not connected", Gfx.BAD);
            return;
        }
        toast("› " + text, Gfx.MUTED);
        c.sendCommand(text).thenAccept(r -> client.execute(() -> {
            String first = r.lines().isEmpty() ? (r.ok() ? "ok" : "failed") : r.plainText().split("\n", 2)[0];
            toast((r.ok() ? "✔ " : "✖ ") + first, r.ok() ? Gfx.GOOD : Gfx.BAD);
            // full output also goes to the terminal scrollback
            var term = HiveUI.terminal();
            if (term != null) {
                term.post(TermLine.of("› " + text + "  (control screen)", TermLine.DIM));
                for (TermLine l : HiveUI.toReply(r).lines()) term.post(l);
            }
        }));
    }

    public <T extends net.minecraft.client.gui.Element & net.minecraft.client.gui.Drawable & net.minecraft.client.gui.Selectable> T add(T w) {
        return addDrawableChild(w);
    }

    public TextFieldWidget textField(int x, int y, int w, String placeholder) {
        TextFieldWidget f = new TextFieldWidget(textRenderer, x, y, w, 14, Text.literal(placeholder));
        f.setPlaceholder(Text.literal(placeholder).withColor(0x5D6574));
        f.setMaxLength(200);
        return addDrawableChild(f);
    }

    public void removeWidget(net.minecraft.client.gui.Element e) {
        remove(e);
    }

    public void closeAndRun(Runnable r) {
        close();
        client.execute(r);
    }

    // ------------------------------------------------------------------ input

    @Override
    public boolean mouseClicked(double mx, double my, int button) {
        if (super.mouseClicked(mx, my, button)) return true; // text fields first
        if (button == 0 && ui.click(mx, my)) return true;
        return tabs.get(current).clicked(this, mx, my, button);
    }

    @Override
    public boolean mouseDragged(double mx, double my, int button, double dx, double dy) {
        if (tabs.get(current).dragged(mx, my, button, dx, dy)) return true;
        return super.mouseDragged(mx, my, button, dx, dy);
    }

    @Override
    public boolean mouseReleased(double mx, double my, int button) {
        tabs.get(current).released(mx, my, button);
        return super.mouseReleased(mx, my, button);
    }

    @Override
    public boolean mouseScrolled(double mx, double my, double h, double v) {
        if (tabs.get(current).scrolled(mx, my, v)) return true;
        return super.mouseScrolled(mx, my, h, v);
    }

    @Override
    public boolean keyPressed(int key, int scan, int mods) {
        if (tabs.get(current).key(this, key, scan, mods)) return true;
        boolean typing = getFocused() instanceof TextFieldWidget tf && tf.isFocused();
        if (!typing) {
            if (key >= GLFW.GLFW_KEY_1 && key < GLFW.GLFW_KEY_1 + Math.min(9, tabs.size())) {
                switchTab(key - GLFW.GLFW_KEY_1);
                return true;
            }
            if (HiveUI.keys().control.matchesKey(key, scan)) {
                close();
                return true;
            }
            if (HiveUI.keys().economy.matchesKey(key, scan)) {
                if (current == TAB_ECON) close(); else switchTab(TAB_ECON);
                return true;
            }
            if (HiveUI.keys().terminal.matchesKey(key, scan)) {
                closeAndRun(() -> client.setScreen(new TerminalScreen(HiveUI.terminal())));
                return true;
            }
        }
        if (key == GLFW.GLFW_KEY_TAB && hasControlDown()) {
            switchTab((current + (hasShiftDown() ? tabs.size() - 1 : 1)) % tabs.size());
            return true;
        }
        return super.keyPressed(key, scan, mods);
    }

    @Override
    public void close() {
        tabs.get(current).close();
        super.close();
    }
}
