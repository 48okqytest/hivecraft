package com.hivecraft.overlay.screen;

import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveState;
import com.hivecraft.overlay.ui.HiveUI;
import com.hivecraft.overlay.ui.UiConfig;
import com.hivecraft.overlay.ui.draw.Gfx;
import com.hivecraft.overlay.ui.term.LineEditor;
import com.hivecraft.overlay.ui.term.Scrollback;
import com.hivecraft.overlay.ui.term.TabCompleter;
import com.hivecraft.overlay.ui.term.TermLine;
import com.hivecraft.overlay.ui.term.TerminalController;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayList;
import java.util.List;

/**
 * Drop-down retro terminal (Quake-console style): phosphor-green prompt on a dark CRT panel with
 * scanlines, coloured scrollback, blinking block cursor, history, tab completion with a candidate
 * strip, clickable output, chat-to-team mode. Commands go to the bridge via the controller.
 */
public final class TerminalScreen extends Screen {
    private static final int ROW = 10;
    private static final int PAD = 6;
    private static final int PHOSPHOR = 0xFF39FF88;
    private static final int PHOSPHOR_DIM = 0xFF1F8F4E;
    private static final int CHAT_CYAN = 0xFF4FE3FF;

    private final TerminalController term;
    private final LineEditor editor = new LineEditor(256);
    private final long openedAt = System.currentTimeMillis();
    private long closingAt = 0;
    private long lastKeyAt = System.currentTimeMillis();
    private List<String> candidates = List.of();
    private String candidateCurrent = null;
    /** Clickable output segments of the last frame. */
    private final List<Hit> hits = new ArrayList<>();
    /** Swallow the char event of the key that opened us (the ` key also types a character). */
    private boolean swallowOpenChar = true;
    private boolean closed = false;

    private record Hit(int x, int y, int w, int h, String command) {}

    public TerminalScreen(TerminalController term) {
        super(Text.literal("Hivecraft Terminal"));
        this.term = term;
    }

    @Override
    protected void init() {
        term.greetOnce(HiveUI.version());
    }

    @Override
    public boolean shouldPause() {
        return false;
    }

    @Override
    public void renderBackground(DrawContext g, int mouseX, int mouseY, float delta) {
        // no blur / dirt: the game stays visible below the console
    }

    // ------------------------------------------------------------------ geometry

    private int consoleHeight() {
        return Math.max(120, (int) (height * 0.62));
    }

    /** 0..1 slide amount (open animation, close animation). */
    private double slide(long now) {
        if (closingAt > 0) return 1 - UiMath.easeOutCubic((now - closingAt) / 140.0);
        return UiMath.easeOutCubic((now - openedAt) / 180.0);
    }

    // ------------------------------------------------------------------ render

