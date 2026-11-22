package com.hivecraft.overlay.core;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Earnings formatting helpers (pure, unit-tested): sources, ticker lines, icons, bounty status. */
public final class EarnText {
    private EarnText() {}

    /** Tx kind → earning source (mob, job, bounty, milestone, wage), or null when it isn't an earning. */
    public static String sourceOfTx(String kind) {
        if (kind == null) return null;
        return switch (kind) {
            case "mob_bounty" -> "mob";
            case "job_pay" -> "job";
            case "bounty_paid" -> "bounty";
            case "milestone", "world_first" -> "milestone";
            case "wage" -> "wage";
            default -> null;
        };
    }

    /** "Mob bounty", "Server job", … */
    public static String label(String source) {
        if (source == null) return "Earned";
        return switch (source) {
            case "mob" -> "Mob bounty";
            case "job" -> "Server job";
            case "bounty" -> "Bounty";
            case "milestone" -> "Milestone";
            case "wage" -> "Daily wage";
            default -> EconText.pretty(source);
        };
    }

    /** Short tag for the floating "+N" on the HUD chip: "mob", "job", "bounty", "milestone", "wage". */
    public static String tag(String source) {
        return source == null ? "" : source.toLowerCase(Locale.ROOT);
    }

    /** Accent (RGB) per source. */
    public static int color(String source) {
        if (source == null) return 0x5BE37D;
        return switch (source) {
            case "mob" -> 0xFF7A7A;
            case "job" -> 0x5CC8FF;
            case "bounty" -> 0xFFC24A;
            case "milestone" -> 0xC792FF;
            case "wage" -> 0xFFE27A;
            default -> 0x5BE37D;
        };
    }

    /** Ticker sentence for one of the player's earnings. */
    public static String line(EarnState.Earned e) {
        String t = e.text() == null ? "" : e.text().strip();
        String base = label(e.source());
        if ("bounty".equals(e.source()) && !t.isEmpty()) base = "Bounty paid";
        String out = t.isEmpty() ? base : base + " · " + t;
        if (e.worldFirst() && !out.toLowerCase(Locale.ROOT).contains("world first")) out += " (world first!)";
        return out;
    }

    /** Ticker sentence for someone else's world-first milestone. */
    public static String worldFirstLine(EarnState.Earned e) {
        String what = e.text() == null || e.text().isBlank() ? EconText.pretty(e.id()) : e.text().strip();
        return e.who() + " got the world first: " + what;
    }

    /** Item id to show next to an earning. */
    public static String icon(String source, String text, String id) {
        if (source == null) return "gold_nugget";
        return switch (source) {
            case "mob" -> { String m = firstMob(text); yield m == null ? "iron_sword" : mobIcon(m); }
            case "job" -> { String it = jobItem(text); yield it == null ? "chest" : it; }
            case "bounty" -> "writable_book";
            case "milestone" -> id == null ? "nether_star" : milestoneIcon(id);
            case "wage" -> "clock";
            default -> "gold_nugget";
        };
    }

    /** "zombie" → "zombie_spawn_egg". */
    public static String mobIcon(String mob) { return EconText.normItem(mob) + "_spawn_egg"; }

    /** Milestone id → a fitting item. */
    public static String milestoneIcon(String id) {
        String s = EconText.normItem(id);
        if (s.contains("deepslate") && s.contains("diamond")) return "deepslate_diamond_ore";
        if (s.contains("diamond")) return "diamond";
        if (s.contains("emerald")) return "emerald";
        if (s.contains("debris")) return "ancient_debris";
        if (s.contains("nether")) return "netherrack";
        if (s.equals("end") || s.contains("the_end") || s.startsWith("end")) return "end_stone";
        return "nether_star";
    }

    /** "2 zombie, 1 skeleton" → "zombie"; "zombie" → "zombie"; null when nothing usable. */
    public static String firstMob(String text) {
        if (text == null || text.isBlank()) return null;
        String first = text.split(",")[0].strip();
        String[] w = first.split("\\s+");
        int i = 0;
        if (w.length > 1 && isInt(w[0])) i = 1;
        StringBuilder sb = new StringBuilder();
        for (int k = i; k < w.length; k++) { if (sb.length() > 0) sb.append('_'); sb.append(w[k]); }
        String s = EconText.normItem(sb.toString());
        if (s.endsWith("s") && !s.endsWith("ss")) s = s.substring(0, s.length() - 1);
        return s.isEmpty() ? null : s;
    }

    /** "32 cobblestone for job #4" → "cobblestone"; null when it doesn't look like that. */
    public static String jobItem(String text) {
        if (text == null) return null;
        String t = text.strip();
        int f = t.indexOf(" for ");
        if (f > 0) t = t.substring(0, f);
        String[] w = t.split("\\s+", 2);
        if (w.length == 2 && isInt(w[0])) return EconText.normItem(w[1]);
        return null;
    }

