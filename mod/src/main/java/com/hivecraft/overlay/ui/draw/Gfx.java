package com.hivecraft.overlay.ui.draw;

import com.hivecraft.overlay.ui.term.TermLine;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.text.MutableText;
import net.minecraft.text.Style;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.RotationAxis;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Drawing helpers shared by the HUD and screens: panels, bars, arrows, icons, styled text. */
public final class Gfx {
    private Gfx() {}

    // palette
    public static final int BG = 0x0E1117;          // panel body (rgb)
    public static final int BG2 = 0x161B24;         // header / inner
    public static final int EDGE = 0x2A3242;        // border
    public static final int TEXT = 0xFFE6E9EF;
    public static final int MUTED = 0xFF9099A8;
    public static final int FAINT = 0xFF5D6574;
    public static final int GOLD = 0xFFFFC24A;      // hive accent
    public static final int GOOD = 0xFF4CE06A;
    public static final int BAD = 0xFFFF5252;
    public static final int WARN = 0xFFFFB13B;
    public static final int INFO = 0xFF5CC8FF;

    /**
     * Dark translucent panel with a 1px border, a soft top highlight and an optional accent strip
     * on the left. {@code alpha} 0..1 multiplies everything (fades).
     */
    public static void panel(DrawContext g, int x, int y, int w, int h, int accentRgb, double opacity, double alpha) {
        int bodyA = (int) (255 * opacity * alpha);
        int edgeA = (int) (200 * alpha);
        // drop shadow
        g.fill(x + 1, y + h, x + w + 1, y + h + 1, UiMath.rgbA(0x000000, (int) (90 * alpha)));
        g.fill(x + w, y + 1, x + w + 1, y + h, UiMath.rgbA(0x000000, (int) (90 * alpha)));
        // body: subtle vertical gradient
        g.fillGradient(x, y, x + w, y + h, UiMath.rgbA(BG2, bodyA), UiMath.rgbA(BG, bodyA));
        // border (corners left out for a rounded feel)
        int e = UiMath.rgbA(EDGE, edgeA);
        g.fill(x + 1, y, x + w - 1, y + 1, e);
        g.fill(x + 1, y + h - 1, x + w - 1, y + h, e);
        g.fill(x, y + 1, x + 1, y + h - 1, e);
        g.fill(x + w - 1, y + 1, x + w, y + h - 1, e);
        // top inner highlight
        g.fill(x + 1, y + 1, x + w - 1, y + 2, UiMath.rgbA(0xFFFFFF, (int) (18 * alpha)));
        if (accentRgb >= 0) {
            g.fill(x + 1, y + 1, x + 3, y + h - 1, UiMath.rgbA(accentRgb, (int) (235 * alpha)));
            g.fillGradient(x + 3, y + 1, x + 10, y + h - 1, UiMath.rgbA(accentRgb, (int) (40 * alpha)), UiMath.rgbA(accentRgb, 0));
        }
    }

    /** Header strip used by titled panels. */
    public static void header(DrawContext g, TextRenderer tr, int x, int y, int w, String title, int accentArgb, double alpha) {
        g.fill(x + 1, y + 1, x + w - 1, y + 12, UiMath.withAlpha(0x40000000 | (accentArgb & 0xFFFFFF), alpha));
        g.fill(x + 1, y + 12, x + w - 1, y + 13, UiMath.withAlpha(accentArgb, 0.6 * alpha));
        g.drawText(tr, title, x + 5, y + 3, UiMath.withAlpha(accentArgb, alpha), true);
    }

    /** Progress / vitals bar with track, fill, a bright leading edge and optional segment ticks. */
    public static void bar(DrawContext g, int x, int y, int w, int h, double frac, int fillArgb, int segments, double alpha) {
        frac = UiMath.clamp01(frac);
        g.fill(x, y, x + w, y + h, UiMath.withAlpha(0xC0000000, alpha));
        int fw = (int) Math.round((w - 2) * frac);
        if (fw > 0) {
            int top = UiMath.shade(fillArgb, 0.25), bot = UiMath.shade(fillArgb, -0.2);
            g.fillGradient(x + 1, y + 1, x + 1 + fw, y + h - 1, UiMath.withAlpha(top, alpha), UiMath.withAlpha(bot, alpha));
            if (fw < w - 2) g.fill(x + fw, y + 1, x + 1 + fw, y + h - 1, UiMath.withAlpha(0xFFFFFFFF, 0.55 * alpha));
        }
        if (segments > 1) {
            for (int i = 1; i < segments; i++) {
                int sx = x + 1 + (w - 2) * i / segments;
                g.fill(sx, y + 1, sx + 1, y + h - 1, UiMath.withAlpha(0x60000000, alpha));
            }
        }
    }

    /** Animated striped "working" bar for unknown progress. */
    public static void busyBar(DrawContext g, int x, int y, int w, int h, int argb, long now, double alpha) {
        g.fill(x, y, x + w, y + h, UiMath.withAlpha(0xC0000000, alpha));
        int seg = Math.max(8, w / 4);
        int off = (int) ((now / 12) % (w + seg)) - seg;
        int a = Math.max(x + 1, x + off), b = Math.min(x + w - 1, x + off + seg);
        if (b > a) g.fillGradient(a, y + 1, b, y + h - 1, UiMath.withAlpha(argb, alpha), UiMath.withAlpha(UiMath.shade(argb, -0.3), alpha));
    }

