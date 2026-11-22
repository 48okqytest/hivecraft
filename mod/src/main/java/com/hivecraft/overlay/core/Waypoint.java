package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

/** A team waypoint (base, base_chest, mines...). dim: overworld | nether | end. */
public record Waypoint(String name, int x, int y, int z, String by, String note, String dim) {
    public static Waypoint parse(JsonObject o) {
        String dim = J.str(o, "dimension", J.str(o, "dim", "overworld"));
        return new Waypoint(J.str(o, "name", "?"), (int) Math.floor(J.num(o, "x", 0)), (int) Math.floor(J.num(o, "y", 0)),
                (int) Math.floor(J.num(o, "z", 0)), J.str(o, "by", ""), J.str(o, "note", ""), Dims.normalize(dim));
    }
}
