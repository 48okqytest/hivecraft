package com.hivecraft.overlay.screen.econ;

import net.minecraft.client.gui.Element;
import net.minecraft.client.gui.widget.TextFieldWidget;

/** What an economy view needs from the screen hosting it (the Economy screen or the Control screen's tab). */
public interface EconHost {
    void toast(String msg, int color);

    /** Adds a 14 px high text field as a child widget of the screen. */
    TextFieldWidget textField(int x, int y, int w, String placeholder);

    void removeWidget(Element e);

    void focus(Element e);
}
