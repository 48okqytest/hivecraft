package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * One bot, as of the latest {@code bots} message. Immutable.
 * {@code px,py,pz} = where the bot was drawn when this update arrived; use {@link #lerpX(long)} etc. for smooth rendering.
 * {@code progressDone/Total} are -1 when unknown; {@code yaw/pitch} are mineflayer radians (see {@link #mcYaw()}).
 */
public record BotState(
        String name, int color, String role, boolean online, String status,
        double x, double y, double z, double px, double py, double pz,
        int bx, int by, int bz,
        Double yaw, Double pitch, String dim,
        float health, int food, String held, List<String> armor,
        String action, String actionText, long busyMs,
        int progressDone, int progressTotal,
        Integer taskId, String taskTitle, String taskStatus,
        String lastChat, long lastChatTs, String thought, boolean dead,
        long receivedAt, long serverTs) {

    /** Interval over which the client interpolates from the previous to the current position (bots arrive at 5 Hz). */
    public static final long LERP_MS = 220;

    public static BotState parse(JsonObject o, BotState prev, long now, long serverTs) {
        String name = J.str(o, "name", "?");
        JsonObject pos = J.obj(o, "pos");
        JsonObject bpos = J.obj(o, "bpos");
        String dim = Dims.normalize(J.str(o, "dim", prev != null ? prev.dim : "overworld"));
        double x = J.num(pos, "x", prev != null ? prev.x : 0);
        double y = J.num(pos, "y", prev != null ? prev.y : 0);
        double z = J.num(pos, "z", prev != null ? prev.z : 0);
        double px = x, py = y, pz = z;
        if (prev != null && Objects.equals(prev.dim, dim)) {
            double cx = prev.lerpX(now), cy = prev.lerpY(now), cz = prev.lerpZ(now);
            double dx = x - cx, dy = y - cy, dz = z - cz;
            if (dx * dx + dy * dy + dz * dz < 12 * 12) { px = cx; py = cy; pz = cz; } // else: teleport, snap
        }
        int bx = bpos != null ? J.integer(bpos, "x", (int) Math.floor(x)) : (int) Math.floor(x);
        int by = bpos != null ? J.integer(bpos, "y", (int) Math.floor(y)) : (int) Math.floor(y);
        int bz = bpos != null ? J.integer(bpos, "z", (int) Math.floor(z)) : (int) Math.floor(z);

        List<String> armor = new ArrayList<>();
        JsonArray a = J.arr(o, "armor");
        if (a != null) for (int i = 0; i < a.size(); i++) armor.add(a.get(i).isJsonNull() ? null : a.get(i).getAsString());

        JsonObject prog = J.obj(o, "progress");
        JsonObject task = J.obj(o, "task");
        JsonObject lc = J.obj(o, "lastChat");
        Double taskId = task != null ? J.numOrNull(task, "id") : null;

        return new BotState(
                name, J.color(o, "color", "colorInt", 0xFFFFFF), J.str(o, "role", ""),
                J.bool(o, "online", false), J.str(o, "status", ""),
                x, y, z, px, py, pz, bx, by, bz,
                J.numOrNull(o, "yaw"), J.numOrNull(o, "pitch"), dim,
                (float) J.num(o, "health", 20), J.integer(o, "food", 20), J.str(o, "held"),
                Collections.unmodifiableList(armor),
                J.str(o, "action"), J.str(o, "actionText", "idle"), J.lng(o, "busyMs", 0),
                prog != null ? J.integer(prog, "done", -1) : -1, prog != null ? J.integer(prog, "total", -1) : -1,
                taskId != null ? taskId.intValue() : null,
                task != null ? J.str(task, "title") : null, task != null ? J.str(task, "status") : null,
                lc != null ? J.str(lc, "text") : null, lc != null ? J.lng(lc, "ts", 0) : 0,
                J.str(o, "thought"), J.bool(o, "dead", false), now, serverTs);
    }

    private double t(long now) {
        double t = (now - receivedAt) / (double) LERP_MS;
        return t < 0 ? 0 : (t > 1 ? 1 : t);
    }

    public double lerpX(long now) { return px + (x - px) * t(now); }
    public double lerpY(long now) { return py + (y - py) * t(now); }
    public double lerpZ(long now) { return pz + (z - pz) * t(now); }

    /** Minecraft yaw in degrees (-180..180) from the mineflayer radians, or 0 when unknown. */
    public float mcYaw() {
        if (yaw == null) return 0;
        double d = 180.0 - yaw * 180.0 / Math.PI;
        d = ((d + 180.0) % 360.0 + 360.0) % 360.0 - 180.0;
        return (float) d;
    }

    /** Minecraft pitch in degrees (positive = looking down), or 0 when unknown. */
    public float mcPitch() { return pitch == null ? 0 : (float) (-pitch * 180.0 / Math.PI); }

    public boolean hasProgress() { return progressTotal > 0 && progressDone >= 0; }
    public float progressFraction() { return hasProgress() ? Math.min(1f, progressDone / (float) progressTotal) : 0f; }
    public boolean idle() { return action == null || action.isEmpty(); }

    /** "collect" for "collect", "eat" for "auto:eat", null when idle. */
    public String actionName() {
        if (action == null) return null;
        return action.startsWith("auto:") ? action.substring(5) : action;
    }
}
