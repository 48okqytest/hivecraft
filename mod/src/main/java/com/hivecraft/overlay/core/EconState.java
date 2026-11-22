package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * The economy as the overlay sees it (MOD_PROTOCOL.md §5): the player's wallet, everyone's balances, the server shop,
 * market listings, auctions and the player's recent transactions. Fed by {@code init.econ}, {@code GET /econ/state}
 * snapshots and {@code {t:"econ"}} deltas. Thread-safe like {@link HiveState}: writers lock, readers get immutable
 * snapshots through volatile fields. Pure logic (no Minecraft classes), unit-tested.
 */
public final class EconState {
    /** Account name used until we know who the local player is. */
    public static final String DEFAULT_ME = "Player";
    // Who the mod acts as on /econ/* (and who "me" is before a snapshot). The bridge's init {player:{name}} (the
    // human from hivecraft.config.json) wins; else the local player's name (HiveConfig.playerName or the
    // Minecraft session name), which the bridge resolves to the account through the Minecraft-name alias.
    private static volatile String bridgeName, localName;

    /** The name sent as {@code who} on /econ/* requests. */
    public static String who() {
        String b = bridgeName, l = localName;
        return b != null ? b : l != null ? l : DEFAULT_ME;
    }
    /** The bridge told us the human's account name (init.player.name); null/blank = forget it. */
    public static void setBridgeName(String n) { bridgeName = n == null || n.isBlank() ? null : n.trim(); }
    /** The local player's Minecraft name (or HiveConfig.playerName); null/blank = forget it. */
    public static void setLocalName(String n) { localName = n == null || n.isBlank() ? null : n.trim(); }
    public static final int MAX_TX = 120;

    // ------------------------------------------------------------------ models

    /** Server shop row. {@code buy}/{@code sell} = coins per item, null = not offered. */
    public record ShopItem(String item, Integer buy, Integer sell, String cat) {
        static ShopItem parse(JsonObject o) {
            return new ShopItem(EconText.normItem(J.str(o, "item", "")), intOrNull(o, "buy"), intOrNull(o, "sell"), J.str(o, "cat", "misc"));
        }
    }

    public record Shop(String owner, String name, String description, long created, int listings) {
        static Shop parse(JsonObject o) {
            return new Shop(J.str(o, "owner", "?"), J.str(o, "name", ""), J.str(o, "description", ""), J.lng(o, "created", 0), J.integer(o, "listings", 0));
        }
    }

    /** Market listing; {@code count} = remaining, {@code price} = coins each. */
    public record Listing(int id, String seller, String shop, String item, int count, int price, long ts) {
        static Listing parse(JsonObject o) {
            return new Listing(J.integer(o, "id", -1), J.str(o, "seller", "?"), J.str(o, "shop", ""), EconText.normItem(J.str(o, "item", "")),
                    J.integer(o, "count", 0), J.integer(o, "price", 0), J.lng(o, "ts", 0));
        }

        public long total() { return (long) count * price; }
    }

    public record Auction(int id, String seller, String item, int count, int start, Integer bid, String bidder, int bids,
                          int minNext, long created, long endsAt, String status, boolean ended, String winner) {
        /** Parses an auction; missing fields fall back to {@code prev} (deltas are complete, but be tolerant). */
        static Auction parse(JsonObject o, Auction prev) {
            boolean has = prev != null;
            int start = J.integer(o, "start", has ? prev.start : 1);
            Integer bid = o.has("bid") ? intOrNull(o, "bid") : (has ? prev.bid : null);
            String bidder = o.has("bidder") ? J.str(o, "bidder") : (has ? prev.bidder : null);
            int minNext = J.integer(o, "minNext", EconText.minNextBid(bid, start));
            String status = J.str(o, "status", has ? prev.status : "open");
            boolean ended = J.bool(o, "ended", has ? prev.ended : !"open".equals(status));
            String winner = o.has("winner") ? J.str(o, "winner") : (has ? prev.winner : null);
            return new Auction(J.integer(o, "id", has ? prev.id : -1),
                    J.str(o, "seller", has ? prev.seller : "?"),
                    o.has("item") ? EconText.normItem(J.str(o, "item", "")) : (has ? prev.item : ""),
                    J.integer(o, "count", has ? prev.count : 1), start, bid, bidder,
                    J.integer(o, "bids", has ? prev.bids : 0), minNext,
                    J.lng(o, "created", has ? prev.created : 0), J.lng(o, "endsAt", has ? prev.endsAt : 0),
                    status, ended || !"open".equals(status), winner);
        }

        public boolean open() { return !ended && "open".equals(status); }
        /** The current price of the lot: the top bid, else the start price. */
        public int price() { return bid != null ? bid : start; }
    }

