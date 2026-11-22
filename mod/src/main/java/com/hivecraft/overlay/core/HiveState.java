package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/**
 * Everything the overlay knows about the team, merged from the bridge's WS messages.
 * Thread-safe: the network thread writes via {@link #apply}; any thread (render thread) reads.
 * All getters return immutable snapshots, cheap to call every frame.
 */
public final class HiveState {
    public enum Connection { OFFLINE, CONNECTING, ONLINE }

    public static final int MAX_CHAT = 200, MAX_LOG = 400, MAX_EVENTS = 150, MAX_PHOTOS = 100;

    private final LongSupplier clock;
    private final Object lock = new Object();
    private final CopyOnWriteArrayList<HiveListener> listeners = new CopyOnWriteArrayList<>();
    private Consumer<String> errorLog = s -> {};

    // guarded by lock; published as immutable snapshots through volatile fields
    private final Map<String, BotState> botMap = new LinkedHashMap<>();
    private final Map<String, PathInfo> pathMap = new LinkedHashMap<>();
    private final ArrayDeque<ChatLine> chatQ = new ArrayDeque<>();
    private final Map<Integer, TaskInfo> boardMap = new LinkedHashMap<>();
    private final Map<String, Waypoint> waypointMap = new LinkedHashMap<>();
    private final Map<String, Ghost> ghostMap = new LinkedHashMap<>();
    private final ArrayDeque<Photo> photoQ = new ArrayDeque<>();
    private final ArrayDeque<LogLine> logQ = new ArrayDeque<>();
    private final ArrayDeque<BotEvent> eventQ = new ArrayDeque<>();

    private volatile List<BotState> bots = List.of();
    private volatile Map<String, PathInfo> paths = Map.of();
    private volatile List<ChatLine> chat = List.of();
    private volatile List<TaskInfo> board = List.of();
    private volatile List<Waypoint> waypoints = List.of();
    private volatile List<Ghost> ghosts = List.of();
    private volatile List<Photo> photos = List.of();
    private volatile List<LogLine> log = List.of();
    private volatile List<BotEvent> events = List.of();
    private volatile List<String> commands = List.of();
    private volatile Goal goal;

    private final TrailStore trails = new TrailStore();
    private final LedgerCache ledger = new LedgerCache();
    private final EconState econ = new EconState();

    private volatile Connection connection = Connection.OFFLINE;
    private volatile String lastError = "";
    private volatile long connectedSince, lastMessageAt, serverTimeOffset;
    private volatile int protocol;
    private volatile long revision;
    private volatile boolean ghostResync;

    public HiveState() { this(System::currentTimeMillis); }

    public HiveState(LongSupplier clock) { this.clock = clock; }

    public long now() { return clock.getAsLong(); }

    // ------------------------------------------------------------------ reads

    /** Bots sorted by name. */
    public List<BotState> bots() { return bots; }

    /** Bot by name (case-insensitive) or null. */
    public BotState bot(String name) {
        if (name == null) return null;
        for (BotState b : bots) if (b.name().equalsIgnoreCase(name)) return b;
        return null;
    }

    public PathInfo path(String bot) { return paths.get(bot); }
    public Map<String, PathInfo> paths() { return paths; }
    /** Oldest first. */
    public List<ChatLine> chat() { return chat; }
    /** Sorted by status (claimed, open, blocked, done), then priority desc, then id. */
    public List<TaskInfo> board() { return board; }
    public Goal goal() { return goal; }
    public List<Waypoint> waypoints() { return waypoints; }
    public List<Ghost> ghosts() { return ghosts; }
    public Ghost ghost(String id) { for (Ghost g : ghosts) if (g.id().equals(id)) return g; return null; }
    /** Newest first. */
    public List<Photo> photos() { return photos; }
    /** Oldest first. */
    public List<LogLine> log() { return log; }
    /** Oldest first. */
    public List<BotEvent> events() { return events; }
    /** Terminal command names from init (for completion). */
    public List<String> commands() { return commands; }
    public TrailStore trails() { return trails; }
    public LedgerCache ledger() { return ledger; }
    /** Economy (coins, shop, market, auctions): MOD_PROTOCOL.md §5. */
    public EconState econ() { return econ; }

    public Connection connection() { return connection; }
    public boolean online() { return connection == Connection.ONLINE; }
    public String lastError() { return lastError; }
    public long connectedSince() { return connectedSince; }
    public long lastMessageAt() { return lastMessageAt; }
    public int protocol() { return protocol; }
    /** serverTime - local time at init (normally ~0: same machine). */
    public long serverTimeOffset() { return serverTimeOffset; }
    /** Bumps on every applied message; UI can use it to skip rebuilding when unchanged. */
    public long revision() { return revision; }

