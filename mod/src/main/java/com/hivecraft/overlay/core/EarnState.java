package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Ways to earn coins (MOD_PROTOCOL.md §5 "Earning coins"): server jobs, board bounties, mob bounty rates, milestones,
 * the daily wage and the player's earnings totals. Owned by {@link EconState}, which calls the writers while holding its
 * lock; readers get immutable snapshots through volatile fields. Pure logic (no Minecraft classes), unit-tested.
 */
public final class EarnState {
    /** One Minecraft day in real ms (20 min) — used to roll "today" forward when the bridge's sunrise passes. */
    public static final long MC_DAY_MS = 20 * 60 * 1000L;
    public static final int MAX_RECENT = 40;
    public static final int MAX_CLOSED_BOUNTIES = 12;
    public static final List<String> SOURCES = List.of("mob", "job", "bounty", "milestone", "wage");

    // ------------------------------------------------------------------ models

    /** Server job: wants {@code count} {@code item} in total, {@code left} still wanted, pays {@code pay} coins each. */
    public record Job(int id, String item, int count, int left, int pay, Integer shopSell, Map<String, Integer> delivered,
                      long created, long expiresAt, String status) {
        static Job parse(JsonObject o, Job prev) {
            boolean has = prev != null;
            Map<String, Integer> del = has ? prev.delivered : Map.of();
            JsonObject d = J.obj(o, "delivered");
            if (d != null) {
                Map<String, Integer> m = new LinkedHashMap<>();
                for (var e : d.entrySet()) {
                    try { m.put(e.getKey(), e.getValue().getAsInt()); } catch (RuntimeException ignored) { /* skip bad */ }
                }
                del = Collections.unmodifiableMap(m);
            }
            int count = J.integer(o, "count", has ? prev.count : 0);
            Integer shopSell = o.has("shopSell") ? intOrNull(o, "shopSell") : (has ? prev.shopSell : null);
            return new Job(J.integer(o, "id", has ? prev.id : -1),
                    o.has("item") ? EconText.normItem(J.str(o, "item", "")) : (has ? prev.item : ""),
                    count, Math.max(0, J.integer(o, "left", has ? prev.left : count)), J.integer(o, "pay", has ? prev.pay : 0),
                    shopSell, del, J.lng(o, "created", has ? prev.created : 0), J.lng(o, "expiresAt", has ? prev.expiresAt : 0),
                    J.str(o, "status", has ? prev.status : "open"));
        }

        /** Still taking deliveries. */
        public boolean open() { return "open".equals(status) && left > 0; }
        public int done() { return Math.max(0, count - left); }
        public double progress() { return count <= 0 ? 0 : done() / (double) count; }
        public int deliveredBy(String who) {
            for (var e : delivered.entrySet()) if (EconText.same(e.getKey(), who)) return e.getValue();
            return 0;
        }
        /** Premium over the shop's sell price in percent (null when the shop doesn't buy it). */
        public Integer premiumPct() {
            if (shopSell == null || shopSell <= 0) return null;
            return (int) Math.round((pay - shopSell) * 100.0 / shopSell);
        }
        /** Coins for delivering {@code n} (capped at what is left). */
        public long payFor(int n) { return (long) pay * Math.max(0, Math.min(n, left)); }
    }

    /** A coin reward on a board task. {@code funders} = name → coins put in. */
    public record Bounty(int task, String title, long total, Map<String, Long> funders, String status, String owner,
                         String paidTo, long created, long ended) {
        static Bounty parse(JsonObject o, Bounty prev) {
            boolean has = prev != null;
            Map<String, Long> f = has ? prev.funders : Map.of();
            JsonObject fo = J.obj(o, "funders");
            if (fo != null) {
                Map<String, Long> m = new LinkedHashMap<>();
                for (var e : fo.entrySet()) {
                    try { m.put(e.getKey(), e.getValue().getAsLong()); } catch (RuntimeException ignored) { /* skip bad */ }
                }
                f = Collections.unmodifiableMap(m);
            }
            return new Bounty(J.integer(o, "task", has ? prev.task : -1), J.str(o, "title", has ? prev.title : ""),
                    J.lng(o, "total", has ? prev.total : 0), f, J.str(o, "status", has ? prev.status : "open"),
                    o.has("owner") ? J.str(o, "owner") : (has ? prev.owner : null),
                    o.has("paidTo") ? J.str(o, "paidTo") : (has ? prev.paidTo : null),
                    J.lng(o, "created", has ? prev.created : 0), J.lng(o, "ended", has ? prev.ended : 0));
        }

        public boolean open() { return "open".equals(status); }
        public long share(String who) {
            for (var e : funders.entrySet()) if (EconText.same(e.getKey(), who)) return e.getValue();
            return 0;
        }
    }

