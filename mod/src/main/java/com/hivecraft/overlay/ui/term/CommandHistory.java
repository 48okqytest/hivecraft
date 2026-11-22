package com.hivecraft.overlay.ui.term;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Shell-style command history: up/down walks older/newer entries, the line being typed (the draft)
 * is kept and restored when you walk back past the newest entry. Consecutive duplicates and blank
 * lines are not stored. Pure logic (no Minecraft classes) so it is unit tested.
 */
public final class CommandHistory {
    private final int max;
    private final List<String> entries = new ArrayList<>();
    /** index into entries while browsing; == entries.size() means "at the draft". */
    private int cursor = 0;
    private String draft = "";

    public CommandHistory(int max) {
        this.max = Math.max(1, max);
    }

    public void add(String line) {
        if (line == null) return;
        String l = line.strip();
        if (!l.isEmpty() && (entries.isEmpty() || !entries.get(entries.size() - 1).equals(l))) {
            entries.add(l);
            while (entries.size() > max) entries.remove(0);
        }
        resetCursor();
    }

    /** Called when the user starts typing again: browsing restarts from the newest entry. */
    public void resetCursor() {
        cursor = entries.size();
        draft = "";
    }

    /** Older entry. {@code current} is what is in the input box now (saved as the draft the first time). */
    public String up(String current) {
        if (entries.isEmpty()) return current;
        if (cursor == entries.size()) draft = current == null ? "" : current;
        if (cursor > 0) cursor--;
        return entries.get(cursor);
    }

    /** Newer entry; past the newest returns the saved draft. */
    public String down(String current) {
        if (cursor >= entries.size()) return current;
        cursor++;
        return cursor == entries.size() ? draft : entries.get(cursor);
    }

    public boolean isBrowsing() {
        return cursor < entries.size();
    }

    public List<String> entries() {
        return Collections.unmodifiableList(entries);
    }

    public void setAll(List<String> lines) {
        entries.clear();
        if (lines != null) for (String l : lines) add(l);
        resetCursor();
    }

    public int size() {
        return entries.size();
    }
}