    public record Tx(long id, long ts, String kind, String from, String to, long amount, String item, int count, String note) {
        static Tx parse(JsonObject o) {
            String item = J.str(o, "item");
            return new Tx(J.lng(o, "id", -1), J.lng(o, "ts", 0), J.str(o, "kind", "?"), J.str(o, "from", "?"), J.str(o, "to", "?"),
                    J.lng(o, "amount", 0), item == null ? null : EconText.normItem(item), J.integer(o, "count", 0), J.str(o, "note"));
        }

        public boolean involves(String who) { return EconText.same(from, who) || EconText.same(to, who); }

        /** Coins in (+) / out (−) for {@code who}. */
        public long delta(String who) {
            if (EconText.same(to, who) && !EconText.same(from, who)) return amount;
            if (EconText.same(from, who) && !EconText.same(to, who)) return -amount;
            return 0;
        }
    }

    public record Delivery(long id, String to, String item, int count, String reason, long ts) {
        static Delivery parse(JsonObject o) {
            return new Delivery(J.lng(o, "id", -1), J.str(o, "to", "?"), EconText.normItem(J.str(o, "item", "")), J.integer(o, "count", 0),
                    J.str(o, "reason", ""), J.lng(o, "ts", 0));
        }
    }

    /**
     * Something that happened to the player (for the HUD ticker). {@code coins} is signed (0 = none). For
     * {@code EARNED} / {@code WORLD_FIRST}, {@code other} is the earning source (mob, job, bounty, milestone, wage).
     */
    public record Notice(Kind kind, String text, String item, long coins, String other, long ts) {
        public enum Kind { BOUGHT, SOLD, PAID, RECEIVED, OUTBID, WON, AUCTION_SOLD, AUCTION_UNSOLD, DELIVERED, RESET,
            /** The player earned coins (mob kill, job, bounty, milestone, wage). */ EARNED,
            /** Coins the player put on a bounty came back. */ BOUNTY_REFUND,
            /** Someone else got a world-first milestone. */ WORLD_FIRST }
    }

    // ------------------------------------------------------------------ state

    private final Object lock = new Object();
    private final CopyOnWriteArrayList<Consumer<Notice>> listeners = new CopyOnWriteArrayList<>();

    private final Map<String, Long> walletMap = new LinkedHashMap<>();
    private final Map<Integer, Listing> listingMap = new LinkedHashMap<>();
    private final Map<Integer, Auction> auctionMap = new LinkedHashMap<>();
    private final Map<String, Shop> shopMap = new LinkedHashMap<>();
    private final ArrayDeque<Tx> txQ = new ArrayDeque<>(); // newest first
    private final EarnState earn = new EarnState();
    private volatile String disabled; // non-null = the bridge says the economy is turned off

    private volatile boolean loaded;
    private volatile String world = "";
    private volatile String currency = "coins";
    private volatile long rev = -1;
    private volatile long startBalance = 100;
    private volatile String me = who();
    private volatile long balance, held;
    private volatile Map<String, Long> wallets = Map.of();
    private volatile List<ShopItem> shop = List.of();
    private volatile List<Shop> shops = List.of();
    private volatile List<Listing> listings = List.of();
    private volatile List<Auction> auctions = List.of();
    private volatile List<Tx> tx = List.of();
    private volatile List<Delivery> deliveries = List.of();
    private volatile List<String> sales = List.of();
    private volatile boolean resync;
    private volatile long revision;
    private volatile long updatedAt;

    // ------------------------------------------------------------------ reads