    /** A one-time bonus. {@code first} = extra coins for the first player in the world; {@code done} = the player has it. */
    public record Milestone(String id, String label, long reward, long first, boolean done, long ts, boolean worldFirst, String firstBy) {
        static Milestone parse(JsonObject o) {
            String id = J.str(o, "id", "");
            return new Milestone(id, J.str(o, "label", EconText.pretty(id)), J.lng(o, "reward", 0), J.lng(o, "first", 0),
                    J.bool(o, "done", false), J.lng(o, "ts", 0), J.bool(o, "worldFirst", false), J.str(o, "firstBy"));
        }
    }

    /** Mob bounty prices (mob → coins, priciest first), per-minute cap, wage, job premium. */
    public record Rates(Map<String, Integer> mobs, int mobCapPerMinute, long wage, int jobPremiumPct) {
        static final Rates NONE = new Rates(Map.of(), 0, 0, 0);
    }

    /** One earning event for anyone ({@code {t:"econ",kind:"earn"}}). */
    public record Earned(String source, String who, long amount, String text, String id, boolean worldFirst, long ts) {}

    // ------------------------------------------------------------------ state

    private final Map<Integer, Job> jobMap = new LinkedHashMap<>();
    private final Map<Integer, Bounty> bountyMap = new LinkedHashMap<>();
    private final Map<String, Long> totalMap = new LinkedHashMap<>();
    private final Map<String, Milestone> milestoneMap = new LinkedHashMap<>();

    private volatile boolean available;
    private volatile List<Job> jobs = List.of();
    private volatile long nextRotation;
    private volatile List<Bounty> bounties = List.of();
    private volatile Rates rates = Rates.NONE;
    private volatile List<Milestone> milestones = List.of();
    private volatile Map<String, Long> totals = Map.of();
    private volatile long today;
    private volatile long nextSunrise;
    private volatile long day = -1; // Minecraft day number the bridge last told us (earnings.day / earn.day)
    private volatile List<Earned> recent = List.of(); // the player's, newest first
    private volatile Earned lastWorldFirst;

    // ------------------------------------------------------------------ reads

    /** True once a snapshot carried earnings data (an older bridge / economy off never sets it). */
    public boolean available() { return available; }
    /** Open jobs first (most coins left first), then filled / expired ones. */
    public List<Job> jobs() { return jobs; }
    /** Epoch ms of the next job rotation (0 = unknown). */
    public long nextRotation() { return nextRotation; }
    /** Open bounties (biggest first), then recently paid / refunded ones. */
    public List<Bounty> bounties() { return bounties; }
    public Rates rates() { return rates; }
    public List<Milestone> milestones() { return milestones; }
    /** The player's coins earned per source (mob, job, bounty, milestone, wage) this world. */
    public Map<String, Long> totals() { return totals; }
    public long total() { long t = 0; for (long v : totals.values()) t += v; return t; }
    /** Coins the player earned since the current Minecraft day began, at {@code now}. */
    public long today(long now) {
        long ns = nextSunrise;
        return ns > 0 && now >= ns ? 0 : today;
    }
    public long today() { return today(System.currentTimeMillis()); }
    /** Epoch ms of the next sunrise (wage payout), 0 = unknown. Rolled forward by whole MC days once passed. */
    public long nextSunrise(long now) {
        long ns = nextSunrise;
        if (ns <= 0) return 0;
        while (ns <= now) ns += MC_DAY_MS;
        return ns;
    }
    /** Minecraft day number from the bridge (-1 = unknown). */
    public long day() { return day; }
    /** The player's recent earnings (from earn events), newest first. */
    public List<Earned> recent() { return recent; }
    /** The newest world-first milestone by anyone. */
    public Earned lastWorldFirst() { return lastWorldFirst; }

