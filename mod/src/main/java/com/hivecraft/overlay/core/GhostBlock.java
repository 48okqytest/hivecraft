package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;

/**
 * One cell of a ghost build: wire row {@code [x, y, z, blockId, stateString, placed(0|1), tint?]}.
 * tint is null for builds; for previews: "ok" (free, cyan) | "conflict" (terrain in the way, red) | "done" (already there, green).
 */
public record GhostBlock(int x, int y, int z, String block, String state, boolean placed, String tint) {
    public static GhostBlock parse(JsonArray a) {
        if (a == null || a.size() < 4) return null;
        return new GhostBlock((int) Math.floor(J.at(a, 0, 0)), (int) Math.floor(J.at(a, 1, 0)), (int) Math.floor(J.at(a, 2, 0)),
                J.strAt(a, 3, "air"), J.strAt(a, 4, ""), J.at(a, 5, 0) != 0, J.strAt(a, 6, null));
    }

    public long posKey() { return PosKey.pack(x, y, z); }
    public boolean conflict() { return "conflict".equals(tint); }
    public GhostBlock withPlaced(boolean p) { return p == placed ? this : new GhostBlock(x, y, z, block, state, p, tint); }
}