    /** Jobs, bounties, mob bounty rates, milestones, wage and the player's earnings (MOD_PROTOCOL.md §5). */
    public EarnState earn() { return earn; }

    /** The bridge's sentence when the economy is turned off for this game, else null. */
    public String disabled() { return disabled; }

    /** Marks the economy as turned off (an /econ call answered so); a later snapshot clears it. */
    public void setDisabled(String reason) {
        synchronized (lock) {
            disabled = reason == null || reason.isBlank() ? "the economy is turned off" : reason;
            revision++;
        }
    }

    /** True when an /econ error sentence means "the economy is off for this game" (HTTP 404 from the bridge). */
    public static boolean isOffError(String err) {
        if (err == null) return false;
        String e = err.toLowerCase(java.util.Locale.ROOT);
        return e.contains("economy") && (e.contains("turned off") || e.contains(" is off") || e.contains("disabled"));
    }

    /** True once a snapshot arrived (init.econ or GET /econ/state). */
    public boolean loaded() { return loaded; }
    public String world() { return world; }
    public String currency() { return currency; }
    public long rev() { return rev; }
    public long startBalance() { return startBalance; }
    /** The player's account name as the bridge shows it. */
    public String me() { return me; }
    public long balance() { return balance; }
    /** Coins locked in the player's winning bids (not in balance). */
    public long held() { return held; }
    /** Name → balance, richest first. */
    public Map<String, Long> wallets() { return wallets; }
    public List<ShopItem> shop() { return shop; }
    public List<Shop> shops() { return shops; }
    /** Open listings, cheapest each first. */
    public List<Listing> listings() { return listings; }
    /** Open auctions (ending soonest first), then ended ones (newest first). */
    public List<Auction> auctions() { return auctions; }
    /** Transactions involving the player, newest first. */
    public List<Tx> tx() { return tx; }
    /** Items queued for the player (they were offline). */
    public List<Delivery> deliveries() { return deliveries; }
    /** Recent sale lines from {@code kind:"sale"}, newest first. */
    public List<String> sales() { return sales; }
    /** Bumps on every change (UI caches). */
    public long revision() { return revision; }
    public long updatedAt() { return updatedAt; }

    public ShopItem shopItem(String item) {
        String n = EconText.normItem(item);
        for (ShopItem s : shop) if (s.item().equals(n)) return s;
        return null;
    }

    public Auction auction(int id) { for (Auction a : auctions) if (a.id() == id) return a; return null; }
    public Listing listing(int id) { for (Listing l : listings) if (l.id() == id) return l; return null; }
    public Shop shopOf(String owner) { for (Shop s : shops) if (EconText.same(s.owner(), owner)) return s; return null; }

    public boolean isMe(String name) { return EconText.same(name, me) || EconText.same(name, who()); }

    /** True once after a rev gap was seen: the caller should re-GET /econ/state. */
    public boolean takeResync() {
        boolean r = resync;
        resync = false;
        return r;
    }

    public void requestResync() { resync = true; }

    // ------------------------------------------------------------------ listeners

    public void addListener(Consumer<Notice> l) { listeners.add(l); }
    public void removeListener(Consumer<Notice> l) { listeners.remove(l); }

    private void fire(List<Notice> ns) {
        for (Notice n : ns) for (Consumer<Notice> l : listeners) {
            try { l.accept(n); } catch (Throwable t) { Guard.get().warn("econ", "notice listener failed: " + t, t); }
        }
    }

    // ------------------------------------------------------------------ writes

