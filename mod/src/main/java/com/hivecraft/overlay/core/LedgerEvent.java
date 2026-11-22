package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

/**
 * A block placed/broken by a bot. op: place | break. For break, block/state = what was there; for place, prev = what was there.
 * cause: collect | mine | place | blueprint | scaffold | pathfinder-dig | pathfinder-place | auto | code | (action name).
 * build/section/phase only for blueprint work (section = -1 when absent). block ids have no "minecraft:" prefix.
 */
public record LedgerEvent(long id, long ts, String bot, String op, String block, String state, String prev,
                          int x, int y, int z, String dim, String cause, String action,
                          String build, int section, String phase) {
    public static LedgerEvent parse(JsonObject o) {
        return new LedgerEvent(J.lng(o, "id", -1), J.lng(o, "ts", 0), J.str(o, "bot", "?"), J.str(o, "op", "place"),
                J.str(o, "block", "air"), J.str(o, "state", ""), J.str(o, "prev"),
                (int) Math.floor(J.num(o, "x", 0)), (int) Math.floor(J.num(o, "y", 0)), (int) Math.floor(J.num(o, "z", 0)),
                Dims.normalize(J.str(o, "dim")),
                J.str(o, "cause", ""), J.str(o, "action"), J.str(o, "build"), J.integer(o, "section", -1), J.str(o, "phase"));
    }

    public boolean isPlace() { return "place".equals(op); }
    public boolean isBreak() { return "break".equals(op); }
    public long posKey() { return PosKey.pack(x, y, z); }
}
