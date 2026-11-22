package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.EconText;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.draw.Gfx;
import net.minecraft.client.gui.widget.TextFieldWidget;

/**
 * A whole-number input: text field ("64", "1,000", "2k") with optional [−][+] steppers. Owns its TextFieldWidget
 * (created in {@link #open}, removed in {@link #close}); position it every frame with {@link #render}.
 */
public final class NumField {
    private final String placeholder;
    private final long min;
    private long max;
    private TextFieldWidget field;
    private String pending = "";

    public NumField(String placeholder, long min, long max) {
        this.placeholder = placeholder;
        this.min = min;
        this.max = max;
    }

    public void open(EconHost h) {
        field = h.textField(-500, -500, 40, placeholder);
        field.setMaxLength(12);
        field.setTextPredicate(NumField::allowed);
        field.setText(pending);
    }

    static boolean allowed(String s) {
        if (s.length() > 12) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (!(Character.isDigit(c) || c == ',' || c == '_' || c == '.' || c == 'k' || c == 'K' || c == 'm' || c == 'M')) return false;
        }
        return true;
    }

    public void close(EconHost h) {
        if (field != null) {
            pending = field.getText();
            h.removeWidget(field);
        }
        field = null;
    }

    public void setMax(long max) { this.max = Math.max(min, max); }

    public long max() { return max; }

    public TextFieldWidget widget() { return field; }

    public boolean focused() { return field != null && field.isFocused(); }

    /** Parsed value or null when empty/invalid. */
    public Long value() {
        return EconText.parseAmount(field != null ? field.getText() : pending);
    }

    /** Value clamped to [min,max], or {@code def} when empty/invalid. */
    public long valueOr(long def) {
        Long v = value();
        if (v == null) return def;
        return Math.max(min, Math.min(max, v));
    }

    /** True when the typed value is a number inside [min,max]. */
    public boolean valid() {
        Long v = value();
        return v != null && v >= min && v <= max;
    }

    public void set(long v) {
        String s = String.valueOf(Math.max(min, Math.min(max, v)));
        if (field != null) field.setText(s);
        else pending = s;
    }

    public void clear() {
        if (field != null) field.setText("");
        else pending = "";
    }

    /** Places the field; with {@code steppers} draws [−] and [+] around it. Total width = w. */
    public void render(Ui ui, int x, int y, int w, boolean steppers, long step) {
        if (field == null) return;
        if (steppers) {
            ui.button(x, y, 12, 14, "-", Gfx.INFO, true, () -> set(valueOr(min) - step), "-" + step);
            ui.button(x + w - 12, y, 12, 14, "+", Gfx.INFO, true, () -> { Long v = value(); set(v == null ? Math.max(min, step) : v + step); }, "+" + step);
            field.setX(x + 14);
            field.setY(y);
            field.setWidth(w - 28);
        } else {
            field.setX(x);
            field.setY(y);
            field.setWidth(w);
        }
        String t = field.getText();
        if (!t.isEmpty() && !valid()) ui.g.drawBorder(field.getX() - 1, y - 1, field.getWidth() + 2, 16, 0xFFFF5252);
    }

    /** Moves the field off-screen (when its section isn't shown this frame). */
    public void hide() {
        if (field != null) {
            field.setX(-500);
            field.setY(-500);
            if (field.isFocused()) field.setFocused(false);
        }
    }
}