    /** Applies a full GET /econ/state object (also init.econ and reset.state). Null/non-ok is ignored. */
    public void applySnapshot(JsonObject s) {
        if (s == null || !J.bool(s, "ok", true)) return;
        synchronized (lock) {
            String w = J.str(s, "world", world);
            boolean newWorld = !w.equals(world);
            world = w;
            currency = J.str(s, "currency", "coins");
            rev = J.lng(s, "rev", 0);
            startBalance = J.lng(s, "startBalance", startBalance);
            JsonObject m = J.obj(s, "me");
            if (m != null) {
                me = J.str(m, "name", who());
                balance = J.lng(m, "balance", 0);
                held = J.lng(m, "held", 0);
            }
            JsonObject wa = J.obj(s, "wallets");
            if (wa != null) {
                walletMap.clear();
                for (var e : wa.entrySet()) {
                    try { walletMap.put(e.getKey(), e.getValue().getAsLong()); } catch (RuntimeException ignored) { /* skip bad */ }
                }
                if (m == null) {
                    Long b = findWallet(me);
                    if (b != null) balance = b;
                }
            }
            JsonArray sa = J.arr(s, "shop");
            if (sa != null) {
                List<ShopItem> l = new ArrayList<>();
                for (var e : sa) { JsonObject o = J.obj(e); if (o != null && J.str(o, "item") != null) l.add(ShopItem.parse(o)); }
                shop = Collections.unmodifiableList(l);
            }
            JsonArray sh = J.arr(s, "shops");
            if (sh != null) {
                shopMap.clear();
                for (var e : sh) { JsonObject o = J.obj(e); if (o != null) { Shop x = Shop.parse(o); shopMap.put(x.owner().toLowerCase(), x); } }
            }
            JsonArray la = J.arr(s, "listings");
            if (la != null) {
                listingMap.clear();
                for (var e : la) { JsonObject o = J.obj(e); if (o != null) { Listing x = Listing.parse(o); if (x.id() >= 0 && x.count() > 0) listingMap.put(x.id(), x); } }
            }
            JsonArray aa = J.arr(s, "auctions");
            if (aa != null) {
                auctionMap.clear();
                for (var e : aa) { JsonObject o = J.obj(e); if (o != null) { Auction x = Auction.parse(o, null); if (x.id() >= 0) auctionMap.put(x.id(), x); } }
            }
            JsonArray ta = J.arr(s, "tx");
            if (ta != null || newWorld) {
                txQ.clear();
                if (ta != null) for (var e : ta) {
                    JsonObject o = J.obj(e);
                    if (o == null) continue;
                    Tx t = Tx.parse(o);
                    if (t.involves(me) || t.involves(who())) txQ.addLast(t);
                }
                trimTx();
            }
            JsonArray da = J.arr(s, "deliveries");
            List<Delivery> dl = new ArrayList<>();
            if (da != null) for (var e : da) { JsonObject o = J.obj(e); if (o != null) dl.add(Delivery.parse(o)); }
            deliveries = Collections.unmodifiableList(dl);
            if (newWorld) sales = List.of();
            earn.applySnapshot(s, me, newWorld, System.currentTimeMillis());
            publishAll();
            disabled = null;
            loaded = true;
            resync = false;
        }
    }

