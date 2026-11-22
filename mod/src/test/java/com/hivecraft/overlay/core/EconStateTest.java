package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Economy parsing, delta merge, notices and formatting (MOD_PROTOCOL.md §5). */
class EconStateTest {
    /** The local player in these tests is Robin (the mod's who() for /econ requests and "me" before a snapshot). */
    @BeforeEach
    void localPlayer() { EconState.setBridgeName(null); EconState.setLocalName("Robin"); }


    static JsonObject js(String s) { return JsonParser.parseString(s).getAsJsonObject(); }

    static final String SNAP = """
            {"ok":true,"world":"world-20261121-184302","currency":"coins","rev":42,"startBalance":100,
             "me":{"name":"Robin","balance":136,"held":55},
             "wallets":{"Robin":136,"Ash":88,"Flint":100},
             "shop":[{"item":"bread","buy":6,"sell":2,"cat":"food"},{"item":"minecraft:rotten_flesh","buy":null,"sell":1,"cat":"mob drops"}],
             "shops":[{"owner":"Ash","name":"Ash's Lumber","description":"logs and planks","created":1763700000000,"listings":2}],
             "listings":[{"id":7,"seller":"Ash","shop":"Ash's Lumber","item":"oak_log","count":32,"price":2,"ts":1763700000000},
                         {"id":8,"seller":"Flint","shop":"","item":"cobblestone","count":64,"price":1,"ts":1763700000000}],
             "auctions":[{"id":3,"seller":"Flint","item":"diamond","count":3,"start":50,"bid":55,"bidder":"Robin","bids":2,
               "minNext":58,"created":1763700000000,"endsAt":1763700600000,"status":"open","ended":false,"winner":null}],
             "tx":[{"id":91,"ts":1763700000000,"kind":"market_buy","from":"Robin","to":"Ash","amount":20,"item":"oak_log","count":10,"note":"listing #7"},
                   {"id":90,"ts":1763690000000,"kind":"pay","from":"Ash","to":"Flint","amount":5}],
             "deliveries":[{"id":4,"to":"Robin","item":"oak_log","count":10,"reason":"listing #7","ts":1763700000000}]}""";

    static EconState loaded(List<EconState.Notice> sink) {
        EconState s = new EconState();
        if (sink != null) s.addListener(sink::add);
        s.applySnapshot(js(SNAP));
        return s;
    }

    @Test
    void snapshotParsesEverything() {
        EconState s = loaded(null);
        assertTrue(s.loaded());
        assertEquals("world-20261121-184302", s.world());
        assertEquals(42, s.rev());
        assertEquals(136, s.balance());
        assertEquals(55, s.held());
        assertEquals(List.of("Robin", "Flint", "Ash"), new ArrayList<>(s.wallets().keySet()), "richest first");
        assertEquals(2, s.shop().size());
        EconState.ShopItem flesh = s.shopItem("Rotten Flesh");
        assertNotNull(flesh, "minecraft: prefix and spaces normalised");
        assertNull(flesh.buy());
        assertEquals(1, flesh.sell());
        assertEquals(6, s.shopItem("bread").buy());
        assertEquals("Ash's Lumber", s.shopOf("ash").name());
        assertEquals(List.of(8, 7), s.listings().stream().map(EconState.Listing::id).toList(), "cheapest first");
        assertEquals(64, s.listing(7).total());
        EconState.Auction a = s.auction(3);
        assertTrue(a.open());
        assertEquals(55, a.price());
        assertEquals(58, a.minNext());
        assertEquals(1, s.tx().size(), "only transactions involving Robin are kept");
        assertEquals(-20, s.tx().get(0).delta("Robin"));
        assertEquals(1, s.deliveries().size());
    }

    @Test
    void walletDeltaForMeAndOthers() {
        EconState s = loaded(null);
        s.apply(js("{\"t\":\"econ\",\"kind\":\"wallet\",\"rev\":43,\"who\":\"Ash\",\"balance\":108,\"held\":0}"), 1);
        assertEquals(108L, s.wallets().get("Ash"));
        assertEquals(List.of("Robin", "Ash", "Flint"), new ArrayList<>(s.wallets().keySet()));
        s.apply(js("{\"t\":\"econ\",\"kind\":\"wallet\",\"rev\":44,\"who\":\"robin\",\"balance\":90,\"held\":0}"), 2);
        assertEquals(90, s.balance());
        assertEquals(0, s.held());
        assertFalse(s.takeResync());
    }