    /**
     * Direction arrow (a chevron) centred at cx,cy pointing {@code deg} clockwise from up.
     */
    public static void arrow(DrawContext g, float cx, float cy, float deg, int size, int argb) {
        var m = g.getMatrices();
        m.push();
        m.translate(cx, cy, 0);
        m.multiply(RotationAxis.POSITIVE_Z.rotationDegrees(deg));
        int s = Math.max(3, size);
        // stacked rows forming a triangle pointing up
        for (int i = 0; i < s; i++) {
            int half = i / 2 + (i > 0 ? 1 : 0);
            g.fill(-half, -s / 2 + i, half + 1, -s / 2 + i + 1, argb);
        }
        // notch
        g.fill(-s / 4, s / 2 - 1, s / 4 + 1, s / 2, UiMath.withAlpha(argb, 0.0));
        m.pop();
    }

    /** Small pulsing dot (status lights). */
    public static void dot(DrawContext g, int x, int y, int argb, long now, boolean pulse) {
        double p = pulse ? 0.55 + 0.45 * Math.sin(now / 220.0) : 1;
        g.fill(x - 1, y - 1, x + 3, y + 3, UiMath.withAlpha(argb, 0.25 * p));
        g.fill(x, y, x + 2, y + 2, UiMath.withAlpha(argb, p));
    }

    // ---------------------------------------------------------------- text

    public static int text(DrawContext g, TextRenderer tr, String s, int x, int y, int argb) {
        return g.drawText(tr, s, x, y, argb, true);
    }

    /** Text with an alpha multiplier; skips drawing when nearly invisible (MC drops low-alpha text badly). */
    public static void textA(DrawContext g, TextRenderer tr, String s, int x, int y, int argb, double alpha) {
        int c = UiMath.withAlpha(argb, alpha);
        if (((c >>> 24) & 0xFF) < 8) return;
        g.drawText(tr, s, x, y, c, true);
    }

    /** Builds a styled Text from terminal segments ({@code alpha} applied to colours). */
    public static Text styled(List<TermLine.Seg> segs) {
        MutableText out = Text.empty();
        for (TermLine.Seg s : segs) {
            Style st = Style.EMPTY.withColor(s.argb() & 0xFFFFFF);
            if (s.bold()) st = st.withBold(true);
            if (s.italic()) st = st.withItalic(true);
            out.append(Text.literal(s.text()).setStyle(st));
        }
        return out;
    }

    public static int width(TextRenderer tr, TermLine.Seg seg, String s) {
        if (!seg.bold()) return tr.getWidth(s);
        return tr.getWidth(Text.literal(s).setStyle(Style.EMPTY.withBold(true)));
    }

    /** Draws segments left to right; returns the end x. */
    public static int segs(DrawContext g, TextRenderer tr, List<TermLine.Seg> segs, int x, int y, double alpha, boolean shadow) {
        int cx = x;
        for (TermLine.Seg s : segs) {
            if (s.text().isEmpty()) continue;
            int c = UiMath.withAlpha(s.argb(), alpha);
            if (((c >>> 24) & 0xFF) < 8) {
                cx += width(tr, s, s.text());
                continue;
            }
            Text t = Text.literal(s.text()).setStyle(styleOf(s));
            g.drawText(tr, t, cx, y, c, shadow);
            cx += tr.getWidth(t);
        }
        return cx;
    }

    private static Style styleOf(TermLine.Seg s) {
        Style st = Style.EMPTY;
        if (s.bold()) st = st.withBold(true);
        if (s.italic()) st = st.withItalic(true);
        return st;
    }

    /** Trims to fit {@code maxW} px with an ellipsis. */
    public static String fit(TextRenderer tr, String s, int maxW) {
        if (s == null) return "";
        if (tr.getWidth(s) <= maxW) return s;
        String e = "…";
        return tr.trimToWidth(s, Math.max(0, maxW - tr.getWidth(e))) + e;
    }

    // ---------------------------------------------------------------- items

    private static final Map<String, ItemStack> ICONS = new HashMap<>();

    /** ItemStack for an id like "iron_pickaxe" / "minecraft:oak_log"; air → empty. Cached. */
    public static ItemStack stack(String id) {
        if (id == null || id.isBlank()) return ItemStack.EMPTY;
        return ICONS.computeIfAbsent(id, k -> {
            try {
                Identifier ident = k.contains(":") ? Identifier.of(k) : Identifier.of("minecraft", k);
                Item item = Registries.ITEM.get(ident);
                if (item == Items.AIR) return ItemStack.EMPTY;
                return new ItemStack(item);
            } catch (RuntimeException e) {
                return ItemStack.EMPTY;
            }
        });
    }

    /** Item icon scaled to {@code size} px (16 = normal). */
    public static void item(DrawContext g, String id, int x, int y, int size) {
        ItemStack st = stack(id);
        if (st.isEmpty()) return;
        if (size == 16) {
            g.drawItem(st, x, y);
            return;
        }
        var m = g.getMatrices();
        m.push();
        m.translate(x, y, 0);
        float s = size / 16f;
        m.scale(s, s, 1);
        g.drawItem(st, 0, 0);
        m.pop();
    }

    public static MinecraftClient mc() {
        return MinecraftClient.getInstance();
    }
}