    /** True once after a ghost summary arrived without blocks we don't have (client then sends {t:"ghosts"}). */
    public boolean takeGhostResync() {
        boolean r = ghostResync;
        ghostResync = false;
        return r;
    }

    // --------------------------------------------------------------- listeners

    public void addListener(HiveListener l) { listeners.add(l); }
    public void removeListener(HiveListener l) { listeners.remove(l); }
    public void setErrorLog(Consumer<String> log) { this.errorLog = log == null ? s -> {} : log; }

    private void fire(Consumer<HiveListener> c) {
        for (HiveListener l : listeners) {
            try { c.accept(l); } catch (Throwable t) { Guard.get().warn("listener", "listener " + l.getClass().getSimpleName() + " failed: " + t, t); }
        }
    }

    // ------------------------------------------------------------------ writes

    public void setConnection(Connection c, String error) {
        Connection old = connection;
        connection = c;
        if (error != null) lastError = error;
        if (c == Connection.ONLINE && old != Connection.ONLINE) { connectedSince = now(); lastError = ""; }
        if (old != c) fire(l -> l.onConnection(c));
    }

    /** Parses and applies one raw text message. Returns its type, or null if unparseable. */
    public String applyText(String text) {
        JsonObject o;
        try {
            var el = JsonParser.parseString(text);
            if (!el.isJsonObject()) return null;
            o = el.getAsJsonObject();
        } catch (RuntimeException e) {
            Guard.get().warn("net", "bad json from bridge: " + e.getMessage(), null);
            return null;
        }
        return apply(o);
    }

    /** Applies one server message. Unknown types are ignored (but still passed to onMessage). */
    public String apply(JsonObject m) {
        String t = J.str(m, "t", "");
        long now = now();
        lastMessageAt = now;
        try {
            switch (t) {
                case "init" -> applyInit(m, now);
                case "bots" -> applyBots(J.arr(m, "bots"), now, J.lng(m, "ts", now));
                case "path" -> applyPath(m);
                case "trail" -> trails.applyDelta(J.obj(m, "trails"));
                case "chat" -> { JsonObject c = J.obj(m, "msg"); if (c != null) addChat(ChatLine.parse(c), true); }
                case "board" -> applyBoard(m);
                case "goal" -> { Goal g = Goal.parse(J.obj(m, "goal")); goal = g; fire(l -> l.onGoal(g)); }
                case "waypoint" -> applyWaypoint(m);
                case "photo" -> { JsonObject p = J.obj(m, "photo"); if (p != null) addPhoto(Photo.parse(p), true); }
                case "ledger" -> applyLedger(J.arr(m, "events"));
                case "ghosts" -> applyGhosts(J.arr(m, "ghosts"));
                case "log" -> addLog(LogLine.parse(m), true);
                case "event" -> addEvent(BotEvent.parse(m), true);
                case "econ" -> econ.apply(m, now);
                case "hello_ok" -> { long st = J.lng(m, "serverTime", 0); if (st > 0) serverTimeOffset = st - now; }
                case "error" -> Guard.get().warn("bridge", "bridge says: " + J.str(m, "error", "?"), null);
                default -> {}
            }
        } catch (RuntimeException e) {
            Guard.get().warn("state", "failed to apply '" + t + "': " + e, e);
        }
        revision++;
        fire(l -> l.onMessage(t, m));
        return t;
    }

    private void applyInit(JsonObject m, long now) {
        protocol = J.integer(m, "protocol", 1);
        JsonObject pl = J.obj(m, "player"); // the human the bridge is configured for (hivecraft.config.json)
        if (pl != null) EconState.setBridgeName(J.str(pl, "name", null));
        long st = J.lng(m, "serverTime", 0);
        if (st > 0) serverTimeOffset = st - now;
        synchronized (lock) {
            chatQ.clear(); boardMap.clear(); waypointMap.clear(); ghostMap.clear(); photoQ.clear();
        }
        applyBots(J.arr(m, "bots"), now, st > 0 ? st : now);
        JsonArray chatA = J.arr(m, "chat");
        if (chatA != null) for (var e : chatA) { JsonObject o = J.obj(e); if (o != null) addChat(ChatLine.parse(o), false); }
        JsonArray boardA = J.arr(m, "board");
        synchronized (lock) {
            if (boardA != null) for (var e : boardA) { JsonObject o = J.obj(e); if (o != null) { TaskInfo ti = TaskInfo.parse(o); boardMap.put(ti.id(), ti); } }
            publishBoard();
            JsonArray wa = J.arr(m, "waypoints");
            if (wa != null) for (var e : wa) { JsonObject o = J.obj(e); if (o != null) { Waypoint w = Waypoint.parse(o); waypointMap.put(w.name(), w); } }
            waypoints = List.copyOf(waypointMap.values());
        }
        goal = Goal.parse(J.obj(m, "goal"));
        applyGhosts(J.arr(m, "ghosts"));
        JsonArray la = J.arr(m, "ledgerRecent");
        if (la != null) applyLedger(la);
        JsonArray pa = J.arr(m, "photos");
        if (pa != null) for (var e : pa) { JsonObject o = J.obj(e); if (o != null) addPhoto(Photo.parse(o), false); }
        JsonArray ca = J.arr(m, "commands");
        List<String> cmds = new ArrayList<>();
        if (ca != null) for (var e : ca) if (e.isJsonPrimitive()) cmds.add(e.getAsString());
        commands = Collections.unmodifiableList(cmds);
        JsonObject eo = J.obj(m, "econ");
        if (eo != null) econ.applySnapshot(eo);
    }

