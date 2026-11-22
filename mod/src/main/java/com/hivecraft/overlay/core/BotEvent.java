package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

/** Bot event: death, respawn, hurt, joined, kicked, night_fell, ... */
public record BotEvent(String bot, String kind, String text, long ts) {
    public static BotEvent parse(JsonObject o) {
        return new BotEvent(J.str(o, "bot", "?"), J.str(o, "kind", ""), J.str(o, "text", ""), J.lng(o, "ts", 0));
    }
}
