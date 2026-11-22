package com.hivecraft.overlay.screen.tabs;

import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.Ui;

/** One tab of the control screen. Render is immediate-mode through {@link Ui}. */
public interface Tab {
    String title();

    String icon();

    /** Tab became visible (create text fields here). */
    default void open(ControlScreen s, ControlScreen.Area a) {}

    /** Tab hidden / screen closing. */
    default void close() {}

    void render(ControlScreen s, Ui ui, ControlScreen.Area a, long now, float delta);

    default boolean scrolled(double mx, double my, double v) { return false; }

    default boolean clicked(ControlScreen s, double mx, double my, int button) { return false; }

    default boolean dragged(double mx, double my, int button, double dx, double dy) { return false; }

    default void released(double mx, double my, int button) {}

    default boolean key(ControlScreen s, int key, int scan, int mods) { return false; }

    /** Scroll offset helper: clamp {@code v} to [0, max]. */
    static int clampScroll(int v, int content, int view) {
        return Math.max(0, Math.min(v, Math.max(0, content - view)));
    }
}
