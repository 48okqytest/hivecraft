package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

/** Agent log feed line. kind: thought | tool | result | error | system. */
public record LogLine(String bot, String kind, String text, long ts) {
    public static LogLine parse(JsonObject o) {
        return new LogLine(J.str(o, "bot", "?"), J.str(o, "kind", "system"), J.str(o, "text", ""), J.lng(o, "ts", 0));
    }
}
