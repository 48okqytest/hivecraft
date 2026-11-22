package com.hivecraft.overlay.ui.term;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Bash-like tab completion for the terminal.
 * <ul>
 *   <li>First token: command names (server commands from {@code init.commands} + local ones).</li>
 *   <li>Later tokens: argument kinds per command (bot names, {@code all}, sub-commands).</li>
 *   <li>One match: completes it and adds a space. Several: first Tab extends to the common prefix;
 *       further Tabs cycle through the matches (Shift+Tab backwards).</li>
 * </ul>
 * Pure logic, unit tested.
 */
public final class TabCompleter {

    /** What the n-th argument of a command can be. */
    public enum Arg { BOT, BOT_OR_ALL, COMMAND, BOARD_SUB, FREE }

    /** Argument kinds per command (index 0 = first argument). Unknown commands complete nothing. */
    public static final Map<String, List<Arg>> ARGS = Map.ofEntries(
            Map.entry("help", List.of(Arg.COMMAND)),
            Map.entry("say", List.of(Arg.BOT_OR_ALL, Arg.FREE)),
            Map.entry("status", List.of(Arg.BOT)),
            Map.entry("log", List.of(Arg.BOT, Arg.FREE)),
            Map.entry("where", List.of(Arg.BOT)),
            Map.entry("follow", List.of(Arg.BOT)),
            Map.entry("spectate", List.of(Arg.BOT)),
            Map.entry("stop", List.of(Arg.BOT_OR_ALL)),
            Map.entry("come", List.of(Arg.BOT_OR_ALL)),
            Map.entry("placed", List.of(Arg.BOT_OR_ALL, Arg.FREE)),
            Map.entry("photos", List.of(Arg.BOT)),
            Map.entry("board", List.of(Arg.BOARD_SUB, Arg.FREE)),
            Map.entry("goal", List.of(Arg.FREE)),
            Map.entry("chat", List.of(Arg.BOT_OR_ALL)));

    public static final List<String> BOARD_SUBS = List.of("add", "done");

    /** Result of one Tab press. */
    public record Result(String text, int cursor, List<String> candidates, boolean changed) {}

    private final Supplier<Collection<String>> commands;
    private final Supplier<Collection<String>> bots;

    // cycling state: valid while the user only presses Tab
    private String cycleBase;      // text before the token being cycled
    private String cycleAfter;     // text after the cursor
    private List<String> cycleList;
    private int cycleIndex = -1;
    private String lastOutput;     // text we produced last time (to detect user edits)

    public TabCompleter(Supplier<Collection<String>> commands, Supplier<Collection<String>> bots) {
        this.commands = commands;
        this.bots = bots;
    }

    /** Forget cycling state (call on any edit that is not a Tab). */
    public void reset() {
        cycleList = null;
        cycleIndex = -1;
        lastOutput = null;
    }

    public Result complete(String text, int cursor, boolean reverse) {
        if (text == null) text = "";
        cursor = Math.max(0, Math.min(cursor, text.length()));

        // keep cycling if nothing changed since our last output
        if (cycleList != null && text.equals(lastOutput) && cycleList.size() > 1) {
            cycleIndex = Math.floorMod(cycleIndex + (reverse ? -1 : 1), cycleList.size());
            return emit(cycleBase, cycleList.get(cycleIndex), cycleAfter, cycleList, false);
        }
        reset();

        String before = text.substring(0, cursor);
        String after = text.substring(cursor);
        int tokStart = before.lastIndexOf(' ') + 1;
        String token = before.substring(tokStart);
        String head = before.substring(0, tokStart);
        List<String> prior = splitWords(head);

        List<String> pool = candidatesFor(prior);
        List<String> matches = filter(pool, token);
        if (matches.isEmpty()) return new Result(text, cursor, List.of(), false);

        if (matches.size() == 1) {
            String m = matches.get(0);
            String tail = after.startsWith(" ") ? "" : " ";
            String out = head + m + tail;
            lastOutput = null;
            return new Result(out + after, out.length(), matches, !(out + after).equals(text));
        }

        String common = commonPrefix(matches);
        if (common.length() > token.length()) {
            // extend to the common prefix (keep the user's case if they typed more than nothing)
            String out = head + common;
            cycleBase = head;
            cycleAfter = after;
            cycleList = matches;
            cycleIndex = -1;
            lastOutput = out + after;
            return new Result(out + after, out.length(), matches, true);
        }
        // nothing to extend: start cycling
        cycleBase = head;
        cycleAfter = after;
        cycleList = matches;
        cycleIndex = reverse ? matches.size() - 1 : 0;
        return emit(head, matches.get(cycleIndex), after, matches, true);
    }

    private Result emit(String head, String word, String after, List<String> all, boolean first) {
        String out = head + word;
        lastOutput = out + after;
        return new Result(out + after, out.length(), all, true);
    }

    /** Candidate words for the next token given the complete words before it. */
    public List<String> candidatesFor(List<String> prior) {
        if (prior.isEmpty()) return sortedUnique(commands.get());
        String cmd = prior.get(0).toLowerCase(Locale.ROOT);
        List<Arg> spec = ARGS.get(cmd);
        int argIndex = prior.size() - 1;
        if (spec == null || argIndex >= spec.size()) return List.of();
        Arg kind = spec.get(argIndex);
        // "board done <id>" / "board add <text>": free after the sub-command
        return switch (kind) {
            case BOT -> sortedUnique(bots.get());
            case BOT_OR_ALL -> {
                List<String> l = new ArrayList<>(sortedUnique(bots.get()));
                l.add("all");
                yield l;
            }
            case COMMAND -> sortedUnique(commands.get());
            case BOARD_SUB -> BOARD_SUBS;
            case FREE -> List.of();
        };
    }

    static List<String> filter(List<String> pool, String token) {
        String t = token.toLowerCase(Locale.ROOT);
        List<String> out = new ArrayList<>();
        for (String p : pool) if (p.toLowerCase(Locale.ROOT).startsWith(t)) out.add(p);
        return out;
    }

    /** Case-insensitive common prefix, returned in the case of the first match. */
    static String commonPrefix(List<String> words) {
        if (words.isEmpty()) return "";
        String first = words.get(0);
        int n = first.length();
        for (String w : words) {
            int i = 0;
            int lim = Math.min(n, w.length());
            while (i < lim && Character.toLowerCase(first.charAt(i)) == Character.toLowerCase(w.charAt(i))) i++;
            n = i;
        }
        return first.substring(0, n);
    }

    static List<String> splitWords(String s) {
        List<String> out = new ArrayList<>();
        for (String w : s.trim().split("\\s+")) if (!w.isEmpty()) out.add(w);
        return out;
    }

    private static List<String> sortedUnique(Collection<String> in) {
        Set<String> seen = new LinkedHashSet<>();
        List<String> out = new ArrayList<>();
        if (in == null) return out;
        List<String> sorted = new ArrayList<>(in);
        sorted.removeIf(s -> s == null || s.isBlank());
        sorted.sort(String.CASE_INSENSITIVE_ORDER);
        for (String s : sorted) if (seen.add(s.toLowerCase(Locale.ROOT))) out.add(s);
        return out;
    }
}