    private void applyBots(JsonArray arr, long now, long serverTs) {
        if (arr == null) return;
        List<BotState[]> changed = new ArrayList<>();
        synchronized (lock) {
            Map<String, BotState> next = new LinkedHashMap<>();
            for (var e : arr) {
                JsonObject o = J.obj(e);
                if (o == null) continue;
                String name = J.str(o, "name");
                if (name == null) continue;
                BotState prev = botMap.get(name);
                BotState b = BotState.parse(o, prev, now, serverTs);
                next.put(name, b);
                if (prev != null && !Objects.equals(prev.actionName(), b.actionName())) changed.add(new BotState[]{b, prev});
            }
            botMap.clear();
            botMap.putAll(next);
            List<BotState> sorted = new ArrayList<>(next.values());
            sorted.sort(Comparator.comparing(b -> b.name().toLowerCase()));
            bots = Collections.unmodifiableList(sorted);
        }
        for (BotState[] c : changed) fire(l -> l.onBotAction(c[0], c[1].actionName()));
    }

    private void applyPath(JsonObject m) {
        PathInfo p = PathInfo.parse(m);
        synchronized (lock) {
            if (p.cleared() && p.goal() == null) pathMap.remove(p.bot());
            else pathMap.put(p.bot(), p);
            paths = Map.copyOf(pathMap);
        }
    }

    /** Applies the {@code paths} object of GET /mod/trails (bot to PathMsg). */
    public void applyPaths(JsonObject pathsObj) {
        if (pathsObj == null) return;
        for (var en : pathsObj.entrySet()) {
            JsonObject p = J.obj(en.getValue());
            if (p == null) continue;
            if (!p.has("bot")) p.addProperty("bot", en.getKey());
            applyPath(p);
        }
        revision++;
    }

    private void addChat(ChatLine c, boolean notify) {
        synchronized (lock) {
            if (c.id() >= 0) for (ChatLine x : chatQ) if (x.id() == c.id()) return;
            chatQ.addLast(c);
            while (chatQ.size() > MAX_CHAT) chatQ.pollFirst();
            chat = List.copyOf(chatQ);
        }
        if (notify) fire(l -> l.onChat(c));
    }

    private static int statusRank(String s) {
        return switch (s == null ? "" : s) { case "claimed" -> 0; case "open" -> 1; case "blocked" -> 2; case "done" -> 3; default -> 4; };
    }

    private void publishBoard() {
        List<TaskInfo> l = new ArrayList<>(boardMap.values());
        l.sort(Comparator.comparingInt((TaskInfo t) -> statusRank(t.status())).thenComparing(t -> -t.priority()).thenComparingInt(TaskInfo::id));
        board = Collections.unmodifiableList(l);
    }

    private void applyBoard(JsonObject m) {
        JsonObject to = J.obj(m, "task");
        if (to == null) return;
        boolean deleted = J.bool(m, "deleted", false);
        TaskInfo t;
        synchronized (lock) {
            int id = J.integer(to, "id", -1);
            if (deleted) {
                TaskInfo old = boardMap.remove(id);
                t = old != null ? old : TaskInfo.parse(to);
            } else {
                t = TaskInfo.parse(to);
                boardMap.put(t.id(), t);
            }
            publishBoard();
        }
        fire(l -> l.onTask(t, deleted));
    }

    private void applyWaypoint(JsonObject m) {
        JsonObject w = J.obj(m, "waypoint");
        if (w == null) return;
        synchronized (lock) {
            Waypoint wp = Waypoint.parse(w);
            if (J.bool(m, "deleted", false)) waypointMap.remove(wp.name());
            else waypointMap.put(wp.name(), wp);
            waypoints = List.copyOf(waypointMap.values());
        }
    }

    private void addPhoto(Photo p, boolean notify) {
        synchronized (lock) {
            for (Photo x : photoQ) if (x.id().equals(p.id())) return;
            photoQ.addLast(p);
            while (photoQ.size() > MAX_PHOTOS) photoQ.pollFirst();
            List<Photo> l = new ArrayList<>(photoQ);
            l.sort(Comparator.comparingLong(Photo::ts).reversed());
            photos = Collections.unmodifiableList(l);
        }
        if (notify) fire(l -> l.onPhoto(p));
    }