    /** Applies one {@code {t:"econ"}} message at local time {@code now}. */
    public void apply(JsonObject m, long now) {
        if (m == null) return;
        String kind = J.str(m, "kind", "");
        List<Notice> notices = new ArrayList<>();
        synchronized (lock) {
            long r = J.lng(m, "rev", -1);
            if ("reset".equals(kind)) {
                world = "";
                txQ.clear();
                JsonObject st = J.obj(m, "state");
                if (st == null) { st = new JsonObject(); }
                if (!st.has("world") && J.str(m, "world") != null) st.addProperty("world", J.str(m, "world"));
                if (!st.has("rev")) st.addProperty("rev", Math.max(0, r));
                walletMap.clear(); listingMap.clear(); auctionMap.clear(); shopMap.clear();
                earn.clear();
                balance = startBalance;
                held = 0;
                applySnapshot(st);
                if (!st.has("me")) { Long b = findWallet(me); balance = b != null ? b : startBalance; held = 0; }
                resync = true; // reset.state has no "me": fetch our own view
                notices.add(new Notice(Notice.Kind.RESET, "New world: the economy starts fresh", null, 0, null, now));
            } else {
                if (r >= 0 && loaded && rev >= 0 && !"resync".equals(kind)) {
                    if (r <= rev) return; // already have it (snapshot raced the delta)
                    if (r > rev + 1) resync = true;
                }
                if (r >= 0) rev = r;
                switch (kind) {
                    case "wallet" -> {
                        String who = J.str(m, "who");
                        if (who != null) {
                            walletMap.put(who, J.lng(m, "balance", 0));
                            if (isMe(who)) { balance = J.lng(m, "balance", balance); held = J.lng(m, "held", held); }
                            publishWallets();
                        }
                    }
                    case "tx" -> {
                        JsonObject o = J.obj(m, "tx");
                        if (o != null) {
                            Tx t = Tx.parse(o);
                            if ((t.involves(me) || t.involves(who())) && !hasTx(t.id())) {
                                txQ.addFirst(t);
                                trimTx();
                                tx = List.copyOf(txQ);
                                Notice n = EconText.noticeFor(t, me, now);
                                if (n != null) notices.add(n);
                            }
                        }
                    }
                    case "listing" -> {
                        JsonObject o = J.obj(m, "listing");
                        if (o != null) {
                            Listing l = Listing.parse(o);
                            if (l.id() >= 0) {
                                if (l.count() > 0) listingMap.put(l.id(), l); else listingMap.remove(l.id());
                                publishListings();
                            }
                        }
                    }
                    case "listing_removed" -> {
                        if (listingMap.remove(J.integer(m, "id", -1)) != null) publishListings();
                    }
                    case "auction", "auction_ended" -> {
                        JsonObject o = J.obj(m, "auction");
                        if (o != null) {
                            int id = J.integer(o, "id", -1);
                            Auction prev = auctionMap.get(id);
                            Auction a = Auction.parse(o, prev);
                            if (a.id() >= 0) {
                                if ("auction_ended".equals(kind) && !a.ended())
                                    a = new Auction(a.id(), a.seller(), a.item(), a.count(), a.start(), a.bid(), a.bidder(), a.bids(), a.minNext(),
                                            a.created(), a.endsAt(), "open".equals(a.status()) ? "sold" : a.status(), true, a.winner());
                                auctionMap.put(a.id(), a);
                                publishAuctions();
                                notices.addAll(EconText.auctionNotices(prev, a, me, "auction_ended".equals(kind), now));
                            }
                        }
                    }
                    case "shop" -> {
                        JsonObject o = J.obj(m, "shop");
                        if (o != null) { Shop s = Shop.parse(o); shopMap.put(s.owner().toLowerCase(), s); publishShops(); }
                    }
                    case "sale" -> {
                        String text = J.str(m, "text");
                        if (text != null && !text.isBlank()) {
                            List<String> l = new ArrayList<>(sales);
                            l.add(0, text);
                            while (l.size() > 30) l.remove(l.size() - 1);
                            sales = Collections.unmodifiableList(l);
                        }
                    }
                    case "catalog" -> {
                        JsonArray sa = J.arr(m, "shop");
                        if (sa == null) sa = J.arr(m, "items");
                        if (sa != null) {
                            List<ShopItem> l = new ArrayList<>();
                            for (var e : sa) { JsonObject o = J.obj(e); if (o != null && J.str(o, "item") != null) l.add(ShopItem.parse(o)); }
                            shop = Collections.unmodifiableList(l);
                        }
                    }
                    case "earn" -> {
                        EarnState.Earned e = earn.apply(kind, m, me, now);
                        String who = J.str(m, "who");
                        if (who != null && m.has("balance")) {
                            walletMap.put(who, J.lng(m, "balance", 0));
                            if (isMe(who)) balance = J.lng(m, "balance", balance);
                            publishWallets();
                        }
                        if (e != null) {
                            String icon = EarnText.icon(e.source(), e.text(), e.id());
                            EarnState.Job job = "job".equals(e.source()) && m.has("job") ? earn.job(J.integer(m, "job", -1)) : null;
                            if (job != null && !job.item().isEmpty()) icon = job.item();
                            notices.add(new Notice(Notice.Kind.EARNED, EarnText.line(e), icon,
                                    e.amount(), e.source(), now));
                        } else if ("milestone".equals(J.str(m, "source")) && J.bool(m, "worldFirst", false) && who != null && !isMe(who)) {
                            EarnState.Earned o = earn.lastWorldFirst();
                            if (o != null) notices.add(new Notice(Notice.Kind.WORLD_FIRST, EarnText.worldFirstLine(o),
                                    EarnText.icon("milestone", o.text(), o.id()), 0, "milestone", now));
                        }
                    }
                    case "jobs", "job", "bounty" -> earn.apply(kind, m, me, now);
                    case "resync", "delivery", "deliveries" -> resync = true;
                    default -> { /* forward compatible */ }
                }
            }
            revision++;
            updatedAt = now;
        }
        fire(notices);
    }

