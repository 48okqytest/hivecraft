package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Connection to the Hivecraft bridge: WebSocket ws://host/mod with auto-reconnect, plus async HTTP helpers.
 * Nothing here ever blocks the caller: all network work runs on a daemon scheduler / HttpClient threads.
 * Never sends an Origin header (the bridge refuses cross-origin).
 */
public final class HiveClient {
    private static final long[] BACKOFF_MS = {1000, 2000, 5000, 10000, 15000};
    private static final long STALE_MS = 25_000;
    private static final long COMMAND_TIMEOUT_MS = 15_000;

    private final HiveState state;
    private final Supplier<HiveConfig> config;
    private final String modVersion;
    private final ScheduledExecutorService sched = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "hivecraft-net");
        t.setDaemon(true);
        return t;
    });
    private final HttpClient http;
    private final Map<String, CompletableFuture<CommandResult>> pending = new ConcurrentHashMap<>();
    private final AtomicLong cmdIds = new AtomicLong(1);
    private Consumer<String> log = s -> {};

    private volatile WebSocket ws;
    private volatile boolean running;
    private volatile int attempt;
    private volatile long generation;
    private volatile PlayerInfo player;
    private volatile String lastSentPlayer = "";
    private volatile long lastPlayerSend;

    public HiveClient(HiveState state, Supplier<HiveConfig> config, String modVersion) {
        this.state = state;
        this.config = config;
        this.modVersion = modVersion;
        // HTTP/1.1 only: Java otherwise asks to upgrade to h2c, which the bridge (Node + ws) answers with a bare 404
        this.http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(3)).build();
    }

    public void setLog(Consumer<String> log) { this.log = log == null ? s -> {} : log; }
    public HiveState state() { return state; }

    // ------------------------------------------------------------ lifecycle

    /** Starts connecting (idempotent). */
    public synchronized void start() {
        if (running) return;
        running = true;
        sched.scheduleWithFixedDelay(this::housekeeping, 1, 1, TimeUnit.SECONDS);
        sched.execute(this::connect);
    }

    /** Closes the socket and stops reconnecting. */
    public synchronized void stop() {
        running = false;
        generation++;
        WebSocket w = ws;
        ws = null;
        abort(w);
        state.setConnection(HiveState.Connection.OFFLINE, "stopped");
        failPending("disconnected");
    }

    /** Drops the current socket and reconnects now (e.g. after the bridge URL changed). */
    public void reconnectNow() {
        sched.execute(() -> {
            generation++;
            WebSocket w = ws;
            ws = null;
            abort(w);
            attempt = 0;
            if (running) connect();
        });
    }

    private static void abort(WebSocket w) {
        if (w == null) return;
        try { w.abort(); } catch (Exception e) { Guard.get().warn("net", "socket abort failed: " + e, null); }
    }

    public boolean isOpen() { WebSocket w = ws; return w != null && !w.isOutputClosed() && state.online(); }

    private void connect() {
        if (!running || ws != null) return;
        final long gen = ++generation;
        state.setConnection(HiveState.Connection.CONNECTING, null);
        URI uri;
        try { uri = URI.create(config.get().wsUrl()); }
        catch (Exception e) { onDown(gen, "bad bridge url: " + e.getMessage()); return; }
        http.newWebSocketBuilder()
                .connectTimeout(Duration.ofSeconds(4))
                .buildAsync(uri, new Listener(gen))
                .whenComplete((w, err) -> {
                    if (err != null) { onDown(gen, describe(err)); return; }
                    if (gen != generation || !running) { w.abort(); return; }
                    ws = w;
                    attempt = 0;
                    state.setConnection(HiveState.Connection.ONLINE, null);
                    sendHello();
                    loadTrails();
                });
    }

    private void onDown(long gen, String why) {
        final long next;
        synchronized (this) {
            if (gen != generation) return; // superseded (onClose + onError both fire, or a newer socket exists)
            next = ++generation;
        }
        ws = null;
        failPending("bridge disconnected");
        state.setConnection(HiveState.Connection.OFFLINE, why);
        if (!running) return;
        long delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt++;
        sched.schedule(() -> { if (next == generation) connect(); }, delay, TimeUnit.MILLISECONDS);
    }

    private static String describe(Throwable t) {
        Throwable c = t;
        while (c.getCause() != null && c.getCause() != c) c = c.getCause();
        String m = c.getMessage();
        return c.getClass().getSimpleName() + (m != null ? ": " + m : "");
    }

    private void housekeeping() {
        try {
            HiveConfig c = config.get();
            state.prune(c.trailSeconds * 1000L + 5000, c.ledgerFadeSeconds * 1000L + 5000);
            long now = System.currentTimeMillis();
            if (isOpen()) {
                if (now - state.lastMessageAt() > STALE_MS) {
                    log.accept("bridge silent for " + STALE_MS / 1000 + "s, reconnecting");
                    WebSocket w = ws;
                    abort(w);
                    onDown(generation, "no data from bridge");
                    return;
                }
                PlayerInfo p = player;
                if (p != null) {
                    String js = p.toJson().toString();
                    // send at ~1 Hz, and skip when nothing changed for 5 s
                    if (!js.equals(lastSentPlayer) || now - lastPlayerSend > 5000) {
                        JsonObject o = p.toJson();
                        o.addProperty("t", "player");
                        if (send(o)) { lastSentPlayer = js; lastPlayerSend = now; }
                    }
                }
            }
        } catch (Throwable t) {
            Guard.get().fail("net.housekeeping", t);
        }
    }

    private final class Listener implements WebSocket.Listener {
        private final long gen;
        private final StringBuilder buf = new StringBuilder();

        Listener(long gen) { this.gen = gen; }

        @Override public void onOpen(WebSocket webSocket) { webSocket.request(1); }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            buf.append(data);
            if (last) {
                String s = buf.toString();
                buf.setLength(0);
                if (gen == generation) handleText(s);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            onDown(gen, "closed " + statusCode + (reason == null || reason.isEmpty() ? "" : " " + reason));
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) { onDown(gen, describe(error)); }
    }

    private void handleText(String s) {
        JsonObject o;
        try {
            JsonElement el = JsonParser.parseString(s);
            if (!el.isJsonObject()) return;
            o = el.getAsJsonObject();
        } catch (RuntimeException e) {
            Guard.get().warn("net", "bad message: " + e.getMessage(), null);
            return;
        }
        String t = J.str(o, "t", "");
        if ("command_result".equals(t)) {
            JsonElement id = J.get(o, "id");
            CompletableFuture<CommandResult> f = id == null ? null : pending.remove(id.getAsString());
            if (f != null) f.complete(CommandResult.parse(o));
        }
        state.apply(o);
        if (state.takeGhostResync()) {
            long now = System.currentTimeMillis();
            if (now - lastGhostResync > 5000) {
                lastGhostResync = now;
                JsonObject req = new JsonObject();
                req.addProperty("t", "ghosts");
                send(req);
            }
        }
    }
    private volatile long lastGhostResync;

    // ----------------------------------------------------------------- sending

    /** Sends a JSON message on the socket. Returns false when not connected. Thread-safe. */
    public boolean send(JsonObject msg) {
        WebSocket w = ws;
        if (w == null || w.isOutputClosed()) return false;
        String text = msg.toString();
        synchronized (this) {
            // java.net.http.WebSocket allows one outstanding send: chain on the previous one, per socket
            // (a dead socket's unfinished send must not block the next socket's queue)
            if (sendChainOwner != w) { sendChainOwner = w; sendChain = CompletableFuture.completedFuture(null); }
            sendChain = sendChain.handle((v, e) -> null).thenCompose(v -> w.sendText(text, true).thenApply(x -> null));
            sendChain.exceptionally(e -> { Guard.get().warn("net", "send failed: " + describe(e), null); return null; });
        }
        return true;
    }
    private CompletableFuture<Object> sendChain = CompletableFuture.completedFuture(null);
    private WebSocket sendChainOwner;

    private void sendHello() {
        JsonObject o = new JsonObject();
        o.addProperty("t", "hello");
        o.addProperty("player", playerName());
        o.addProperty("version", modVersion);
        send(o);
        lastSentPlayer = "";
    }

    private String playerName() {
        String n = config.get().playerName;
        if (n != null && !n.isBlank()) return n.trim();
        PlayerInfo p = player;
        return p != null && p.name() != null ? p.name() : EconState.DEFAULT_ME;
    }

    /** Called by the client thread (each tick or so) with the player's position; sent ~1 Hz. */
    public void updatePlayer(PlayerInfo p) {
        String n = config.get().playerName;
        if (p != null && n != null && !n.isBlank()) p = new PlayerInfo(n.trim(), p.x(), p.y(), p.z(), p.dim(), p.yaw(), p.look());
        player = p;
        if (p != null) EconState.setLocalName(p.name());
    }

    public PlayerInfo player() { return player; }

    /**
     * Runs a terminal command (e.g. "status Ash"). Over the socket when connected, else POST /mod/command.
     * Never completes exceptionally: errors become {@link CommandResult#error}.
     */
    public CompletableFuture<CommandResult> sendCommand(String text) {
        PlayerInfo p = player;
        if (isOpen()) {
            String id = "c" + cmdIds.getAndIncrement();
            CompletableFuture<CommandResult> f = new CompletableFuture<>();
            pending.put(id, f);
            JsonObject o = new JsonObject();
            o.addProperty("t", "command");
            o.addProperty("id", id);
            o.addProperty("text", text);
            if (p != null) o.add("player", p.toJson());
            if (!send(o)) { pending.remove(id); return commandOverHttp(text, p); }
            sched.schedule(() -> {
                CompletableFuture<CommandResult> x = pending.remove(id);
                if (x != null) x.complete(CommandResult.error("command timed out"));
            }, COMMAND_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            return f;
        }
        return commandOverHttp(text, p);
    }

    private CompletableFuture<CommandResult> commandOverHttp(String text, PlayerInfo p) {
        JsonObject body = new JsonObject();
        body.addProperty("text", text);
        if (p != null) body.add("player", p.toJson());
        return httpPost("/mod/command", body)
                .thenApply(CommandResult::parse)
                .exceptionally(e -> CommandResult.error("Hivecraft bridge offline (" + describe(e) + ")"));
    }

    private void failPending(String why) {
        for (var k : new ArrayList<>(pending.keySet())) {
            CompletableFuture<CommandResult> f = pending.remove(k);
            if (f != null) f.complete(CommandResult.error(why));
        }
    }

    // -------------------------------------------------------------------- HTTP

    private HttpRequest.Builder req(String pathAndQuery) {
        String p = pathAndQuery.startsWith("/") ? pathAndQuery : "/" + pathAndQuery;
        return HttpRequest.newBuilder(URI.create(config.get().httpBase() + p)).timeout(Duration.ofSeconds(8));
    }

    /** GET a JSON object. Fails the future on network error, non-2xx, or {ok:false}. */
    public CompletableFuture<JsonObject> httpGet(String pathAndQuery) {
        try {
            return http.sendAsync(req(pathAndQuery).GET().build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                    .thenApply(HiveClient::jsonBody);
        } catch (Exception e) {
            return CompletableFuture.failedFuture(e);
        }
    }

    /** POST a JSON body, returns the JSON answer. */
    public CompletableFuture<JsonObject> httpPost(String path, JsonObject body) {
        try {
            HttpRequest r = req(path).header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8)).build();
            return http.sendAsync(r, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).thenApply(HiveClient::jsonBodyLenient);
        } catch (Exception e) {
            return CompletableFuture.failedFuture(e);
        }
    }

    /** Raw bytes (e.g. a photo PNG: {@code fetchBytes(photo.url())}). */
    public CompletableFuture<byte[]> fetchBytes(String pathOrUrl) {
        try {
            URI u = pathOrUrl.startsWith("http") ? URI.create(pathOrUrl) : URI.create(config.get().httpBase() + (pathOrUrl.startsWith("/") ? "" : "/") + pathOrUrl);
            return http.sendAsync(HttpRequest.newBuilder(u).timeout(Duration.ofSeconds(15)).GET().build(), HttpResponse.BodyHandlers.ofByteArray())
                    .thenApply(r -> {
                        if (r.statusCode() / 100 != 2) throw new IllegalStateException("HTTP " + r.statusCode());
                        return r.body();
                    });
        } catch (Exception e) {
            return CompletableFuture.failedFuture(e);
        }
    }

    private static JsonObject jsonBody(HttpResponse<String> r) {
        JsonObject o = jsonBodyLenient(r);
        if (r.statusCode() / 100 != 2 || !J.bool(o, "ok", true))
            throw new IllegalStateException(J.str(o, "error", "HTTP " + r.statusCode()));
        return o;
    }

    /** Parses the body even on 4xx (so {ok:false,error} answers reach the caller). */
    private static JsonObject jsonBodyLenient(HttpResponse<String> r) {
        JsonElement el;
        try { el = JsonParser.parseString(r.body()); } catch (RuntimeException e) { throw new IllegalStateException("HTTP " + r.statusCode() + ": not JSON"); }
        if (!el.isJsonObject()) throw new IllegalStateException("HTTP " + r.statusCode() + ": not an object");
        JsonObject o = el.getAsJsonObject();
        if (r.statusCode() / 100 != 2 && !o.has("ok")) o.addProperty("ok", false);
        return o;
    }

    static String q(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }

    // ---------------------------------------------------------- convenience

    /** Loads full trail buffers + current paths (the WS only sends deltas). */
    public void loadTrails() {
        httpGet("/mod/trails").thenAccept(o -> {
            state.trails().applyFull(J.obj(o, "trails"));
            state.applyPaths(J.obj(o, "paths"));
        }).exceptionally(e -> { Guard.get().warn("net", "GET /mod/trails failed: " + describe(e), null); return null; });
    }

    /** Fetches more photos (newest first) into the state; completes with the list. */
    public CompletableFuture<List<Photo>> loadPhotos(String bot, int limit) {
        String qs = "/mod/photos?limit=" + limit + (bot != null && !bot.isBlank() ? "&bot=" + q(bot) : "");
        return httpGet(qs).thenApply(o -> {
            List<Photo> out = new ArrayList<>();
            JsonArray a = J.arr(o, "photos");
            if (a != null) for (var e : a) { JsonObject po = J.obj(e); if (po != null) out.add(Photo.parse(po)); }
            state.addPhotos(out);
            return out;
        });
    }

    /**
     * Who placed/broke this block. Returns the cached answer immediately (possibly null while loading) and fetches
     * /mod/ledger/at in the background when missing or older than 20 s. Safe to call every frame.
     */
    public LedgerCache.AtResult ledgerAt(int x, int y, int z, String dim) {
        LedgerCache lc = state.ledger();
        String d = Dims.normalize(dim);
        if (lc.beginFetch(x, y, z, d, System.currentTimeMillis())) {
            httpGet("/mod/ledger/at?x=" + x + "&y=" + y + "&z=" + z + "&dim=" + d)
                    .thenAccept(o -> lc.endFetch(x, y, z, d, LedgerCache.AtResult.parse(o, System.currentTimeMillis()), System.currentTimeMillis()))
                    .exceptionally(e -> {
                        lc.endFetch(x, y, z, d, null, System.currentTimeMillis());
                        Guard.get().warn("net", "GET /mod/ledger/at failed: " + describe(e), null);
                        return null;
                    });
        }
        return lc.getAt(x, y, z, d);
    }

    /** Fetches one ghost with all blocks (e.g. when the summary came without them). */
    public CompletableFuture<Void> refreshGhost(String id) {
        return httpGet("/mod/ghosts/" + q(id)).thenAccept(o -> state.putGhost(J.obj(o, "ghost")));
    }
}
