package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

public record Goal(String text, String by, long ts) {
    public static Goal parse(JsonObject o) {
        if (o == null) return null;
        return new Goal(J.str(o, "text", ""), J.str(o, "by", ""), J.lng(o, "ts", 0));
    }
}
