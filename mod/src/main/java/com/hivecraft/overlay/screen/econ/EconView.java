package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;

/** One section of the economy UI (Wallet · Shop · Market · Auctions). Immediate-mode like the control tabs. */
public interface EconView {
    String title();

    String icon();

    /** Became visible: create text fields. */
    void open(EconHost host);

    /** Hidden / screen closing: remove text fields. */
    void close(EconHost host);

    void render(EconHost host, Ui ui, ControlScreen.Area a, long now);

    default boolean scrolled(double mx, double my, double v) { return false; }

    /** Enter etc. Return true when handled. */
    default boolean key(EconHost host, int key, int scan, int mods) { return false; }

    /** True while one of this view's text fields has focus (number keys then type instead of switching tabs). */
    default boolean typing() { return false; }

    /** Moves this view's text fields off-screen (the economy isn't loaded, so the view isn't drawn). */
    default void hideFields() {}
}
