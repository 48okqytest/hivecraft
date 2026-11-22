package com.hivecraft.overlay.ui.term;

/**
 * Single-line editor state for the terminal prompt (readline-ish): insert at cursor, backspace /
 * delete, word jumps and word delete, home/end, kill line. Pure logic, unit tested.
 */
public final class LineEditor {
    private final int maxLen;
    private StringBuilder text = new StringBuilder();
    private int cursor = 0;

    public LineEditor(int maxLen) {
        this.maxLen = maxLen;
    }

    public String text() { return text.toString(); }
    public int cursor() { return cursor; }

    public void set(String s, int cur) {
        text = new StringBuilder(s == null ? "" : s);
        if (text.length() > maxLen) text.setLength(maxLen);
        cursor = Math.max(0, Math.min(cur, text.length()));
    }

    public void set(String s) {
        set(s, s == null ? 0 : s.length());
    }

    public void insert(String s) {
        if (s == null || s.isEmpty()) return;
        StringBuilder clean = new StringBuilder();
        for (char c : s.toCharArray()) {
            if (c == '\n' || c == '\r' || c == '\t') clean.append(' ');
            else if (c >= 32 && c != 127 && c != '§') clean.append(c);
        }
        int room = maxLen - text.length();
        if (room <= 0) return;
        String ins = clean.length() > room ? clean.substring(0, room) : clean.toString();
        text.insert(cursor, ins);
        cursor += ins.length();
    }

    public void backspace() {
        if (cursor > 0) {
            text.deleteCharAt(cursor - 1);
            cursor--;
        }
    }

    public void delete() {
        if (cursor < text.length()) text.deleteCharAt(cursor);
    }

    public void left() { if (cursor > 0) cursor--; }
    public void right() { if (cursor < text.length()) cursor++; }
    public void home() { cursor = 0; }
    public void end() { cursor = text.length(); }

    /** Index of the start of the word before the cursor. */
    public int wordLeft() {
        int i = cursor;
        while (i > 0 && text.charAt(i - 1) == ' ') i--;
        while (i > 0 && text.charAt(i - 1) != ' ') i--;
        return i;
    }

    /** Index just past the word after the cursor. */
    public int wordRight() {
        int i = cursor, n = text.length();
        while (i < n && text.charAt(i) == ' ') i++;
        while (i < n && text.charAt(i) != ' ') i++;
        return i;
    }

    public void jumpWordLeft() { cursor = wordLeft(); }
    public void jumpWordRight() { cursor = wordRight(); }

    /** Ctrl+Backspace / Ctrl+W. */
    public void deleteWordLeft() {
        int s = wordLeft();
        text.delete(s, cursor);
        cursor = s;
    }

    /** Ctrl+Delete. */
    public void deleteWordRight() {
        int e = wordRight();
        text.delete(cursor, e);
    }

    /** Ctrl+U: delete everything before the cursor. */
    public void killToStart() {
        text.delete(0, cursor);
        cursor = 0;
    }

    /** Ctrl+K: delete everything after the cursor. */
    public void killToEnd() {
        text.setLength(cursor);
    }

    public void clear() {
        text.setLength(0);
        cursor = 0;
    }
}
