package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

/** The local player, pushed by the client thread each tick; look = crosshair block or null. */
public record PlayerInfo(String name, double x, double y, double z, String dim, float yaw, int[] look) {
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("name", name);
        o.addProperty("x", Math.round(x * 100) / 100.0);
        o.addProperty("y", Math.round(y * 100) / 100.0);
        o.addProperty("z", Math.round(z * 100) / 100.0);
        o.addProperty("dim", dim);
        o.addProperty("yaw", Math.round(yaw * 10) / 10.0);
        if (look != null) {
            JsonObject l = new JsonObject();
            l.addProperty("x", look[0]); l.addProperty("y", look[1]); l.addProperty("z", look[2]);
            o.add("look", l);
        }
        return o;
    }
}
