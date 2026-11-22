package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.EconState;
import com.hivecraft.overlay.core.EconText;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.screen.Ui;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.sound.PositionedSoundInstance;
import net.minecraft.item.ItemStack;
import net.minecraft.sound.SoundEvents;

import java.util.HashMap;
import java.util.Map;

/** Drawing bits shared by the economy screens: coin icon, item slots, big numbers, section titles, sounds. */
public final class EconGfx {
    private EconGfx() {}

    public static final int COIN = 0xFFFFC93C;
    public static final int COIN_DARK = 0xFFB7791F;
    public static final int MONEY_IN = 0xFF5BE37D;
    public static final int MONEY_OUT = 0xFFFF6B6B;
    public static final int ROW = 0xA0161B25;
    public static final int ROW_HOVER = 0xE0222A38;
    public static final int ROW_SEL = 0xF02A3346;

    private static final String[] COIN_ROWS = {
            "..####..",
            ".#hhhh#.",
            "#hhggg##",
            "#hgggg##",
            "#hgggg##",
            "#gggggd#",
            ".#ddddd.",
            "..####..",
    };

    /** 8×8 pixel-art gold coin at (x,y), scaled by {@code px} (1 = 8 px). */
    public static void coin(DrawContext g, int x, int y, int px) {
        for (int r = 0; r < 8; r++) {
            String row = COIN_ROWS[r];
            for (int c = 0; c < 8; c++) {
                int col = switch (row.charAt(c)) {
                    case '#' -> 0xFF6B4410;
                    case 'h' -> 0xFFFFF1A8;
                    case 'g' -> COIN;
                    case 'd' -> COIN_DARK;
                    default -> 0;
                };
                if (col != 0) g.fill(x + c * px, y + r * px, x + (c + 1) * px, y + (r + 1) * px, col);
            }
        }
    }

    /** Coin + amount ("⛁ 136"); returns the width drawn. */
    public static int amount(DrawContext g, TextRenderer tr, long coins, int x, int y, int color) {
        coin(g, x, y, 1);
        String s = EconText.coins(coins);
        g.drawText(tr, s, x + 10, y, color, true);
        return 10 + tr.getWidth(s);
    }

    public static int amountWidth(TextRenderer tr, long coins) { return 10 + tr.getWidth(EconText.coins(coins)); }

    /** Text drawn {@code scale}× bigger at (x,y). */
    public static void big(DrawContext g, TextRenderer tr, String s, int x, int y, float scale, int color) {
        var m = g.getMatrices();
        m.push();
        m.translate(x, y, 0);
        m.scale(scale, scale, 1);
        g.drawText(tr, s, 0, 0, color, true);
        m.pop();
    }

    /** Section title with a thin accent underline. */
    public static void title(DrawContext g, TextRenderer tr, String s, int x, int y, int w, int accent) {
        g.drawText(tr, s, x, y, accent, true);
        int tw = tr.getWidth(s);
        g.fill(x, y + 10, x + w, y + 11, 0x18FFFFFF);
        g.fill(x, y + 10, x + Math.min(w, tw + 6), y + 11, UiMath.withAlpha(accent, 0.8));
    }

    /** Card background (inner panels). */
    public static void card(DrawContext g, int x, int y, int w, int h) {
        g.fill(x, y, x + w, y + h, 0x70101520);
        g.fill(x, y, x + w, y + 1, 0x22FFFFFF);
        g.drawBorder(x, y, w, h, 0x502A3242);
    }

    /** Inventory-style slot (18×18 for a 16 px item). */
    public static void slot(DrawContext g, int x, int y, int size, boolean hover, boolean selected) {
        g.fill(x, y, x + size, y + size, selected ? 0xFF3A3220 : hover ? 0xFF2A3140 : 0xFF1A1F29);
        g.fill(x, y, x + size, y + 1, 0xFF0B0E13);
        g.fill(x, y, x + 1, y + size, 0xFF0B0E13);
        g.fill(x, y + size - 1, x + size, y + size, 0xFF363E4E);
        g.fill(x + size - 1, y, x + size, y + size, 0xFF363E4E);
        if (selected) g.drawBorder(x - 1, y - 1, size + 2, size + 2, Gfx.GOLD);
    }