    public Job job(int id) { for (Job j : jobs) if (j.id() == id) return j; return null; }
    public Bounty bounty(int task) { for (Bounty b : bounties) if (b.task() == task) return b; return null; }
    public Milestone milestone(String id) { for (Milestone m : milestones) if (m.id().equals(id)) return m; return null; }

    // ------------------------------------------------------------------ writes (called by EconState under its lock)

    /** Reads {@code jobs}, {@code nextRotation}, {@code bounties} and {@code earnings} from a GET /econ/state object. */
    void applySnapshot(JsonObject s, String me, boolean newWorld, long now) {
        if (newWorld) clearMaps();
        boolean any = false;
        JsonElement je = J.get(s, "jobs");
        JsonArray ja = J.arr(je);
        JsonObject jo = J.obj(je);
        if (jo != null) { ja = J.arr(jo, "jobs"); nextRotation = J.lng(jo, "nextRotation", nextRotation); }
        if (ja != null) {
            any = true;
            jobMap.clear();
            for (var e : ja) { JsonObject o = J.obj(e); if (o != null) { Job j = Job.parse(o, null); if (j.id() >= 0) jobMap.put(j.id(), j); } }
            publishJobs();
        }
        if (s.has("nextRotation")) nextRotation = J.lng(s, "nextRotation", nextRotation);
        JsonArray ba = J.arr(s, "bounties");
        if (ba != null) {
            any = true;
            // the snapshot lists open ones: keep recently closed ones we already know
            bountyMap.values().removeIf(Bounty::open);
            for (var e : ba) { JsonObject o = J.obj(e); if (o != null) { Bounty b = Bounty.parse(o, null); if (b.task() >= 0) bountyMap.put(b.task(), b); } }
            publishBounties();
        }
        JsonObject ea = J.obj(s, "earnings");
        if (ea != null) {
            any = true;
            applyEarnings(ea, now);
        }
        if (any) available = true;
    }

    /** A {@code GET /econ/earnings} object (also {@code state.earnings}). */
    void applyEarnings(JsonObject ea, long now) {
        JsonObject r = J.obj(ea, "rates");
        if (r != null) rates = parseRates(r, milestoneMap);
        JsonObject t = J.obj(ea, "totals");
        if (t != null) {
            totalMap.clear();
            for (String k : SOURCES) totalMap.put(k, 0L);
            for (var e : t.entrySet()) {
                if ("today".equals(e.getKey()) || "all".equals(e.getKey())) continue; // all = sum of the others
                try { totalMap.put(e.getKey(), e.getValue().getAsLong()); } catch (RuntimeException ignored) { /* skip bad */ }
            }
            totals = Collections.unmodifiableMap(new LinkedHashMap<>(totalMap));
            today = J.lng(t, "today", today);
        }
        if (ea.has("day")) day = J.lng(ea, "day", day);
        if (ea.has("nextSunrise")) {
            Double ns = J.numOrNull(ea, "nextSunrise");
            nextSunrise = ns == null ? 0 : ns.longValue();
        }
        JsonArray ma = J.arr(ea, "milestones");
        if (ma != null) {
            for (var e : ma) {
                JsonObject o = J.obj(e);
                if (o != null && J.str(o, "id") != null) { Milestone m = Milestone.parse(o); milestoneMap.put(m.id(), m); }
                else if (e != null && e.isJsonPrimitive()) { // tolerate a bare id = reached
                    String id = e.getAsString();
                    Milestone p = milestoneMap.get(id);
                    milestoneMap.put(id, p != null ? withDone(p, true, p.ts(), p.worldFirst())
                            : new Milestone(id, EconText.pretty(id), 0, 0, true, 0, false, null));
                }
            }
            publishMilestones();
        }
        JsonArray ra = J.arr(ea, "recent");
        if (ra != null) {
            List<Earned> l = new ArrayList<>();
            for (var e : ra) {
                JsonObject o = J.obj(e);
                if (o == null) continue;
                String src = EarnText.sourceOfTx(J.str(o, "kind", ""));
                if (src == null) continue;
                l.add(new Earned(src, J.str(o, "to", ""), J.lng(o, "amount", 0), J.str(o, "note", ""), null,
                        "world_first".equals(J.str(o, "kind", "")), J.lng(o, "ts", 0)));
            }
            l.sort(Comparator.comparingLong(Earned::ts).reversed());
            while (l.size() > MAX_RECENT) l.remove(l.size() - 1);
            recent = Collections.unmodifiableList(l);
        }
    }