    @Test
    void revGapAsksForResyncAndOldRevsAreIgnored() {
        EconState s = loaded(null);
        s.apply(js("{\"t\":\"econ\",\"kind\":\"wallet\",\"rev\":42,\"who\":\"Ash\",\"balance\":1}"), 1);
        assertEquals(88L, s.wallets().get("Ash"), "rev 42 is already in the snapshot");
        s.apply(js("{\"t\":\"econ\",\"kind\":\"wallet\",\"rev\":45,\"who\":\"Ash\",\"balance\":7}"), 2);
        assertEquals(7L, s.wallets().get("Ash"));
        assertTrue(s.takeResync(), "43-44 were missed");
        assertFalse(s.takeResync(), "one-shot");
        s.apply(js("{\"t\":\"econ\",\"kind\":\"resync\",\"rev\":45}"), 3);
        assertTrue(s.takeResync(), "explicit resync");
    }

    @Test
    void txDeltasBecomeNotices() {
        List<EconState.Notice> n = new ArrayList<>();
        EconState s = loaded(n);
        s.apply(js("{\"t\":\"econ\",\"kind\":\"tx\",\"rev\":43,\"tx\":{\"id\":92,\"ts\":5,\"kind\":\"market_buy\",\"from\":\"Ash\",\"to\":\"Robin\",\"amount\":30,\"item\":\"wheat\",\"count\":15}}"), 10);
        s.apply(js("{\"t\":\"econ\",\"kind\":\"tx\",\"rev\":44,\"tx\":{\"id\":93,\"ts\":6,\"kind\":\"shop_buy\",\"from\":\"Robin\",\"to\":\"Server\",\"amount\":12,\"item\":\"bread\",\"count\":2}}"), 11);
        s.apply(js("{\"t\":\"econ\",\"kind\":\"tx\",\"rev\":45,\"tx\":{\"id\":94,\"ts\":7,\"kind\":\"pay\",\"from\":\"Ash\",\"to\":\"Flint\",\"amount\":3}}"), 12);
        s.apply(js("{\"t\":\"econ\",\"kind\":\"tx\",\"rev\":46,\"tx\":{\"id\":93,\"ts\":6,\"kind\":\"shop_buy\",\"from\":\"Robin\",\"to\":\"Server\",\"amount\":12,\"item\":\"bread\",\"count\":2}}"), 13);
        assertEquals(2, n.size(), "other people's tx and duplicates are not announced");
        assertEquals(EconState.Notice.Kind.SOLD, n.get(0).kind());
        assertEquals("Ash bought 15 Wheat", n.get(0).text());
        assertEquals(30, n.get(0).coins());
        assertEquals("wheat", n.get(0).item());
        assertEquals(EconState.Notice.Kind.BOUGHT, n.get(1).kind());
        assertEquals(-12, n.get(1).coins());
        assertEquals(3, s.tx().size());
        assertEquals(93, s.tx().get(0).id(), "newest first");
    }

    @Test
    void listingsUpsertAndRemove() {
        EconState s = loaded(null);
        s.apply(js("{\"t\":\"econ\",\"kind\":\"listing\",\"rev\":43,\"listing\":{\"id\":7,\"seller\":\"Ash\",\"shop\":\"Ash's Lumber\",\"item\":\"oak_log\",\"count\":22,\"price\":2,\"ts\":1}}"), 1);
        assertEquals(22, s.listing(7).count());
        s.apply(js("{\"t\":\"econ\",\"kind\":\"listing\",\"rev\":44,\"listing\":{\"id\":9,\"seller\":\"Robin\",\"item\":\"torch\",\"count\":16,\"price\":1,\"ts\":2}}"), 2);
        assertEquals(3, s.listings().size());
        s.apply(js("{\"t\":\"econ\",\"kind\":\"listing_removed\",\"rev\":45,\"id\":7,\"reason\":\"sold\"}"), 3);
        assertNull(s.listing(7));
        s.apply(js("{\"t\":\"econ\",\"kind\":\"listing\",\"rev\":46,\"listing\":{\"id\":9,\"seller\":\"Robin\",\"item\":\"torch\",\"count\":0,\"price\":1}}"), 4);
        assertNull(s.listing(9), "count 0 = gone");
        assertEquals(1, s.listings().size());
    }

