package com.hivecraft.overlay.ui.term;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * Terminal scrollback: stores logical lines, wraps them to the view width with a pluggable text
 * measurer, and tracks a scroll offset counted in wrapped rows from the bottom (0 = following the
 * newest output). When scrolled up, new output keeps the view where it is. Pure logic.
 */
public final class Scrollback {

    /** Pixel width of {@code text} drawn with the style of {@code seg}. */
    @FunctionalInterface
    public interface Measurer {
        int width(TermLine.Seg seg, String text);
    }

    /** One wrapped screen row. {@code first} = first row of its logical line. */
    public record Row(List<TermLine.Seg> segs, boolean first, long ts) {}

    private final int maxLines;
    private final Deque<TermLine> lines = new ArrayDeque<>();
    private List<Row> rows = new ArrayList<>();
    private int rowsWidth = -1;
    private boolean dirty = true;
    private int scroll = 0; // rows from bottom
    private int addedWhileScrolled = 0;

    public Scrollback(int maxLines) {
        this.maxLines = Math.max(10, maxLines);
    }

    public void add(TermLine line) {
        lines.addLast(line);
        while (lines.size() > maxLines) lines.removeFirst();
        // when scrolled up, keep the view anchored on what the user is reading
        if (scroll > 0) addedWhileScrolled++;
        dirty = true;
    }

    public void clear() {
        lines.clear();
        rows = new ArrayList<>();
        scroll = 0;
        addedWhileScrolled = 0;
        dirty = true;
    }

    public int lineCount() {
        return lines.size();
    }

    public List<TermLine> lines() {
        return new ArrayList<>(lines);
    }

    /** Wrapped rows for {@code width} px. Cached until lines or width change. */
    public List<Row> rows(int width, Measurer m) {
        if (dirty || width != rowsWidth) {
            List<Row> out = new ArrayList<>();
            int n = lines.size(), i = 0, newRows = 0;
            int firstNew = n - Math.min(addedWhileScrolled, n);
            for (TermLine l : lines) {
                List<Row> w = wrap(l, width, m);
                if (i++ >= firstNew) newRows += w.size();
                out.addAll(w);
            }
            if (addedWhileScrolled > 0 && scroll > 0) scroll += newRows;
            addedWhileScrolled = 0;
            rows = out;
            rowsWidth = width;
            dirty = false;
        }
        return rows;
    }

    public int scroll() {
        return scroll;
    }

    /** Scroll by {@code delta} rows (positive = up/older), clamped so a full page stays visible. */
    public void scrollBy(int delta, int visibleRows) {
        int max = Math.max(0, rows.size() - visibleRows);
        scroll = Math.max(0, Math.min(max, scroll + delta));
    }

    public void scrollToBottom() {
        scroll = 0;
        addedWhileScrolled = 0;
    }

    public void scrollToTop(int visibleRows) {
        scroll = Math.max(0, rows.size() - visibleRows);
    }

    /** The rows visible in a view of {@code visibleRows}, oldest first. */
    public List<Row> visible(int width, int visibleRows, Measurer m) {
        List<Row> all = rows(width, m);
        int max = Math.max(0, all.size() - visibleRows);
        if (scroll > max) scroll = max;
        int end = all.size() - scroll;
        int start = Math.max(0, end - visibleRows);
        return all.subList(start, end);
    }

    /** Word-wrap one logical line into rows no wider than {@code width} (hard-breaks long words). */
    public static List<Row> wrap(TermLine line, int width, Measurer m) {
        List<Row> out = new ArrayList<>();
        List<TermLine.Seg> cur = new ArrayList<>();
        int curW = 0;
        boolean first = true;
        width = Math.max(8, width);
        for (TermLine.Seg seg : line.segs()) {
            String[] parts = seg.text().split("\n", -1);
            for (int p = 0; p < parts.length; p++) {
                if (p > 0) { // explicit newline
                    out.add(new Row(cur, first, line.ts()));
                    first = false;
                    cur = new ArrayList<>();
                    curW = 0;
                }
                String rest = parts[p];
                while (!rest.isEmpty()) {
                    int room = width - curW;
                    int fit = fitChars(seg, rest, room, m);
                    if (fit >= rest.length()) {
                        cur.add(seg.withText(rest));
                        curW += m.width(seg, rest);
                        break;
                    }
                    // break at the last space that fits; else move the word down; else hard-break
                    int brk = rest.lastIndexOf(' ', fit);
                    int take;
                    if (brk > 0) take = brk;
                    else if (curW > 0) take = 0;
                    else take = Math.max(1, fit);
                    if (take > 0) cur.add(seg.withText(rest.substring(0, take)));
                    out.add(new Row(cur, first, line.ts()));
                    first = false;
                    cur = new ArrayList<>();
                    curW = 0;
                    rest = rest.substring(take);
                    if (rest.startsWith(" ")) rest = rest.substring(1); // eat the break space
                }
            }
        }
        out.add(new Row(cur, first, line.ts()));
        return out;
    }

    /** How many leading chars of {@code s} fit into {@code room} px. */
    static int fitChars(TermLine.Seg seg, String s, int room, Measurer m) {
        if (room <= 0) return 0;
        if (m.width(seg, s) <= room) return s.length();
        int lo = 0, hi = s.length();
        while (lo < hi) {
            int mid = (lo + hi + 1) >>> 1;
            if (m.width(seg, s.substring(0, mid)) <= room) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }
}
