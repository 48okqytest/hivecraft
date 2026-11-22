package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The pathfinder's planned route for one bot. points are block coords {x,y,z} (render at x+0.5, y, z+0.5).
 * goal may be null. status: success | partial | timeout | noPath | cleared.
 */
public record PathInfo(String bot, String dim, int[] goal, List<int[]> points, String status, long ts) {
    public static PathInfo parse(JsonObject o) {
        JsonObject g = J.obj(o, "goal");
        int[] goal = g == null ? null : new int[]{
                (int) Math.floor(J.num(g, "x", 0)), (int) Math.floor(J.num(g, "y", 0)), (int) Math.floor(J.num(g, "z", 0))};
        List<int[]> pts = new ArrayList<>();
        JsonArray a = J.arr(o, "points");
        if (a != null) for (var e : a) {
            JsonArray p = J.arr(e);
            if (p != null && p.size() >= 3)
                pts.add(new int[]{(int) Math.floor(J.at(p, 0, 0)), (int) Math.floor(J.at(p, 1, 0)), (int) Math.floor(J.at(p, 2, 0))});
        }
        return new PathInfo(J.str(o, "bot", "?"), Dims.normalize(J.str(o, "dim")), goal,
                Collections.unmodifiableList(pts), J.str(o, "status", ""), J.lng(o, "ts", 0));
    }

    /** True when the path was cleared (arrived / stopped). */
    public boolean cleared() { return points.isEmpty(); }
}
