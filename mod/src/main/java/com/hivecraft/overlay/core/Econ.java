package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Economy actions for the player over HTTP {@code /econ/*} (MOD_PROTOCOL.md §5), plus snapshot (re)loading.
 * Every call is async and never completes exceptionally: failures become {@link Result#error}, already logged
 * through {@link Guard}. Callers on the render thread just attach a callback (and hop back with
 * {@code MinecraftClient.execute}).
 */
public final class Econ {
    /** Outcome of an action: {@code error} is a readable sentence when !ok; {@code body} the raw answer (may be null). */
    public record Result(boolean ok, String error, JsonObject body) {
        static Result fail(String e) { return new Result(false, e, null); }

        /** The bridge's optional explanation of a partial result ({@code warning} or {@code note}), else null. */
        public String note() {
            String w = J.str(body, "warning");
            if (w == null || w.isBlank()) w = J.str(body, "note");
            return w == null || w.isBlank() ? null : w;
        }
    }

    private static final Econ INSTANCE = new Econ();
    private static final AtomicBoolean installed = new AtomicBoolean();

    private final AtomicBoolean loading = new AtomicBoolean();
    private volatile long lastLoad;
    private volatile String lastLoadError = "";

    private Econ() {}

    public static Econ get() { return INSTANCE; }

    public static EconState state() { return Hive.state().econ(); }

    /** Hooks the snapshot loader into the bridge feed (idempotent; call from UI init). */
    public static void install() {
        if (!installed.compareAndSet(false, true)) return;
        Hive.state().addListener(new HiveListener() {
            @Override
            public void onMessage(String type, JsonObject msg) {
                if ("init".equals(type) && J.obj(msg, "econ") == null) INSTANCE.refresh();
                else if ("econ".equals(type) && state().takeResync()) INSTANCE.refresh();
            }
        });
    }

    public String lastLoadError() { return lastLoadError; }

    /** Re-GETs /econ/state?who=<player> (one at a time). */
    public void refresh() {
        HiveClient c = Hive.client();
        if (c == null || !loading.compareAndSet(false, true)) return;
        lastLoad = System.currentTimeMillis();
        c.httpGet("/econ/state?who=" + HiveClient.q(EconState.who()))
                .thenAccept(o -> { state().applySnapshot(o); lastLoadError = ""; })
                .exceptionally(e -> {
                    lastLoadError = describe(e);
                    if (EconState.isOffError(lastLoadError)) state().setDisabled(lastLoadError);
                    Guard.get().warn("econ", "GET /econ/state failed: " + lastLoadError, null);
                    return null;
                })
                .whenComplete((v, e) -> loading.set(false));
    }

    /** Refreshes when never loaded or older than {@code maxAgeMs} (cheap; call when a screen opens). */
    public void refreshIfStale(long maxAgeMs) {
        EconState s = state();
        long age = System.currentTimeMillis() - Math.max(lastLoad, s.updatedAt());
        if (!s.loaded() || age > maxAgeMs) refresh();
    }

    public boolean loading() { return loading.get(); }

    // ------------------------------------------------------------------ actions (who = EconState.who())

    public CompletableFuture<Result> buy(String item, int count) { return post("/econ/shop/buy", body().item(item).num("count", count)); }

    public CompletableFuture<Result> sell(String item, int count) { return post("/econ/shop/sell", body().item(item).num("count", count)); }

    public CompletableFuture<Result> pay(String to, long amount, String note) {
        B b = body().str("to", to).num("amount", amount);
        if (note != null && !note.isBlank()) b.str("note", note.strip());
        return post("/econ/pay", b);
    }

    public CompletableFuture<Result> list(String item, int count, long priceEach) {
        return post("/econ/list", body().item(item).num("count", count).num("price", priceEach));
    }

    public CompletableFuture<Result> unlist(int id) { return post("/econ/unlist", body().num("id", id)); }

    /** count ≤ 0 = all that is left. */
    public CompletableFuture<Result> marketBuy(int id, int count) {
        B b = body().num("id", id);
        if (count > 0) b.num("count", count);
        return post("/econ/market/buy", b);
    }

    public CompletableFuture<Result> auction(String item, int count, long start, int minutes) {
        return post("/econ/auction", body().item(item).num("count", count).num("start", start).num("minutes", minutes));
    }

    public CompletableFuture<Result> bid(int id, long amount) { return post("/econ/bid", body().num("id", id).num("amount", amount)); }

    public CompletableFuture<Result> cancelAuction(int id) { return post("/econ/auction/cancel", body().num("id", id)); }

    public CompletableFuture<Result> openShop(String name) { return post("/econ/shops", body().str("name", name)); }

    // ------------------------------------------------------------------ earning (MOD_PROTOCOL.md §5 "Earning coins")

    /** Deliver items to server job {@code id}; count ≤ 0 = all it still wants. */
    public CompletableFuture<Result> deliver(int id, int count) {
        B b = body().num("id", id);
        if (count > 0) b.num("count", count);
        return post("/econ/jobs/deliver", b);
    }

    /** Put {@code amount} coins on board task {@code task} (post or raise a bounty). */
    public CompletableFuture<Result> bounty(int task, long amount) { return post("/econ/bounty", body().num("task", task).num("amount", amount)); }

    /** Take back the player's share of the bounty on {@code task}. */
    public CompletableFuture<Result> cancelBounty(int task) { return post("/econ/bounty/cancel", body().num("task", task)); }

    /** New board task by the player with {@code reward} coins escrowed (0 = no reward). Answer = the task object. */
    public CompletableFuture<Result> postTask(String title, long reward) {
        B b = new B().str("by", EconState.who()).str("title", title);
        if (reward > 0) b.num("reward", reward);
        return post("/board", b);
    }

    /** Re-reads GET /econ/earnings?who=<player> into the state (cheap; the Jobs view's ↻). */
    public void refreshEarnings() {
        HiveClient c = Hive.client();
        if (c == null) return;
        c.httpGet("/econ/earnings?who=" + HiveClient.q(EconState.who()))
                .thenAccept(o -> state().applyEarnings(o))
                .exceptionally(e -> {
                    String why = describe(e);
                    if (EconState.isOffError(why)) state().setDisabled(why);
                    return null;
                });
    }

    // ------------------------------------------------------------------ plumbing

    private static final class B {
        final JsonObject o = new JsonObject();
        B str(String k, String v) { o.addProperty(k, v); return this; }
        B num(String k, long v) { o.addProperty(k, v); return this; }
        B item(String v) { o.addProperty("item", EconText.normItem(v)); return this; }
    }

    private static B body() { return new B().str("who", EconState.who()); }

    private CompletableFuture<Result> post(String path, B b) {
        HiveClient c = Hive.client();
        if (c == null) return CompletableFuture.completedFuture(Result.fail("Hivecraft is not started"));
        try {
            return c.httpPost(path, b.o).handle((o, e) -> {
                if (e != null) {
                    String why = describe(e);
                    Guard.get().warn("econ", "POST " + path + " failed: " + why, null);
                    return Result.fail("Bridge unreachable (" + why + ")");
                }
                Result r = parseResult(o);
                if (r.ok()) afterOk(o);
                return r;
            });
        } catch (RuntimeException e) {
            Guard.get().warn("econ", "POST " + path + " failed: " + e, e);
            return CompletableFuture.completedFuture(Result.fail(String.valueOf(e.getMessage())));
        }
    }

    /** {ok:false,error} / {ok:true,...} → Result. Package-visible for tests. */
    static Result parseResult(JsonObject o) {
        if (o == null) return Result.fail("empty answer");
        // POST /board answers with the task itself (no "ok"): an id means it worked
        boolean ok = J.bool(o, "ok", !o.has("ok") && !o.has("error") && o.has("id"));
        if (ok) return new Result(true, null, o);
        String err = J.str(o, "error", null);
        return new Result(false, err == null || err.isBlank() ? "request refused" : err, o);
    }

    private void afterOk(JsonObject o) {
        try {
            Double bal = J.numOrNull(o, "balance");
            if (bal != null) {
                Double h = J.numOrNull(o, "held");
                state().setMyBalance(bal.longValue(), h == null ? null : h.longValue());
            }
            if (J.obj(o, "job") != null || J.obj(o, "bounty") != null) state().applyEarnAnswer(o);
            // without the live socket nothing pushes the change: reload the snapshot
            if (!Hive.state().online()) refresh();
        } catch (RuntimeException e) {
            Guard.get().warn("econ", "after-action update failed: " + e, e);
        }
    }

    private static String describe(Throwable t) {
        Throwable c = t;
        while (c.getCause() != null && c.getCause() != c) c = c.getCause();
        String m = c.getMessage();
        return m != null && !m.isBlank() ? m : c.getClass().getSimpleName();
    }
}
