package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * A board task. status: open | claimed | done | blocked. owner may be null. {@code reward} = coins on the task
 * (0 = none; MOD_PROTOCOL.md §5 board bounties), {@code rewardStatus} open | paid | refunded (null = none),
 * {@code rewardTo} = who was paid.
 */
public record TaskInfo(int id, String title, String detail, String status, String owner, int priority,
                       String by, List<Note> notes, long updated, long reward, String rewardStatus, String rewardTo) {
    public TaskInfo(int id, String title, String detail, String status, String owner, int priority, String by, List<Note> notes, long updated) {
        this(id, title, detail, status, owner, priority, by, notes, updated, 0, null, null);
    }

    public boolean hasReward() { return reward > 0; }

    public record Note(String by, String text, long ts) {}

    public static TaskInfo parse(JsonObject o) {
        List<Note> notes = new ArrayList<>();
        JsonArray a = J.arr(o, "notes");
        if (a != null) for (var e : a) {
            JsonObject n = J.obj(e);
            if (n != null) notes.add(new Note(J.str(n, "by", ""), J.str(n, "text", ""), J.lng(n, "ts", 0)));
        }
        return new TaskInfo(J.integer(o, "id", -1), J.str(o, "title", ""), J.str(o, "detail", ""),
                J.str(o, "status", "open"), J.str(o, "owner"), J.integer(o, "priority", 0),
                J.str(o, "by", ""), Collections.unmodifiableList(notes), J.lng(o, "updated", 0),
                Math.max(0, J.lng(o, "reward", 0)), J.str(o, "rewardStatus"), J.str(o, "rewardTo"));
    }
}