    /** Merges photos from GET /mod/photos. */
    public void addPhotos(List<Photo> list) { for (Photo p : list) addPhoto(p, false); revision++; }

    private void addLog(LogLine line, boolean notify) {
        synchronized (lock) {
            logQ.addLast(line);
            while (logQ.size() > MAX_LOG) logQ.pollFirst();
            log = List.copyOf(logQ);
        }
        if (notify) fire(l -> l.onLog(line));
    }

    private void addEvent(BotEvent e, boolean notify) {
        synchronized (lock) {
            eventQ.addLast(e);
            while (eventQ.size() > MAX_EVENTS) eventQ.pollFirst();
            events = List.copyOf(eventQ);
        }
        if (notify) fire(l -> l.onEvent(e));
    }

    private void applyLedger(JsonArray arr) {
        if (arr == null) return;
        List<LedgerEvent> evs = new ArrayList<>();
        for (var e : arr) { JsonObject o = J.obj(e); if (o != null) evs.add(LedgerEvent.parse(o)); }
        List<LedgerEvent> added = ledger.addAll(evs);
        if (added.isEmpty()) return;
        // live-tick ghost cells
        synchronized (lock) {
            boolean changed = false;
            for (LedgerEvent e : added) {
                if (e.build() == null) continue;
                Ghost g = ghostMap.get(e.build());
                if (g == null) continue;
                GhostBlock cell = g.blockAt(e.x(), e.y(), e.z());
                if (cell == null) continue;
                boolean placed = e.isPlace() && sameBlock(cell.block(), e.block());
                Ghost ng = g.withPlaced(e.x(), e.y(), e.z(), placed);
                if (ng != g) { ghostMap.put(ng.id(), ng); changed = true; }
            }
            if (changed) ghosts = List.copyOf(ghostMap.values());
        }
        fire(l -> l.onLedger(added));
    }

    static boolean sameBlock(String a, String b) {
        if (a == null || b == null) return false;
        if (a.startsWith("minecraft:")) a = a.substring(10);
        if (b.startsWith("minecraft:")) b = b.substring(10);
        return a.equals(b);
    }

    private void applyGhosts(JsonArray arr) {
        if (arr == null) return;
        synchronized (lock) {
            Map<String, Ghost> next = new LinkedHashMap<>();
            for (var e : arr) {
                JsonObject o = J.obj(e);
                if (o == null) continue;
                String id = J.str(o, "id");
                if (id == null) continue;
                Ghost prev = ghostMap.get(id);
                Ghost g = Ghost.parse(o, prev);
                // summary without blocks for a ghost we never got blocks for: ask the bridge to resend
                if (!o.has("blocks") && g.blocks().isEmpty() && g.total() > 0) ghostResync = true;
                next.put(id, g);
            }
            ghostMap.clear();
            ghostMap.putAll(next);
            ghosts = List.copyOf(ghostMap.values());
        }
    }

    /** Replaces/adds one ghost with full blocks (GET /mod/ghosts/:id). */
    public void putGhost(JsonObject ghostObj) {
        if (ghostObj == null) return;
        synchronized (lock) {
            String id = J.str(ghostObj, "id");
            if (id == null) return;
            ghostMap.put(id, Ghost.parse(ghostObj, ghostMap.get(id)));
            ghosts = List.copyOf(ghostMap.values());
        }
        revision++;
    }

    /** Periodic cleanup (call ~1 Hz): trail/ledger decay and expired previews. */
    public void prune(long trailMaxAgeMs, long ledgerMaxAgeMs) {
        long now = now();
        trails.prune(now, trailMaxAgeMs);
        ledger.prune(now, ledgerMaxAgeMs);
        synchronized (lock) {
            long serverNow = now + serverTimeOffset;
            boolean rm = ghostMap.values().removeIf(g -> g.expires() > 0 && g.expires() < serverNow);
            if (rm) ghosts = List.copyOf(ghostMap.values());
        }
    }

    /** Forget everything (e.g. when switching bridges). */
    public void clear() {
        synchronized (lock) {
            botMap.clear(); pathMap.clear(); chatQ.clear(); boardMap.clear(); waypointMap.clear(); ghostMap.clear();
            photoQ.clear(); logQ.clear(); eventQ.clear();
            bots = List.of(); paths = Map.of(); chat = List.of(); board = List.of(); waypoints = List.of();
            ghosts = List.of(); photos = List.of(); log = List.of(); events = List.of(); commands = List.of(); goal = null;
        }
        trails.clear();
        ledger.clear();
        econ.clear();
        revision++;
    }
}