    @Override
    public void render(DrawContext g, int mouseX, int mouseY, float delta) {
        long now = System.currentTimeMillis();
        if (closingAt > 0 && now - closingAt >= 140) {
            if (!closed) {
                closed = true;
                client.execute(() -> { if (client.currentScreen == this) TerminalScreen.super.close(); });
            }
            return;
        }
        term.drain();
        UiConfig cfg = UiConfig.get();
        int ch = consoleHeight();
        int top = (int) Math.round(-ch * (1 - slide(now)));
        int bottom = top + ch;
        int w = width;

        // backdrop: slight dim of the game under the console
        g.fill(0, 0, width, height, UiMath.rgbA(0x000000, (int) (60 * slide(now))));
        // body
        int bodyA = (int) (255 * cfg.terminalOpacity);
        g.fillGradient(0, top, w, bottom, UiMath.rgbA(0x07140D, bodyA), UiMath.rgbA(0x030806, bodyA));
        // phosphor edge + glow
        g.fill(0, bottom - 1, w, bottom, PHOSPHOR_DIM);
        g.fillGradient(0, bottom, w, bottom + 6, 0x5539FF88, 0x0039FF88);

        // title bar
        int tb = 13;
        g.fill(0, top, w, top + tb, 0xEE0B2216);
        g.fill(0, top + tb, w, top + tb + 1, 0xFF1A5A35);
        Gfx.text(g, textRenderer, "HIVECRAFT", PAD, top + 3, Gfx.GOLD);
        String tty = " TERMINAL · tty0";
        Gfx.text(g, textRenderer, tty, PAD + textRenderer.getWidth("HIVECRAFT"), top + 3, PHOSPHOR_DIM);
        drawTitleStatus(g, w, top + 3, now);

        // scrollback area
        int areaTop = top + tb + 4;
        int inputY = bottom - 14;
        int candY = inputY - 11;
        boolean showCands = candidates.size() > 1;
        int areaBottom = (showCands ? candY : inputY) - 3;
        int rows = Math.max(1, (areaBottom - areaTop) / ROW);
        int textW = w - PAD * 2 - 6;
        Scrollback sb = term.scrollback();
        Scrollback.Measurer mm = (seg, s) -> Gfx.width(textRenderer, seg, s);
        List<Scrollback.Row> vis = sb.visible(textW, rows, mm);
        hits.clear();
        int y = areaBottom - vis.size() * ROW;
        for (Scrollback.Row r : vis) {
            int x = PAD;
            for (TermLine.Seg s : r.segs()) {
                if (s.text().isEmpty()) continue;
                int sw = Gfx.width(textRenderer, s, s.text());
                boolean hover = s.click() != null && mouseX >= x && mouseX < x + sw && mouseY >= y && mouseY < y + ROW;
                if (s.click() != null) {
                    hits.add(new Hit(x, y, sw, ROW, s.click()));
                    g.fill(x, y + 9, x + sw, y + 10, hover ? 0xFF39FF88 : 0x6039FF88);
                }
                List<TermLine.Seg> one = List.of(hover ? new TermLine.Seg(s.text(), 0xFFFFFFFF, s.bold(), s.italic(), s.click()) : s);
                Gfx.segs(g, textRenderer, one, x, y + 1, 1, true);
                x += sw;
            }
            y += ROW;
        }
        // scrollbar
        int total = sb.rows(textW, mm).size();
        if (total > rows) {
            int trackH = areaBottom - areaTop;
            int thumbH = Math.max(8, trackH * rows / total);
            int maxScroll = total - rows;
            int thumbY = areaTop + (int) ((trackH - thumbH) * (1 - sb.scroll() / (double) maxScroll));
            g.fill(w - 4, areaTop, w - 2, areaBottom, 0x3039FF88);
            g.fill(w - 4, thumbY, w - 2, thumbY + thumbH, 0xC039FF88);
            if (sb.scroll() > 0) {
                String more = "▼ " + sb.scroll() + " more";
                int mw = textRenderer.getWidth(more);
                g.fill(w - mw - 14, areaBottom - 11, w - 7, areaBottom - 1, 0xC0081A10);
                Gfx.text(g, textRenderer, more, w - mw - 10, areaBottom - 10, PHOSPHOR);
            }
        }

        // candidates strip
        if (showCands) {
            int x = PAD;
            for (String c : candidates) {
                int cw = textRenderer.getWidth(c) + 6;
                if (x + cw > w - PAD) {
                    Gfx.text(g, textRenderer, "…", x, candY + 1, PHOSPHOR_DIM);
                    break;
                }
                boolean cur = c.equals(candidateCurrent);
                g.fill(x, candY, x + cw, candY + 10, cur ? 0xFF1F8F4E : 0x601F8F4E);
                Gfx.text(g, textRenderer, c, x + 3, candY + 1, cur ? 0xFF001A0A : PHOSPHOR);
                x += cw + 3;
            }
        }

        // input line
        g.fill(0, inputY - 2, w, bottom - 1, 0x60000000);
        boolean chat = term.mode() == TerminalController.Mode.CHAT;
        int promptColor = chat ? CHAT_CYAN : PHOSPHOR;
        String prompt = term.prompt();
        int px = PAD;
        Gfx.text(g, textRenderer, prompt, px, inputY + 1, promptColor);
        int ix = px + textRenderer.getWidth(prompt);
        String text = editor.text();
        int avail = w - ix - PAD - 8;
        // horizontal scroll so the cursor stays visible
        String before = text.substring(0, editor.cursor());
        int start = 0;
        while (start < before.length() && textRenderer.getWidth(text.substring(start, editor.cursor())) > avail) start++;
        String shown = textRenderer.trimToWidth(text.substring(start), avail);
        Gfx.text(g, textRenderer, shown, ix, inputY + 1, 0xFFE8FFE8);
        int cx = ix + textRenderer.getWidth(text.substring(start, editor.cursor()));
        boolean blinkOn = (now - lastKeyAt) < 500 || ((now / 530) % 2 == 0);
        if (blinkOn) {
            String under = editor.cursor() < text.length() ? String.valueOf(text.charAt(editor.cursor())) : " ";
            int cw = Math.max(5, textRenderer.getWidth(under));
            g.fill(cx, inputY, cx + cw, inputY + 10, promptColor);
            if (!under.isBlank()) g.drawText(textRenderer, under, cx, inputY + 1, 0xFF00140A, false);
        }
        // hint on the right
        if (text.isEmpty()) {
            String hint = chat ? "talking to " + term.chatTarget() + " · /exit leaves chat" : "Tab completes · ↑↓ history · Ctrl+T chat";
            int hw = textRenderer.getWidth(hint);
            if (ix + 12 + hw < w - PAD) Gfx.text(g, textRenderer, hint, w - PAD - hw, inputY + 1, PHOSPHOR_DIM);
        }
        if (term.busy()) {
            String[] spin = {"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"};
            String s = spin[(int) ((now / 80) % spin.length)];
            Gfx.text(g, textRenderer, s, w - PAD - 6, inputY + 1, PHOSPHOR);
        }

        // CRT effect: scanlines + faint vignette
        if (cfg.crt) {
            for (int sy = top; sy < bottom; sy += 2) g.fill(0, sy, w, sy + 1, 0x12000000);
            int roll = (int) ((now / 18) % (ch + 40)) - 20;
            g.fillGradient(0, top + roll, w, top + roll + 14, 0x0039FF88, 0x0A39FF88);
            g.fillGradient(0, top, 18, bottom, 0x30000000, 0x00000000);
        }
    }

