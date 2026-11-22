package com.hivecraft.overlay.screen;

import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveState;
import com.hivecraft.overlay.screen.econ.EconGfx;
import com.hivecraft.overlay.screen.econ.EconHost;
import com.hivecraft.overlay.screen.econ.EconPanel;
import com.hivecraft.overlay.ui.HiveUI;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.Element;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

/** The Economy screen (default key V): Wallet · Shop · Market · Auctions · Jobs. Same body as the Control screen's tab. */
public final class EconomyScreen extends Screen implements EconHost {
    private final EconPanel panel = new EconPanel();
    private final Ui ui = new Ui();
    private final long openedAt = System.currentTimeMillis();
    private String toast;
    private int toastColor = Gfx.TEXT;
    private long toastAt;

    public EconomyScreen() {
        super(Text.literal("Hivecraft Economy"));
    }

    @Override
    protected void init() {
        clearChildren();
        panel.open(this);
    }

    @Override
    public void resize(net.minecraft.client.MinecraftClient client, int width, int height) {
        panel.close();
        super.resize(client, width, height);
    }

    @Override
    public boolean shouldPause() { return false; }

    @Override
    public void renderBackground(DrawContext g, int mouseX, int mouseY, float delta) {
        g.fillGradient(0, 0, width, height, 0x90000000, 0xB0000000);
    }

    private ControlScreen.Area panelArea() {
        int w = Math.min(width - 16, 620);
        int h = Math.min(height - 16, 360);
        return new ControlScreen.Area((width - w) / 2, (height - h) / 2, w, h);
    }

    @Override
    public void render(DrawContext g, int mouseX, int mouseY, float delta) {
        renderBackground(g, mouseX, mouseY, delta);
        long now = System.currentTimeMillis();
        double in = UiMath.easeOutCubic((now - openedAt) / 200.0);
        ControlScreen.Area p = panelArea();
        var m = g.getMatrices();
        m.push();
        float s = (float) (0.96 + 0.04 * in);
        m.translate(width / 2f, height / 2f, 0);
        m.scale(s, s, 1);
        m.translate(-width / 2f, -height / 2f, 0);

        Gfx.panel(g, p.x(), p.y(), p.w(), p.h(), -1, 0.95, 1);
        // title row with a warm gold wash
        g.fill(p.x() + 1, p.y() + 1, p.right() - 1, p.y() + 16, 0xFF141A24);
        g.fillGradient(p.x() + 1, p.y() + 1, p.x() + Math.min(220, p.w() / 2), p.y() + 16, 0x30FFC93C, 0x00FFC93C);
        EconGfx.coin(g, p.x() + 6, p.y() + 4, 1);
        Gfx.text(g, textRenderer, "HIVECRAFT", p.x() + 18, p.y() + 5, Gfx.GOLD);
        Gfx.text(g, textRenderer, "economy", p.x() + 20 + textRenderer.getWidth("HIVECRAFT"), p.y() + 5, Gfx.FAINT);
        HiveState st = Hive.state();
        String c = switch (st.connection()) { case ONLINE -> "● live"; case CONNECTING -> "◌ connecting"; default -> "○ offline"; };
        int cc = st.online() ? Gfx.GOOD : st.connection() == HiveState.Connection.CONNECTING ? Gfx.WARN : Gfx.BAD;
        Gfx.text(g, textRenderer, c, p.right() - 8 - textRenderer.getWidth(c), p.y() + 5, cc);
        g.fill(p.x() + 1, p.y() + 16, p.right() - 1, p.y() + 17, 0xFF2A3242);

        ui.begin(g, textRenderer, mouseX, mouseY);
        ControlScreen.Area area = new ControlScreen.Area(p.x() + 8, p.y() + 22, p.w() - 16, p.h() - 22 - 18);
        g.enableScissor(area.x() - 2, area.y() - 2, area.right() + 2, area.bottom() + 2);
        try {
            panel.render(ui, area, now);
        } catch (RuntimeException e) {
            com.hivecraft.overlay.core.Guard.get().fail("econ.screen", e);
            Gfx.text(g, textRenderer, "economy screen error: " + e, area.x(), area.y() + 24, Gfx.BAD);
        }
        g.disableScissor();

        // footer: toast / hints
        int fy = p.bottom() - 13;
        g.fill(p.x() + 1, fy - 3, p.right() - 1, fy - 2, 0xFF1C2230);
        if (toast != null && now - toastAt < 6000) {
            double a = UiMath.fade(now - toastAt, 6000, 120, 800);
            Gfx.textA(g, textRenderer, Gfx.fit(textRenderer, toast, p.w() - 20), p.x() + 8, fy, toastColor, a);
        } else {
            String key = HiveUI.keys().economy.getBoundKeyLocalizedText().getString();
            Gfx.text(g, textRenderer, "Esc / " + key + " close · 1-" + panel.count() + " sections · Ctrl+Tab next · Enter confirms", p.x() + 8, fy, Gfx.FAINT);
        }
        for (var child : this.children()) {
            if (child instanceof net.minecraft.client.gui.Drawable d) d.render(g, mouseX, mouseY, delta);
        }
        ui.end();
        m.pop();
    }

    // ------------------------------------------------------------------ EconHost

    @Override
    public void toast(String msg, int color) {
        toast = msg;
        toastColor = color;
        toastAt = System.currentTimeMillis();
    }

    @Override
    public TextFieldWidget textField(int x, int y, int w, String placeholder) {
        TextFieldWidget f = new TextFieldWidget(textRenderer, x, y, w, 14, Text.literal(placeholder));
        f.setPlaceholder(Text.literal(placeholder).withColor(0x5D6574));
        f.setMaxLength(200);
        return addDrawableChild(f);
    }

    @Override
    public void removeWidget(Element e) { remove(e); }

    @Override
    public void focus(Element e) { setFocused(e); }

    // ------------------------------------------------------------------ input

    @Override
    public boolean mouseClicked(double mx, double my, int button) {
        if (super.mouseClicked(mx, my, button)) return true;
        // clicking empty space drops text focus (so number keys switch sections again)
        if (getFocused() instanceof TextFieldWidget tf) { tf.setFocused(false); setFocused(null); }
        return button == 0 && ui.click(mx, my);
    }

    @Override
    public boolean mouseScrolled(double mx, double my, double h, double v) {
        if (panel.scrolled(mx, my, v)) return true;
        return super.mouseScrolled(mx, my, h, v);
    }

    @Override
    public boolean keyPressed(int key, int scan, int mods) {
        boolean typing = getFocused() instanceof TextFieldWidget tf && tf.isFocused();
        if (key == GLFW.GLFW_KEY_TAB && hasControlDown()) {
            panel.cycle(hasShiftDown());
            return true;
        }
        if (panel.key(key, scan, mods, !typing)) return true;
        if (!typing) {
            if (HiveUI.keys().economy.matchesKey(key, scan)) { close(); return true; }
            if (HiveUI.keys().control.matchesKey(key, scan)) {
                close();
                client.execute(() -> client.setScreen(new ControlScreen(ControlScreen.TAB_ECON)));
                return true;
            }
        }
        return super.keyPressed(key, scan, mods);
    }

    @Override
    public void close() {
        panel.close();
        super.close();
    }
}
