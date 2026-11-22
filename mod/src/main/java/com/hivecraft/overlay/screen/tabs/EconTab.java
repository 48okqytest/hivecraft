package com.hivecraft.overlay.screen.tabs;

import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.screen.econ.EconHost;
import com.hivecraft.overlay.screen.econ.EconPanel;
import net.minecraft.client.gui.Element;
import net.minecraft.client.gui.widget.TextFieldWidget;

/** The Control screen's Economy tab: the same panel as the Economy screen (V). */
public final class EconTab implements Tab {
    private final EconPanel panel = new EconPanel();
    private EconHost host;

    @Override public String title() { return "Economy"; }
    @Override public String icon() { return "⛃"; }

    @Override
    public void open(ControlScreen s, ControlScreen.Area a) {
        host = new EconHost() {
            @Override public void toast(String msg, int color) { s.toast(msg, color); }
            @Override public TextFieldWidget textField(int x, int y, int w, String placeholder) { return s.textField(x, y, w, placeholder); }
            @Override public void removeWidget(Element e) { s.removeWidget(e); }
            @Override public void focus(Element e) { s.setFocused(e); }
        };
        panel.open(host);
    }

    @Override
    public void close() {
        panel.close();
    }

    @Override
    public void render(ControlScreen s, Ui ui, ControlScreen.Area a, long now, float delta) {
        panel.render(ui, a, now);
    }

    @Override
    public boolean scrolled(double mx, double my, double v) { return panel.scrolled(mx, my, v); }

    /** Enter etc. go to the view; section digits stay with the Control screen (its tab keys), so no digits here. */
    @Override
    public boolean key(ControlScreen s, int key, int scan, int mods) { return panel.key(key, scan, mods, false); }
}
