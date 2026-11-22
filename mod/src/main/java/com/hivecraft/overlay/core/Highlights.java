package com.hivecraft.overlay.core;

import java.util.ArrayList;
import java.util.List;

/**
 * Temporary in-world highlight boxes requested by the UI (e.g. "click to highlight" in the Ledger tab).
 * The world renderer draws them as pulsing outlines + a beam until they expire. Thread-safe.
 */
public final class Highlights {
    /** Inclusive block box. color 0xRRGGBB; label may be null. */
    public record Box(int minX, int minY, int minZ, int maxX, int maxY, int maxZ, String dim, int color,
                      String label, long createdAt, long until) {}

    public static final int MAX = 32;
    private final List<Box> boxes = new ArrayList<>();

    /** Highlights one block for {@code ms} milliseconds (yellow). */
    public void highlight(int x, int y, int z, String dim, long ms) {
        highlightBox(x, y, z, x, y, z, dim, ms, 0xFFE14D, null);
    }

    /** Highlights a box of blocks (inclusive corners, any order). */
    public synchronized void highlightBox(int x1, int y1, int z1, int x2, int y2, int z2, String dim, long ms, int color, String label) {
        long now = System.currentTimeMillis();
        boxes.add(new Box(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2), Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2),
                Dims.normalize(dim), color & 0xFFFFFF, label, now, now + Math.max(250, ms)));
        while (boxes.size() > MAX) boxes.remove(0);
    }

    /** Live boxes (expired ones are dropped). */
    public synchronized List<Box> active(long now) {
        boxes.removeIf(b -> b.until() < now);
        return List.copyOf(boxes);
    }

    public synchronized void clear() { boxes.clear(); }
}