    @Test
    void outbidWonAndUnsoldNotices() {
        List<EconState.Notice> n = new ArrayList<>();
        EconState s = loaded(n);
        // Ash outbids Robin on #3
        s.apply(js("""
                {"t":"econ","kind":"auction","rev":43,"auction":{"id":3,"seller":"Flint","item":"diamond","count":3,"start":50,"bid":58,"bidder":"Ash","bids":3,
                 "minNext":61,"created":1,"endsAt":1763700600000,"status":"open","ended":false,"winner":null}}"""), 5);
        assertEquals(1, n.size());
        assertEquals(EconState.Notice.Kind.OUTBID, n.get(0).kind());
        assertTrue(n.get(0).text().contains("Ash"), n.get(0).text());
        assertEquals(61, s.auction(3).minNext());
        // Robin bids again and wins
        s.apply(js("{\"t\":\"econ\",\"kind\":\"auction\",\"rev\":44,\"auction\":{\"id\":3,\"bid\":70,\"bidder\":\"Robin\",\"bids\":4,\"minNext\":74}}"), 6);
        assertEquals(1, n.size(), "leading again is not a notice");
        assertEquals("diamond", s.auction(3).item(), "partial objects merge with the previous one");
        s.apply(js("{\"t\":\"econ\",\"kind\":\"auction_ended\",\"rev\":45,\"auction\":{\"id\":3,\"status\":\"sold\",\"winner\":\"Robin\",\"ended\":true}}"), 7);
        assertEquals(2, n.size());
        assertEquals(EconState.Notice.Kind.WON, n.get(1).kind());
        assertEquals(-70, n.get(1).coins());
        assertFalse(s.auction(3).open());
        assertEquals(3, s.auction(3).count());
        // Robin's own auction ends without bids
        s.apply(js("{\"t\":\"econ\",\"kind\":\"auction\",\"rev\":46,\"auction\":{\"id\":5,\"seller\":\"Robin\",\"item\":\"iron_ingot\",\"count\":8,\"start\":40,\"bid\":null,\"bidder\":null,\"bids\":0,\"minNext\":40,\"endsAt\":9,\"status\":\"open\",\"ended\":false}}"), 8);
        s.apply(js("{\"t\":\"econ\",\"kind\":\"auction_ended\",\"rev\":47,\"auction\":{\"id\":5,\"status\":\"unsold\",\"ended\":true}}"), 9);
        assertEquals(EconState.Notice.Kind.AUCTION_UNSOLD, n.get(n.size() - 1).kind());
        // open auctions sort before ended ones
        assertTrue(s.auctions().get(0).open() || s.auctions().stream().noneMatch(EconState.Auction::open));
    }

    @Test
    void resetStartsFresh() {
        List<EconState.Notice> n = new ArrayList<>();
        EconState s = loaded(n);
        s.apply(js("{\"t\":\"econ\",\"kind\":\"reset\",\"rev\":0,\"world\":\"world-20261122-090000\",\"state\":{\"ok\":true,\"world\":\"world-20261122-090000\",\"startBalance\":100,\"wallets\":{\"Robin\":100}}}"), 1);
        assertEquals("world-20261122-090000", s.world());
        assertEquals(100, s.balance());
        assertEquals(0, s.held());
        assertTrue(s.listings().isEmpty());
        assertTrue(s.auctions().isEmpty());
        assertTrue(s.tx().isEmpty());
        assertEquals(0, s.rev());
        assertEquals(EconState.Notice.Kind.RESET, n.get(n.size() - 1).kind());
        assertTrue(s.takeResync(), "fetch our own view (me/held) after a reset");
        // next delta in the new world applies
        s.apply(js("{\"t\":\"econ\",\"kind\":\"wallet\",\"rev\":1,\"who\":\"Robin\",\"balance\":94}"), 2);
        assertEquals(94, s.balance());
        assertFalse(s.takeResync());
    }

    @Test
    void hiveStateRoutesEconMessages() {
        HiveState hs = new HiveState(() -> 1000L);
        JsonObject init = js("{\"t\":\"init\",\"protocol\":1,\"bots\":[],\"econ\":" + SNAP + "}");
        hs.apply(init);
        assertTrue(hs.econ().loaded());
        assertEquals(136, hs.econ().balance());
        hs.apply(js("{\"t\":\"econ\",\"kind\":\"wallet\",\"rev\":43,\"who\":\"Robin\",\"balance\":140}"));
        assertEquals(140, hs.econ().balance());
        hs.clear();
        assertFalse(hs.econ().loaded());
    }

    @Test
    void optimisticBalanceAndBadInput() {
        EconState s = loaded(null);
        s.setMyBalance(10, 3L);
        assertEquals(10, s.balance());
        assertEquals(3, s.held());
        s.applySnapshot(js("{\"ok\":false,\"error\":\"nope\"}"));
        assertEquals(10, s.balance(), "failed snapshot ignored");
        s.apply(js("{\"t\":\"econ\",\"kind\":\"listing\",\"rev\":43}"), 1); // no listing object
        s.apply(js("{\"t\":\"econ\",\"kind\":\"mystery\",\"rev\":44}"), 1);  // unknown kind
        assertEquals(44, s.rev());
    }

