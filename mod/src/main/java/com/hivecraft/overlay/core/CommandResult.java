package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Result of a terminal command: lines of coloured segments. data = optional machine-readable payload (may be null). */
public record CommandResult(boolean ok, List<List<Segment>> lines, JsonObject data) {
    /** color = 0xRRGGBB or -1 for default; click = command to run when clicked, or null. */
    public record Segment(String text, int color, boolean bold, boolean italic, String click) {}

    public static CommandResult parse(JsonObject o) {
        List<List<Segment>> lines = new ArrayList<>();
        JsonArray la = J.arr(o, "lines");
        if (la != null) for (var le : la) {
            JsonArray segs = J.arr(le);
            List<Segment> line = new ArrayList<>();
            if (segs != null) for (var se : segs) {
                JsonObject s = J.obj(se);
                if (s != null) line.add(new Segment(J.str(s, "text", ""), J.parseColor(J.str(s, "color"), -1),
                        J.bool(s, "bold", false), J.bool(s, "italic", false), J.str(s, "click")));
                else if (se.isJsonPrimitive()) line.add(new Segment(se.getAsString(), -1, false, false, null));
            }
            else if (le.isJsonPrimitive()) line.add(new Segment(le.getAsString(), -1, false, false, null));
            lines.add(Collections.unmodifiableList(line));
        }
        boolean ok = J.bool(o, "ok", true);
        if (lines.isEmpty() && !ok) {
            String err = J.str(o, "error", "command failed");
            lines.add(List.of(new Segment(err, 0xFF5555, false, false, null)));
        }
        return new CommandResult(ok, Collections.unmodifiableList(lines), J.obj(o, "data"));
    }

    /** A local error (bridge offline, timeout...). */
    public static CommandResult error(String msg) {
        return new CommandResult(false, List.of(List.of(new Segment(msg, 0xFF5555, false, false, null))), null);
    }

    /** All lines as plain text joined with newlines. */
    public String plainText() {
        StringBuilder sb = new StringBuilder();
        for (List<Segment> l : lines) {
            if (sb.length() > 0) sb.append('\n');
            for (Segment s : l) sb.append(s.text());
        }
        return sb.toString();
    }
}
