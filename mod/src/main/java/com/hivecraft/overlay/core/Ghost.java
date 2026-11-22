package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * A planned (kind "preview") or running (kind "build") blueprint. Immutable; updates produce new instances.
 * progress is 0..100. bounds are always filled (computed from blocks/origin when the server omits them).
 */
public final class Ghost {
    private final String id, kind, blueprint, bot, dim;
    private final List<String> bots;
    private final int ox, oy, oz, rotation;
    private final int minX, minY, minZ, maxX, maxY, maxZ;
    private final int total, done, remaining, progress;
    private final boolean finished, truncated;
    private final long updated, expires, rev;
    private final List<GhostBlock> blocks;
    private final Map<Long, Integer> index;

    private Ghost(String id, String kind, String blueprint, String bot, String dim, List<String> bots,
                  int ox, int oy, int oz, int rotation, int[] bounds, int total, int done, int remaining, int progress,
                  boolean finished, boolean truncated, long updated, long expires, long rev, List<GhostBlock> blocks) {
        this.id = id; this.kind = kind; this.blueprint = blueprint; this.bot = bot; this.dim = dim; this.bots = bots;
        this.ox = ox; this.oy = oy; this.oz = oz; this.rotation = rotation;
        this.minX = bounds[0]; this.minY = bounds[1]; this.minZ = bounds[2];
        this.maxX = bounds[3]; this.maxY = bounds[4]; this.maxZ = bounds[5];
        this.total = total; this.done = done; this.remaining = remaining; this.progress = progress;
        this.finished = finished; this.truncated = truncated; this.updated = updated; this.expires = expires; this.rev = rev;
        this.blocks = blocks;
        Map<Long, Integer> idx = new HashMap<>(blocks.size() * 2);
        for (int i = 0; i < blocks.size(); i++) idx.put(blocks.get(i).posKey(), i);
        this.index = idx;
    }

    /**
     * Parses a ghost summary. If the message omits {@code blocks} (rev unchanged), the blocks of {@code prev} are kept.
     */
    public static Ghost parse(JsonObject o, Ghost prev) {
        String id = J.str(o, "id", "?");
        JsonObject origin = J.obj(o, "origin");
        int ox = (int) Math.floor(J.num(origin, "x", 0)), oy = (int) Math.floor(J.num(origin, "y", 0)), oz = (int) Math.floor(J.num(origin, "z", 0));
        List<String> bots = new ArrayList<>();
        JsonArray ba = J.arr(o, "bots");
        if (ba != null) for (var e : ba) if (e.isJsonPrimitive()) bots.add(e.getAsString());
        String bot = J.str(o, "bot");
        if (bots.isEmpty() && bot != null) bots.add(bot);

        List<GhostBlock> blocks;
        JsonArray bl = J.arr(o, "blocks");
        if (bl != null) {
            blocks = new ArrayList<>(bl.size());
            for (var e : bl) {
                GhostBlock b = GhostBlock.parse(J.arr(e));
                if (b != null) blocks.add(b);
            }
            blocks = Collections.unmodifiableList(blocks);
        } else {
            blocks = prev != null ? prev.blocks : List.of();
        }

        int[] bounds;
        JsonObject b = J.obj(o, "bounds");
        if (b != null) {
            bounds = new int[]{J.integer(b, "minX", ox), J.integer(b, "minY", oy), J.integer(b, "minZ", oz),
                    J.integer(b, "maxX", ox), J.integer(b, "maxY", oy), J.integer(b, "maxZ", oz)};
        } else {
            bounds = computeBounds(blocks, ox, oy, oz);
        }
        int total = J.integer(o, "total", blocks.size());
        int done = J.integer(o, "done", 0);
        int progress = J.integer(o, "progress", total > 0 ? Math.round(done * 100f / total) : 0);
        return new Ghost(id, J.str(o, "kind", "build"), J.str(o, "blueprint", ""), bot,
                Dims.normalize(J.str(o, "dim")), Collections.unmodifiableList(bots), ox, oy, oz, J.integer(o, "rotation", 0),
                bounds, total, done, J.integer(o, "remaining", Math.max(0, total - done)), progress,
                J.bool(o, "finished", false), J.bool(o, "truncated", false), J.lng(o, "updated", 0), J.lng(o, "expires", 0),
                J.lng(o, "rev", 0), blocks);
    }

    static int[] computeBounds(List<GhostBlock> blocks, int ox, int oy, int oz) {
        if (blocks.isEmpty()) return new int[]{ox, oy, oz, ox, oy, oz};
        int a = Integer.MAX_VALUE, b2 = Integer.MAX_VALUE, c = Integer.MAX_VALUE, d = Integer.MIN_VALUE, e = Integer.MIN_VALUE, f = Integer.MIN_VALUE;
        for (GhostBlock g : blocks) {
            a = Math.min(a, g.x()); b2 = Math.min(b2, g.y()); c = Math.min(c, g.z());
            d = Math.max(d, g.x()); e = Math.max(e, g.y()); f = Math.max(f, g.z());
        }
        return new int[]{a, b2, c, d, e, f};
    }

    /** Returns a copy with the cell at (x,y,z) marked placed/unplaced, done/progress adjusted; this if nothing changes. */
    public Ghost withPlaced(int x, int y, int z, boolean placed) {
        Integer i = index.get(PosKey.pack(x, y, z));
        if (i == null) return this;
        GhostBlock old = blocks.get(i);
        if (old.placed() == placed) return this;
        List<GhostBlock> nb = new ArrayList<>(blocks);
        nb.set(i, old.withPlaced(placed));
        int nd = Math.max(0, Math.min(total, done + (placed ? 1 : -1)));
        int np = total > 0 ? Math.round(nd * 100f / total) : progress;
        return new Ghost(id, kind, blueprint, bot, dim, bots, ox, oy, oz, rotation,
                new int[]{minX, minY, minZ, maxX, maxY, maxZ}, total, nd, Math.max(0, total - nd), np,
                finished, truncated, updated, expires, rev, Collections.unmodifiableList(nb));
    }

    /** The cell at (x,y,z) or null. */
    public GhostBlock blockAt(int x, int y, int z) {
        Integer i = index.get(PosKey.pack(x, y, z));
        return i == null ? null : blocks.get(i);
    }

    public boolean isPreview() { return "preview".equals(kind); }
    public String id() { return id; }
    public String kind() { return kind; }
    public String blueprint() { return blueprint; }
    public String bot() { return bot; }
    public List<String> bots() { return bots; }
    public String dim() { return dim; }
    public int originX() { return ox; }
    public int originY() { return oy; }
    public int originZ() { return oz; }
    public int rotation() { return rotation; }
    public int minX() { return minX; }
    public int minY() { return minY; }
    public int minZ() { return minZ; }
    public int maxX() { return maxX; }
    public int maxY() { return maxY; }
    public int maxZ() { return maxZ; }
    public int total() { return total; }
    public int done() { return done; }
    public int remaining() { return remaining; }
    /** 0..100 */
    public int progress() { return progress; }
    public boolean finished() { return finished; }
    public boolean truncated() { return truncated; }
    public long updated() { return updated; }
    /** Previews only: ms epoch when it disappears (0 = n/a). */
    public long expires() { return expires; }
    public long rev() { return rev; }
    public List<GhostBlock> blocks() { return blocks; }
}