    // ------------------------------------------------------------------ formatting / parsing

    @Test
    void formatting() {
        assertEquals("1,234,567", EconText.coins(1234567));
        assertEquals("999", EconText.coinsShort(999));
        assertEquals("9,999", EconText.coinsShort(9999));
        assertEquals("12.3k", EconText.coinsShort(12345));
        assertEquals("250k", EconText.coinsShort(250_400));
        assertEquals("1.5M", EconText.coinsShort(1_500_000));
        assertEquals("+20", EconText.signed(20));
        assertEquals("-1,000", EconText.signed(-1000));
        assertEquals("ended", EconText.countdown(0));
        assertEquals("0:01", EconText.countdown(1));
        assertEquals("4:59", EconText.countdown(299_000));
        assertEquals("1:02:03", EconText.countdown(3_723_000));
        assertEquals("Oak Log", EconText.pretty("minecraft:oak_log"));
        assertEquals("oak_log", EconText.normItem(" Minecraft:Oak Log "));
        assertEquals("10 Oak Log", EconText.countItem(10, "oak_log"));
        assertEquals("Diamond", EconText.countItem(1, "diamond"));
    }

    @Test
    void minNextBidMatchesBridgeRule() {
        assertEquals(50, EconText.minNextBid(null, 50));
        assertEquals(58, EconText.minNextBid(55, 50));   // 55 + ceil(2.75)
        assertEquals(11, EconText.minNextBid(10, 5));    // 10 + max(1, ceil(0.5))
        assertEquals(2, EconText.minNextBid(1, 1));
        assertEquals(105, EconText.minNextBid(100, 1));
    }

    @Test
    void parseAmount() {
        assertEquals(64L, EconText.parseAmount("64"));
        assertEquals(1000L, EconText.parseAmount(" 1,000 "));
        assertEquals(2000L, EconText.parseAmount("2k"));
        assertEquals(1500L, EconText.parseAmount("1.5k"));
        assertEquals(3_000_000L, EconText.parseAmount("3M"));
        assertNull(EconText.parseAmount(""));
        assertNull(EconText.parseAmount("0"));
        assertNull(EconText.parseAmount("-5"));
        assertNull(EconText.parseAmount("1.5"));
        assertNull(EconText.parseAmount("abc"));
        assertNull(EconText.parseAmount("99999999999"));
        assertNull(EconText.parseAmount(null));
    }

    @Test
    void describeTransactions() {
        EconState.Tx buy = new EconState.Tx(1, 0, "market_buy", "Robin", "Ash", 20, "oak_log", 10, null);
        assertEquals("Bought 10 Oak Log from Ash", EconText.describe(buy, "Robin"));
        EconState.Tx sold = new EconState.Tx(2, 0, "market_buy", "Ash", "Robin", 20, "oak_log", 10, null);
        assertEquals("Ash bought 10 Oak Log", EconText.describe(sold, "Robin"));
        EconState.Tx pay = new EconState.Tx(3, 0, "pay", "Flint", "Robin", 5, null, 0, "thanks");
        assertEquals("Flint paid you · thanks", EconText.describe(pay, "Robin"));
        assertEquals(5, pay.delta("robin"));
        EconState.Tx shop = new EconState.Tx(4, 0, "shop_sell", "Server", "Robin", 8, "rotten_flesh", 8, null);
        assertEquals("Sold 8 Rotten Flesh to the shop", EconText.describe(shop, "Robin"));
        EconState.Tx odd = new EconState.Tx(5, 0, "brand_new_kind", "Robin", "Server", 1, null, 0, null);
        assertEquals("Brand New Kind", EconText.describe(odd, "Robin"));
    }

    @Test
    void actionResults() {
        Econ.Result ok = Econ.parseResult(js("{\"ok\":true,\"item\":\"oak_log\",\"count\":3,\"earned\":6,\"balance\":142,\"warning\":\"you only had 3 oak_log\"}"));
        assertTrue(ok.ok());
        assertEquals("you only had 3 oak_log", ok.note());
        Econ.Result bad = Econ.parseResult(js("{\"ok\":false,\"error\":\"not enough coins: have 40, need 64\"}"));
        assertFalse(bad.ok());
        assertEquals("not enough coins: have 40, need 64", bad.error());
        assertFalse(Econ.parseResult(js("{}")).ok(), "no ok flag = failure");
        assertEquals("request refused", Econ.parseResult(js("{\"ok\":false}")).error());
        assertFalse(Econ.parseResult(null).ok());
        assertNull(Econ.parseResult(js("{\"ok\":true}")).note());
    }
}
