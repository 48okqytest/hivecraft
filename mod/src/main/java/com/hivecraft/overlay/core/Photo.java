package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

/** A bot photo. Image bytes (PNG): {@code Hive.client().fetchBytes(photo.url())}. */
public record Photo(String id, String agent, long ts, String caption, String mode, String url, int width, int height) {
    public static Photo parse(JsonObject o) {
        String id = J.str(o, "id", "?");
        return new Photo(id, J.str(o, "agent", J.str(o, "bot", "?")), J.lng(o, "ts", 0), J.str(o, "caption", ""),
                J.str(o, "mode", ""), J.str(o, "url", "/photos/" + id + ".png"),
                J.integer(o, "width", 0), J.integer(o, "height", 0));
    }
}