    /** Applies a GET /econ/earnings answer (jobs view refresh). */
    public void applyEarnings(JsonObject ea) {
        if (ea == null || !J.bool(ea, "ok", true)) return;
        synchronized (lock) {
            earn.applyEarnings(ea, System.currentTimeMillis());
            revision++;
        }
    }

    /** Optimistic update after one of our own calls answered with {@code job} / {@code bounty} (the ws repeats it). */
    public void applyEarnAnswer(JsonObject body) {
        if (body == null) return;
        synchronized (lock) {
            JsonObject j = J.obj(body, "job");
            if (j != null) { JsonObject m = new JsonObject(); m.add("job", j); earn.apply("job", m, me, System.currentTimeMillis()); }
            JsonObject b = J.obj(body, "bounty");
            if (b != null) { JsonObject m = new JsonObject(); m.add("bounty", b); earn.apply("bounty", m, me, System.currentTimeMillis()); }
            revision++;
        }
    }

    /** Optimistic update after one of our own calls answered with {@code balance}. */
    public void setMyBalance(long b, Long heldOrNull) {
        synchronized (lock) {
            balance = b;
            if (heldOrNull != null) held = heldOrNull;
            walletMap.put(me, b);
            publishWallets();
            revision++;
        }
    }

    public void clear() {
        synchronized (lock) {
            walletMap.clear(); listingMap.clear(); auctionMap.clear(); shopMap.clear(); txQ.clear();
            loaded = false; world = ""; rev = -1; balance = 0; held = 0; me = who();
            shop = List.of(); deliveries = List.of(); sales = List.of();
            earn.clear();
            disabled = null;
            publishAll();
            revision++;
        }
    }

    // ------------------------------------------------------------------ internals (hold lock)

    private Long findWallet(String name) {
        for (var e : walletMap.entrySet()) if (EconText.same(e.getKey(), name)) return e.getValue();
        return null;
    }

    private boolean hasTx(long id) {
        if (id < 0) return false;
        for (Tx t : txQ) if (t.id() == id) return true;
        return false;
    }

    private void trimTx() { while (txQ.size() > MAX_TX) txQ.pollLast(); }

    private void publishAll() {
        publishWallets(); publishListings(); publishAuctions(); publishShops();
        tx = List.copyOf(txQ);
        revision++;
    }

    private void publishWallets() {
        List<Map.Entry<String, Long>> l = new ArrayList<>(walletMap.entrySet());
        l.sort(Map.Entry.<String, Long>comparingByValue().reversed().thenComparing(Map.Entry.comparingByKey(String.CASE_INSENSITIVE_ORDER)));
        Map<String, Long> out = new LinkedHashMap<>();
        for (var e : l) out.put(e.getKey(), e.getValue());
        wallets = Collections.unmodifiableMap(out);
    }

    private void publishListings() {
        List<Listing> l = new ArrayList<>(listingMap.values());
        l.sort(Comparator.comparingInt(Listing::price).thenComparingInt(Listing::id));
        listings = Collections.unmodifiableList(l);
    }

    private void publishAuctions() {
        List<Auction> l = new ArrayList<>(auctionMap.values());
        l.sort(Comparator.comparing((Auction a) -> !a.open())
                .thenComparingLong(a -> a.open() ? a.endsAt() : -a.endsAt())
                .thenComparingInt(Auction::id));
        auctions = Collections.unmodifiableList(l);
    }

    private void publishShops() {
        List<Shop> l = new ArrayList<>(shopMap.values());
        l.sort(Comparator.comparing(Shop::owner, String.CASE_INSENSITIVE_ORDER));
        shops = Collections.unmodifiableList(l);
    }

    private static Integer intOrNull(JsonObject o, String k) {
        Double d = J.numOrNull(o, k);
        return d == null ? null : (int) Math.round(d);
    }
}