    private void drawTitleStatus(DrawContext g, int w, int y, long now) {
        HiveState st = Hive.state();
        String s;
        int c;
        switch (st.connection()) {
            case ONLINE -> {
                int on = 0;
                for (var b : st.bots()) if (b.online()) on++;
                s = "● connected · " + on + "/" + st.bots().size() + " bots";
                c = PHOSPHOR;
            }
            case CONNECTING -> { s = "◌ connecting…"; c = Gfx.WARN; }
            default -> { s = "○ offline (commands use HTTP)"; c = Gfx.BAD; }
        }
        int sw = textRenderer.getWidth(s);
        Gfx.text(g, textRenderer, s, w - PAD - sw, y, c);
    }

    // ------------------------------------------------------------------ input

    @Override
    public boolean keyPressed(int key, int scan, int mods) {
        lastKeyAt = System.currentTimeMillis();
        swallowOpenChar = false;
        boolean ctrl = hasControlDown(), shift = hasShiftDown();
        if (key == GLFW.GLFW_KEY_ESCAPE || HiveUI.keys().terminal.matchesKey(key, scan) && editor.text().isEmpty()) {
            if (key != GLFW.GLFW_KEY_ESCAPE) swallowOpenChar = true; // the close key's char must not leak
            close();
            return true;
        }
        if (key != GLFW.GLFW_KEY_TAB && key != GLFW.GLFW_KEY_LEFT_SHIFT && key != GLFW.GLFW_KEY_RIGHT_SHIFT) {
            term.edited();
            candidates = List.of();
        }
        int rows = Math.max(1, (consoleHeight() - 40) / ROW);
        switch (key) {
            case GLFW.GLFW_KEY_ENTER, GLFW.GLFW_KEY_KP_ENTER -> {
                editor.set(term.submit(editor.text()));
                return true;
            }
            case GLFW.GLFW_KEY_TAB -> {
                TabCompleter.Result r = term.tab(editor.text(), editor.cursor(), shift);
                if (r.changed()) editor.set(r.text(), r.cursor());
                candidates = r.candidates();
                candidateCurrent = currentWord(r.text(), r.cursor());
                if (!r.changed() && r.candidates().isEmpty()) beep();
                return true;
            }
            case GLFW.GLFW_KEY_UP -> {
                if (ctrl) term.scrollback().scrollBy(1, rows);
                else editor.set(term.historyUp(editor.text()));
                return true;
            }
            case GLFW.GLFW_KEY_DOWN -> {
                if (ctrl) term.scrollback().scrollBy(-1, rows);
                else editor.set(term.historyDown(editor.text()));
                return true;
            }
            case GLFW.GLFW_KEY_PAGE_UP -> { term.scrollback().scrollBy(rows - 1, rows); return true; }
            case GLFW.GLFW_KEY_PAGE_DOWN -> { term.scrollback().scrollBy(-(rows - 1), rows); return true; }
            case GLFW.GLFW_KEY_LEFT -> { if (ctrl) editor.jumpWordLeft(); else editor.left(); return true; }
            case GLFW.GLFW_KEY_RIGHT -> { if (ctrl) editor.jumpWordRight(); else editor.right(); return true; }
            case GLFW.GLFW_KEY_HOME -> {
                if (ctrl) term.scrollback().scrollToTop(rows); else editor.home();
                return true;
            }
            case GLFW.GLFW_KEY_END -> {
                if (ctrl) term.scrollback().scrollToBottom(); else editor.end();
                return true;
            }
            case GLFW.GLFW_KEY_BACKSPACE -> { if (ctrl) editor.deleteWordLeft(); else editor.backspace(); return true; }
            case GLFW.GLFW_KEY_DELETE -> { if (ctrl) editor.deleteWordRight(); else editor.delete(); return true; }
            default -> {}
        }
        if (ctrl) {
            switch (key) {
                case GLFW.GLFW_KEY_V -> { editor.insert(client.keyboard.getClipboard()); return true; }
                case GLFW.GLFW_KEY_C -> {
                    if (!editor.text().isEmpty()) {
                        term.post(TermLine.of(TermLine.seg(term.prompt(), PHOSPHOR_DIM), TermLine.seg(editor.text() + "^C", Gfx.FAINT)));
                        editor.clear();
                    }
                    return true;
                }
                case GLFW.GLFW_KEY_L -> { term.scrollback().clear(); return true; }
                case GLFW.GLFW_KEY_U -> { editor.killToStart(); return true; }
                case GLFW.GLFW_KEY_K -> { editor.killToEnd(); return true; }
                case GLFW.GLFW_KEY_W -> { editor.deleteWordLeft(); return true; }
                case GLFW.GLFW_KEY_A -> { editor.home(); return true; }
                case GLFW.GLFW_KEY_E -> { editor.end(); return true; }
                case GLFW.GLFW_KEY_T -> { term.toggleChatMode(); return true; }
                default -> {}
            }
        }
        return super.keyPressed(key, scan, mods);
    }

