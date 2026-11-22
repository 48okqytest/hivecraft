package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Client-side block ledger: recent bot block changes (live from WS), the latest change per block (for highlights),
 * and a cache of {@code /mod/ledger/at} answers (for the crosshair tooltip). Thread-safe.
 */
public final class LedgerCache {
    /** Answer of GET /mod/ledger/at, history oldest to newest. */
    public record AtResult(int x, int y, int z, String dim, List<LedgerEvent> history, LedgerEvent last, long fetchedAt) {
        public static AtResult parse(JsonObject o, long now) {
            List<LedgerEvent> h = new ArrayList<>();
            JsonArray a = J.arr(o, "history");
            if (a != null) for (var e : a) { JsonObject eo = J.obj(e); if (eo != null) h.add(LedgerEvent.parse(eo)); }
            JsonObject lo = J.obj(o, "last");
            LedgerEvent last = lo != null ? LedgerEvent.parse(lo) : (h.isEmpty() ? null : h.get(h.size() - 1));
            return new AtResult(J.integer(o, "x", 0), J.integer(o, "y", 0), J.integer(o, "z", 0),
                    Dims.normalize(J.str(o, "dim")), Collections.unmodifiableList(h), last, now);
        }

        AtResult with(LedgerEvent e) {
            List<LedgerEvent> h = new ArrayList<>(history);
            h.add(e);
            return new AtResult(x, y, z, dim, Collections.unmodifiableList(h), e, fetchedAt);
        }
    }

    public static final int MAX_RECENT = 4000;
    public static final int MAX_AT = 512;
    public static final long AT_TTL_MS = 20_000;

    private final LinkedHashMap<Long, LedgerEvent> recentById = new LinkedHashMap<>();
    private final Map<String, Map<Long, LedgerEvent>> latestByPos = new HashMap<>();
    private final LinkedHashMap<String, AtResult> atCache = new LinkedHashMap<>(64, 0.75f, true) {
        @Override protected boolean removeEldestEntry(Map.Entry<String, AtResult> e) { return size() > MAX_AT; }
    };
    private final Set<String> atInFlight = new HashSet<>();
    private final LinkedHashMap<String, Long> atFailedAt = new LinkedHashMap<>();
    /** After a failed fetch, wait this long before retrying the same block. */
    public static final long AT_RETRY_MS = 5_000;
    private long revision;
    private long synthId = -1;

    static String atKey(int x, int y, int z, String dim) { return Dims.normalize(dim) + ":" + x + "," + y + "," + z; }

    /** Adds events (any order); duplicates (same id) are ignored. Returns the newly added ones. */
    public synchronized List<LedgerEvent> addAll(List<LedgerEvent> events) {
        List<LedgerEvent> sorted = new ArrayList<>(events);
        sorted.sort((a, b) -> a.ts() != b.ts() ? Long.compare(a.ts(), b.ts()) : Long.compare(a.id(), b.id()));
        List<LedgerEvent> added = new ArrayList<>();
        for (LedgerEvent e : sorted) {
            if (e.id() >= 0 && recentById.containsKey(e.id())) continue;
            long key = e.id() >= 0 ? e.id() : synthId--;
            recentById.put(key, e);
            added.add(e);
            Map<Long, LedgerEvent> m = latestByPos.computeIfAbsent(e.dim(), k -> new HashMap<>());
            LedgerEvent cur = m.get(e.posKey());
            if (cur == null || cur.ts() < e.ts() || (cur.ts() == e.ts() && cur.id() < e.id())) m.put(e.posKey(), e);
            String ak = atKey(e.x(), e.y(), e.z(), e.dim());
            AtResult ar = atCache.get(ak);
            if (ar != null && (ar.last() == null || ar.last().id() != e.id())) atCache.put(ak, ar.with(e));
        }
        while (recentById.size() > MAX_RECENT) {
            var it = recentById.entrySet().iterator();
            it.next();
            it.remove();
        }
        if (!added.isEmpty()) revision++;
        return added;
    }

    /** Drops per-block highlights older than {@code now - maxAgeMs} (the recent feed is size-capped instead). */
    public synchronized void prune(long now, long maxAgeMs) {
        long cut = now - maxAgeMs;
        for (Map<Long, LedgerEvent> m : latestByPos.values()) m.values().removeIf(e -> e.ts() < cut);
    }

    /**
     * The latest change of each block in {@code dim} newer than {@code sinceTs}, optionally only by {@code bot}
     * (null/blank = all). This is what highlight rendering draws.
     */
    public synchronized List<LedgerEvent> latestPerBlock(String dim, long sinceTs, String bot) {
        Map<Long, LedgerEvent> m = latestByPos.get(Dims.normalize(dim));
        List<LedgerEvent> out = new ArrayList<>();
        if (m == null) return out;
        boolean all = bot == null || bot.isBlank();
        for (LedgerEvent e : m.values())
            if (e.ts() >= sinceTs && (all || e.bot().equalsIgnoreCase(bot))) out.add(e);
        return out;
    }

    /** Newest-first recent events (feed), at most {@code limit}, optionally by bot. */
    public synchronized List<LedgerEvent> recent(int limit, String bot) {
        List<LedgerEvent> all = new ArrayList<>(recentById.values());
        List<LedgerEvent> out = new ArrayList<>();
        boolean any = bot == null || bot.isBlank();
        for (int i = all.size() - 1; i >= 0 && out.size() < limit; i--)
            if (any || all.get(i).bot().equalsIgnoreCase(bot)) out.add(all.get(i));
        return out;
    }

    /** Latest live event at a block (no network), or null. */
    public synchronized LedgerEvent latestAt(int x, int y, int z, String dim) {
        Map<Long, LedgerEvent> m = latestByPos.get(Dims.normalize(dim));
        return m == null ? null : m.get(PosKey.pack(x, y, z));
    }

    /** Cached /mod/ledger/at answer (may be stale), or null. */
    public synchronized AtResult getAt(int x, int y, int z, String dim) { return atCache.get(atKey(x, y, z, dim)); }

    /** True (and marks in-flight) when the caller should fetch /mod/ledger/at for this block now. */
    public synchronized boolean beginFetch(int x, int y, int z, String dim, long now) {
        String k = atKey(x, y, z, dim);
        if (atInFlight.contains(k)) return false;
        Long failed = atFailedAt.get(k);
        if (failed != null && now - failed < AT_RETRY_MS) return false;
        AtResult r = atCache.get(k);
        if (r != null && now - r.fetchedAt() < AT_TTL_MS) return false;
        atInFlight.add(k);
        return true;
    }

    /** Stores a fetch result; r == null means it failed (keeps any old answer, retries after {@link #AT_RETRY_MS}). */
    public synchronized void endFetch(int x, int y, int z, String dim, AtResult r, long now) {
        String k = atKey(x, y, z, dim);
        atInFlight.remove(k);
        if (r != null) {
            atCache.put(k, r);
            atFailedAt.remove(k);
        } else {
            atFailedAt.put(k, now);
            if (atFailedAt.size() > MAX_AT) atFailedAt.remove(atFailedAt.keySet().iterator().next());
        }
    }

    public synchronized int size() { return recentById.size(); }
    public synchronized long revision() { return revision; }

    public synchronized void clear() {
        recentById.clear(); latestByPos.clear(); atCache.clear(); atInFlight.clear(); atFailedAt.clear(); revision++;
    }
}
