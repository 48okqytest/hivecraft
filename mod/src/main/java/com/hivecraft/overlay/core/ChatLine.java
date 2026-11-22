package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

/** A team chat message. {@code color} = sender colour (0xRRGGBB). */
public record ChatLine(long id, String from, String to, String text, long ts, int color) {
    public static ChatLine parse(JsonObject o) {
        return new ChatLine(J.lng(o, "id", -1), J.str(o, "from", "?"), J.str(o, "to", "all"),
                J.str(o, "text", ""), J.lng(o, "ts", 0), J.color(o, "color", null, 0xAAAAAA));
    }
}