    /**
     * One {@code {t:"econ"}} delta of kind earn / jobs / job / bounty. Returns the earning for the player (for the
     * ticker / HUD) or null. {@code me} = the player's account name.
     */
    Earned apply(String kind, JsonObject m, String me, long now) {
        switch (kind) {
            case "earn" -> {
                available = true;
                // the bridge pays the wage when the day number goes up: a higher day means "today" starts again
                // (also when we never knew the day: a wage is only paid when a new day starts)
                long d = J.lng(m, "day", -1);
                boolean wage = "wage".equals(J.str(m, "source"));
                if (d >= 0 ? d > day && (day >= 0 || wage) : wage && isMe(J.str(m, "who"), me)) today = 0;
                if (d >= 0) day = Math.max(day, d);
                Earned e = new Earned(J.str(m, "source", "?"), J.str(m, "who", "?"), J.lng(m, "amount", 0), J.str(m, "text", ""),
                        J.str(m, "id"), J.bool(m, "worldFirst", false), now);
                if ("milestone".equals(e.source()) && e.worldFirst()) lastWorldFirst = e;
                if ("milestone".equals(e.source()) && e.id() != null) {
                    Milestone p = milestoneMap.get(e.id());
                    if (isMe(e.who(), me)) {
                        milestoneMap.put(e.id(), p != null ? withDone(p, true, now, p.worldFirst() || e.worldFirst())
                                : new Milestone(e.id(), labelFrom(e), e.amount(), 0, true, now, e.worldFirst(), e.worldFirst() ? e.who() : null));
                    } else if (e.worldFirst() && p != null && p.firstBy() == null) {
                        milestoneMap.put(e.id(), new Milestone(p.id(), p.label(), p.reward(), p.first(), p.done(), p.ts(), p.worldFirst(), e.who()));
                    }
                    publishMilestones();
                }
                if (!isMe(e.who(), me) || e.amount() <= 0) return null;
                if (nextSunrise > 0 && now >= nextSunrise) {
                    // a new Minecraft day began since the last snapshot: "today" restarts
                    today = 0;
                    while (nextSunrise <= now) nextSunrise += MC_DAY_MS;
                }
                totalMap.merge(e.source(), e.amount(), Long::sum);
                totals = Collections.unmodifiableMap(new LinkedHashMap<>(totalMap));
                today += e.amount();
                List<Earned> l = new ArrayList<>(recent);
                l.add(0, e);
                while (l.size() > MAX_RECENT) l.remove(l.size() - 1);
                recent = Collections.unmodifiableList(l);
                return e;
            }
            case "jobs" -> {
                JsonArray ja = J.arr(m, "jobs");
                if (ja != null) {
                    available = true;
                    // a full list: replace, but keep fields a shortened object leaves out
                    Map<Integer, Job> next = new LinkedHashMap<>();
                    for (var el : ja) {
                        JsonObject o = J.obj(el);
                        if (o == null) continue;
                        int id = J.integer(o, "id", -1);
                        Job j = Job.parse(o, jobMap.get(id));
                        if (j.id() >= 0) next.put(j.id(), j);
                    }
                    jobMap.clear();
                    jobMap.putAll(next);
                    publishJobs();
                }
                if (m.has("nextRotation")) nextRotation = J.lng(m, "nextRotation", nextRotation);
            }
            case "job" -> {
                JsonObject o = J.obj(m, "job");
                if (o != null) {
                    int id = J.integer(o, "id", -1);
                    Job j = Job.parse(o, jobMap.get(id));
                    if (j.id() >= 0) { jobMap.put(j.id(), j); publishJobs(); }
                }
            }
            case "bounty" -> {
                JsonObject o = J.obj(m, "bounty");
                if (o != null) {
                    available = true;
                    int task = J.integer(o, "task", -1);
                    Bounty b = Bounty.parse(o, bountyMap.get(task));
                    if (b.task() >= 0) {
                        if (!b.open() && b.ended() == 0) b = new Bounty(b.task(), b.title(), b.total(), b.funders(), b.status(), b.owner(), b.paidTo(), b.created(), now);
                        bountyMap.put(b.task(), b);
                        publishBounties();
                    }
                }
            }
            default -> { /* not ours */ }
        }
        return null;
    }