    /** "claimed by Ash", "open", "paid to Flint", "refunded". */
    public static String bountyStatus(EarnState.Bounty b, TaskInfo t) {
        if (b != null && "paid".equals(b.status())) return "paid to " + (b.paidTo() != null ? b.paidTo() : "?");
        boolean taskDone = t != null && "done".equals(t.status());
        boolean refunded = (b != null && "refunded".equals(b.status())) || (t != null && "refunded".equals(t.rewardStatus()));
        if (refunded && (t == null || taskDone)) return "refunded";
        if (t != null && "paid".equals(t.rewardStatus())) return "paid to " + (t.rewardTo() != null ? t.rewardTo() : "?");
        String owner = t != null && t.owner() != null && !t.owner().isBlank() ? t.owner() : b != null ? b.owner() : null;
        String st = t != null ? t.status() : "open";
        if ("done".equals(st)) return "done";
        String base = owner != null && !owner.isBlank() ? ("blocked".equals(st) ? "blocked · " : "claimed by ") + owner : "open";
        return refunded ? base + " · reward refunded" : base;
    }

    /** Capitalizes the first letter ("first diamond" → "First diamond"). */
    public static String cap(String s) {
        if (s == null || s.isEmpty()) return s == null ? "" : s;
        return Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    /** Drops the bridge's lead-in from a tx note ("bounty on task #3 Mine" → "task #3 Mine", "world first: x" → "x"). */
    public static String trimNote(String note) {
        if (note == null) return "";
        String n = note.strip();
        for (String p : new String[]{"bounty on ", "world first: "}) if (n.toLowerCase(Locale.ROOT).startsWith(p)) n = n.substring(p.length());
        return n;
    }

    /** Most of {@code job} the player can deliver now. */
    public static int deliverable(EarnState.Job j, int have) {
        if (j == null || !j.open()) return 0;
        return Math.max(0, Math.min(j.left(), have));
    }

    /**
     * Next sunrise (time of day 0 = 6:00, when the day counter goes up) from the client's world time, in real ms.
     * {@code timeOfDay} = world ticks; returns ms until the next multiple of 24000 ticks (20 ticks / s).
     */
    public static long msToSunrise(long timeOfDay) {
        long t = Math.floorMod(timeOfDay, 24000L);
        long ticks = 24000L - t;
        return ticks * 50L;
    }

    /** A board task with (or without) a reward, merged from the board and the bounty list. */
    public record Row(int task, String title, long reward, String status, boolean open, boolean rewardOpen, long myShare,
                      int funders, String by, String owner, TaskInfo t, EarnState.Bounty b) {}

    /**
     * Board tasks merged with bounties: open tasks with a reward (biggest first), then open tasks without one, then
     * done tasks / closed bounties that had a reward.
     */
    public static List<Row> rows(List<TaskInfo> board, List<EarnState.Bounty> bounties, String me) {
        Map<Integer, EarnState.Bounty> bm = new HashMap<>();
        for (EarnState.Bounty b : bounties) bm.put(b.task(), b);
        List<Row> open = new ArrayList<>(), plain = new ArrayList<>(), closed = new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        for (TaskInfo t : board) {
            EarnState.Bounty b = bm.get(t.id());
            seen.add(t.id());
            boolean done = "done".equals(t.status());
            long rw = b != null ? Math.max(b.total(), t.reward()) : t.reward();
            boolean rOpen = rw > 0 && (b != null ? b.open() && (t.rewardStatus() == null || "open".equals(t.rewardStatus()))
                    : t.rewardStatus() == null || "open".equals(t.rewardStatus()));
            Row r = new Row(t.id(), t.title(), rw, bountyStatus(b, t), !done, rOpen && !done, b == null ? 0 : b.share(me),
                    b == null ? 0 : b.funders().size(), t.by(), t.owner(), t, b);
            if (done) { if (rw > 0) closed.add(r); }
            else if (rw > 0) open.add(r);
            else plain.add(r);
        }
        for (EarnState.Bounty b : bounties) {
            if (seen.contains(b.task())) continue;
            Row r = new Row(b.task(), b.title(), b.total(), bountyStatus(b, null), b.open(), b.open(), b.share(me),
                    b.funders().size(), "", b.owner(), null, b);
            (b.open() ? open : closed).add(r);
        }
        open.sort((x, y) -> Long.compare(y.reward(), x.reward()));
        List<Row> out = new ArrayList<>(open);
        out.addAll(plain);
        out.addAll(closed);
        return out;
    }

    /** The player can take their share back while nobody else has claimed the task. */
    public static boolean canWithdraw(Row r, String me) {
        if (!r.rewardOpen() || r.myShare() <= 0) return false;
        return r.owner() == null || r.owner().isBlank() || EconText.same(r.owner(), me) || EconText.same(r.owner(), EconState.who());
    }

    private static boolean isInt(String s) {
        if (s.isEmpty()) return false;
        for (int i = 0; i < s.length(); i++) if (!Character.isDigit(s.charAt(i))) return false;
        return true;
    }
}
