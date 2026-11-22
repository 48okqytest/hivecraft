package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Walked-position breadcrumbs per bot (newest last). Thread-safe. */
public final class TrailStore {
    public record Point(double x, double y, double z, long ts) {}

    public static final int MAX_POINTS = 600;

    private final Map<String, ArrayDeque<Point>> trails = new HashMap<>();

    /** Appends points (rows {@code [x,y,z,ts]}); ignores points not newer than the last stored one. */
    public synchronized void append(String bot, JsonArray rows) {
        if (rows == null) return;
        ArrayDeque<Point> q = trails.computeIfAbsent(bot, k -> new ArrayDeque<>());
        for (var e : rows) {
            JsonArray r = J.arr(e);
            if (r == null || r.size() < 4) continue;
            add(q, new Point(J.at(r, 0, 0), J.at(r, 1, 0), J.at(r, 2, 0), (long) J.at(r, 3, 0)));
        }
    }

    public synchronized void add(String bot, Point p) {
        add(trails.computeIfAbsent(bot, k -> new ArrayDeque<>()), p);
    }

    private static void add(ArrayDeque<Point> q, Point p) {
        Point last = q.peekLast();
        if (last != null && p.ts() <= last.ts()) return;
        q.addLast(p);
        while (q.size() > MAX_POINTS) q.pollFirst();
    }

    /** Applies a {@code trail} message's {@code trails} object (bot to rows). */
    public synchronized void applyDelta(JsonObject trailsObj) {
        if (trailsObj == null) return;
        for (var en : trailsObj.entrySet()) append(en.getKey(), J.arr(en.getValue()));
    }

    /** Replaces everything with a full snapshot (GET /mod/trails), keeping newer local points. */
    public synchronized void applyFull(JsonObject trailsObj) {
        if (trailsObj == null) return;
        for (var en : trailsObj.entrySet()) {
            ArrayDeque<Point> old = trails.get(en.getKey());
            ArrayDeque<Point> q = new ArrayDeque<>();
            trails.put(en.getKey(), q);
            append(en.getKey(), J.arr(en.getValue()));
            if (old != null) for (Point p : old) add(q, p); // only those newer than the snapshot get in
        }
    }

    /** Drops points older than {@code now - maxAgeMs}. */
    public synchronized void prune(long now, long maxAgeMs) {
        long cut = now - maxAgeMs;
        trails.values().forEach(q -> { while (!q.isEmpty() && q.peekFirst().ts() < cut) q.pollFirst(); });
        trails.values().removeIf(ArrayDeque::isEmpty);
    }

    /** Points of one bot newer than {@code now - maxAgeMs}, oldest first (copy). */
    public synchronized List<Point> get(String bot, long now, long maxAgeMs) {
        ArrayDeque<Point> q = trails.get(bot);
        List<Point> out = new ArrayList<>();
        if (q == null) return out;
        long cut = now - maxAgeMs;
        for (Point p : q) if (p.ts() >= cut) out.add(p);
        return out;
    }

    public synchronized List<String> bots() { return new ArrayList<>(trails.keySet()); }

    public synchronized void clear() { trails.clear(); }
}
