package com.hivecraft.overlay.ui.hud;

import com.hivecraft.overlay.ui.term.TermLine;
import com.hivecraft.overlay.ui.util.UiMath;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * Live event ticker model: short coloured lines that fade in, hold and fade out. Repeated block
 * events merge ("Ash placed 12 oak planks" counts up instead of 12 lines). Thread-safe (all methods
 * synchronized); network threads push, the render thread reads {@link #visible(long)}. Pure logic.
 */
public final class Ticker {

    public enum Kind { CHAT, BLOCKS, TASK, DEATH, EVENT, GOAL, PHOTO, SYSTEM }

    public static final class Entry {
        public final Kind kind;
        public final String mergeKey;  // non-null for mergeable entries
        public final int accent;       // ARGB accent (bot colour)
        public final String icon;      // item id to draw (may be null)
        public final long born;
        public long touched;           // last update (refreshes the hold time)
        public int count;
        public List<TermLine.Seg> segs;

        Entry(Kind kind, String mergeKey, int accent, String icon, long now, int count, List<TermLine.Seg> segs) {
            this.kind = kind;
            this.mergeKey = mergeKey;
            this.accent = accent;
            this.icon = icon;
            this.born = now;
            this.touched = now;
            this.count = count;
            this.segs = segs;
        }

        /** 0..1 opacity at {@code now}. */
        public double alpha(long now, long life) {
            double in = UiMath.clamp01((now - born) / (double) FADE_IN);
            long left = touched + life - now;
            double out = UiMath.clamp01(left / (double) FADE_OUT);
            return Math.min(in, out);
        }

        public String plain() {
            StringBuilder sb = new StringBuilder();
            for (TermLine.Seg s : segs) sb.append(s.text());
            return sb.toString();
        }
    }

    public static final long FADE_IN = 250, FADE_OUT = 1500;
    /** Merge window: a block event within this long of the last one for the same key adds to it. */
    public static final long MERGE_MS = 6000;

    private final List<Entry> entries = new ArrayList<>();
    private final int max;
    private long lifeMs;

    public Ticker(int max, long lifeMs) {
        this.max = Math.max(1, max);
        this.lifeMs = lifeMs;
    }

    public synchronized void setLife(long ms) { this.lifeMs = Math.max(2000, ms); }
    public synchronized long life() { return lifeMs; }

    public synchronized Entry push(Kind kind, int accent, String icon, long now, List<TermLine.Seg> segs) {
        Entry e = new Entry(kind, null, accent, icon, now, 1, segs);
        entries.add(e);
        trim();
        return e;
    }

    /**
     * Block placed/broken. Merges with a live entry for the same bot+verb+block:
     * "Ash placed 12 oak planks".
     */
    public synchronized Entry blocks(String bot, int accent, String verb, String block, int n, long now) {
        String key = bot + "|" + verb + "|" + block;
        for (int i = entries.size() - 1; i >= 0; i--) {
            Entry e = entries.get(i);
            if (key.equals(e.mergeKey) && now - e.touched <= MERGE_MS) {
                e.count += n;
                e.touched = now;
                e.segs = blockSegs(bot, accent, verb, block, e.count);
                // move to the newest position so it stays visible
                entries.remove(i);
                entries.add(e);
                return e;
            }
        }
        Entry e = new Entry(Kind.BLOCKS, key, accent, block, now, n, blockSegs(bot, accent, verb, block, n));
        entries.add(e);
        trim();
        return e;
    }

    static List<TermLine.Seg> blockSegs(String bot, int accent, String verb, String block, int count) {
        List<TermLine.Seg> l = new ArrayList<>();
        l.add(TermLine.seg(bot, 0xFF000000 | accent));
        l.add(TermLine.seg(" " + verb + " ", 0xFFB8BEC8));
        l.add(TermLine.seg(String.valueOf(count), 0xFFFFFFFF));
        l.add(TermLine.seg(" " + UiMath.prettyId(block), 0xFFE0E0E0));
        return l;
    }

    /** Live entries, oldest first, dropping expired ones. */
    public synchronized List<Entry> visible(long now) {
        Iterator<Entry> it = entries.iterator();
        while (it.hasNext()) {
            Entry e = it.next();
            if (now - e.touched >= lifeMs) it.remove();
        }
        return new ArrayList<>(entries);
    }

    public synchronized int size() { return entries.size(); }

    public synchronized void clear() { entries.clear(); }

    private void trim() {
        while (entries.size() > max) entries.remove(0);
    }
}