    @Override
    public boolean charTyped(char chr, int mods) {
        if (swallowOpenChar && (System.currentTimeMillis() - openedAt < 250 || closingAt > 0)) {
            swallowOpenChar = false;
            return true; // the char of the key that opened/closed the console
        }
        swallowOpenChar = false;
        if (closingAt > 0) return true;
        lastKeyAt = System.currentTimeMillis();
        if (chr >= 32 && chr != 127) {
            editor.insert(String.valueOf(chr));
            term.edited();
            candidates = List.of();
            if (term.history().isBrowsing()) term.history().resetCursor();
            return true;
        }
        return false;
    }

    @Override
    public boolean mouseScrolled(double mx, double my, double h, double v) {
        int rows = Math.max(1, (consoleHeight() - 40) / ROW);
        term.scrollback().scrollBy((int) Math.signum(v) * 3, rows);
        return true;
    }

    @Override
    public boolean mouseClicked(double mx, double my, int button) {
        if (button == 0) {
            for (Hit h : hits) {
                if (mx >= h.x && mx < h.x + h.w && my >= h.y && my < h.y + h.h) {
                    if (h.command.startsWith("photo ")) { // open the picture in the album
                        com.hivecraft.overlay.screen.tabs.AlbumTab.openRequest = h.command.substring(6).trim();
                        client.setScreen(new ControlScreen(ControlScreen.TAB_ALBUM));
                        return true;
                    }
                    term.scrollback().scrollToBottom();
                    term.post(TermLine.of(TermLine.seg(term.prompt(), PHOSPHOR), TermLine.seg(h.command, Gfx.TEXT)));
                    term.history().add(h.command);
                    term.runCommand(h.command);
                    return true;
                }
            }
            // click below the console closes it
            if (my > consoleHeight() + 6) {
                close();
                return true;
            }
        }
        return super.mouseClicked(mx, my, button);
    }

    @Override
    public void close() {
        if (closingAt == 0) closingAt = System.currentTimeMillis();
    }

    @Override
    public void removed() {
        HiveUI.saveHistory();
    }

    /** Immediate close (when another screen replaces us). */
    public void closeNow() {
        super.close();
    }

    private static String currentWord(String text, int cursor) {
        String b = text.substring(0, Math.min(cursor, text.length()));
        int s = b.lastIndexOf(' ') + 1;
        return b.substring(s).replaceFirst("^/", "").replaceFirst("^@", "");
    }

    private void beep() {
        // visual bell: flash handled by lastKeyAt; no sound (quiet UIs by design)
    }
}