    /** Item icon with an optional count label (any number, e.g. "128"). */
    public static void item(DrawContext g, TextRenderer tr, String id, int x, int y, int count) {
        ItemStack st = Gfx.stack(id);
        if (st.isEmpty()) {
            g.fill(x + 3, y + 3, x + 13, y + 13, 0xFF3A2A2A);
            g.drawText(tr, "?", x + 6, y + 4, Gfx.MUTED, false);
            return;
        }
        g.drawItem(st, x, y);
        if (count > 1) g.drawItemInSlot(tr, st, x, y, count > 9999 ? EconText.coinsShort(count) : String.valueOf(count));
    }

    private static final Map<String, String> NAMES = new HashMap<>();

    /** Localized item name ("Oak Log"), falling back to the prettified id. */
    public static String name(String id) {
        if (id == null) return "";
        return NAMES.computeIfAbsent(id, k -> {
            ItemStack st = Gfx.stack(k);
            if (st.isEmpty()) return EconText.pretty(k);
            try { return st.getName().getString(); } catch (RuntimeException e) { return EconText.pretty(k); }
        });
    }

    /** Colour for an account: bot colour, the player yellow, Server/Escrow grey. */
    public static int who(String name) {
        if (name == null) return Gfx.MUTED;
        EconState es = Hive.state().econ();
        if (es.isMe(name)) return 0xFFFFFF55;
        BotState b = Hive.state().bot(name);
        if (b != null) return 0xFF000000 | b.color();
        return Gfx.MUTED;
    }

    /** "you" for the player, else the name. */
    public static String display(String name) {
        return Hive.state().econ().isMe(name) ? "you" : name == null ? "?" : name;
    }

    /** Draws a small "LIVE"/offline note when the economy isn't loaded; returns true when it drew a blocker. */
    public static boolean notLoaded(Ui ui, int x, int y, int w, int h) {
        EconState es = Hive.state().econ();
        if (es.loaded()) return false;
        String err = com.hivecraft.overlay.core.Econ.get().lastLoadError();
        String l1 = com.hivecraft.overlay.core.Econ.get().loading() ? "Loading the economy…" : "Economy not loaded";
        String l2 = !Hive.state().online() ? "The Hivecraft bridge is offline." : err.isBlank() ? "Waiting for the bridge…" : err;
        int cx = x + w / 2;
        coin(ui.g, cx - 8, y + h / 2 - 26, 2);
        ui.g.drawCenteredTextWithShadow(ui.tr, l1, cx, y + h / 2 - 4, Gfx.TEXT);
        ui.g.drawCenteredTextWithShadow(ui.tr, Gfx.fit(ui.tr, l2, w - 20), cx, y + h / 2 + 8, Gfx.MUTED);
        ui.button(cx - 30, y + h / 2 + 22, 60, 14, "↻ Retry", Gfx.GOLD, true, () -> com.hivecraft.overlay.core.Econ.get().refresh(), null);
        return true;
    }

    // ------------------------------------------------------------------ sounds (quiet)

    public static void soundOk() {
        try {
            MinecraftClient.getInstance().getSoundManager().play(PositionedSoundInstance.master(SoundEvents.ENTITY_EXPERIENCE_ORB_PICKUP, 1.35f, 0.35f));
        } catch (RuntimeException ignored) { /* sound is cosmetic */ }
    }

    public static void soundFail() {
        try {
            MinecraftClient.getInstance().getSoundManager().play(PositionedSoundInstance.master(SoundEvents.BLOCK_NOTE_BLOCK_BASS.value(), 0.7f, 0.4f));
        } catch (RuntimeException ignored) { /* sound is cosmetic */ }
    }

    public static void soundClick() {
        try {
            MinecraftClient.getInstance().getSoundManager().play(PositionedSoundInstance.master(SoundEvents.UI_BUTTON_CLICK.value(), 1.0f, 0.25f));
        } catch (RuntimeException ignored) { /* sound is cosmetic */ }
    }
}