    void clear() {
        clearMaps();
        available = false;
        rates = Rates.NONE;
        nextRotation = 0;
        nextSunrise = 0;
        day = -1;
        lastWorldFirst = null;
    }

    private void clearMaps() {
        jobMap.clear(); bountyMap.clear(); totalMap.clear(); milestoneMap.clear();
        jobs = List.of(); bounties = List.of(); milestones = List.of(); totals = Map.of(); recent = List.of();
        today = 0;
    }

    // ------------------------------------------------------------------ internals

    private static boolean isMe(String who, String me) { return EconText.same(who, me) || EconText.same(who, EconState.who()); }

    private static String labelFrom(Earned e) {
        return e.text() != null && !e.text().isBlank() ? e.text() : EconText.pretty(e.id());
    }

    private static Milestone withDone(Milestone p, boolean done, long ts, boolean wf) {
        return new Milestone(p.id(), p.label(), p.reward(), p.first(), done, ts, wf, p.firstBy());
    }

    /** rates → Rates; rate milestone definitions fill in milestones we have no row for yet. */
    private static Rates parseRates(JsonObject r, Map<String, Milestone> ms) {
        Map<String, Integer> mobs = new LinkedHashMap<>();
        JsonObject mo = J.obj(r, "mobs");
        if (mo != null) {
            List<Map.Entry<String, Integer>> l = new ArrayList<>();
            for (var e : mo.entrySet()) {
                try { l.add(Map.entry(EconText.normItem(e.getKey()), e.getValue().getAsInt())); } catch (RuntimeException ignored) { /* skip bad */ }
            }
            l.sort(Map.Entry.<String, Integer>comparingByValue().reversed().thenComparing(Map.Entry.comparingByKey()));
            for (var e : l) mobs.put(e.getKey(), e.getValue());
        }
        JsonArray md = J.arr(r, "milestones");
        if (md != null) for (var e : md) {
            JsonObject o = J.obj(e);
            if (o == null || J.str(o, "id") == null) continue;
            Milestone def = Milestone.parse(o);
            Milestone p = ms.get(def.id());
            ms.put(def.id(), p == null ? def : new Milestone(p.id(), p.label().isBlank() ? def.label() : p.label(),
                    p.reward() > 0 ? p.reward() : def.reward(), p.first() > 0 ? p.first() : def.first(), p.done(), p.ts(), p.worldFirst(), p.firstBy()));
        }
        return new Rates(Collections.unmodifiableMap(mobs), J.integer(r, "mobCapPerMinute", 0), J.lng(r, "wage", 0), J.integer(r, "jobPremiumPct", 0));
    }

    private void publishJobs() {
        List<Job> l = new ArrayList<>(jobMap.values());
        l.sort(Comparator.comparing((Job j) -> !j.open()).thenComparingLong(j -> -j.payFor(j.left())).thenComparingInt(Job::id));
        jobs = Collections.unmodifiableList(l);
    }

    private void publishBounties() {
        List<Bounty> closed = new ArrayList<>();
        for (Bounty b : bountyMap.values()) if (!b.open()) closed.add(b);
        closed.sort(Comparator.comparingLong(Bounty::ended).reversed());
        for (int i = MAX_CLOSED_BOUNTIES; i < closed.size(); i++) bountyMap.remove(closed.get(i).task());
        List<Bounty> l = new ArrayList<>(bountyMap.values());
        l.sort(Comparator.comparing((Bounty b) -> !b.open())
                .thenComparingLong(b -> b.open() ? -b.total() : -b.ended())
                .thenComparingInt(Bounty::task));
        bounties = Collections.unmodifiableList(l);
    }

    private void publishMilestones() {
        milestones = List.copyOf(milestoneMap.values());
    }

    private static Integer intOrNull(JsonObject o, String k) {
        Double d = J.numOrNull(o, k);
        return d == null ? null : (int) Math.round(d);
    }
}
