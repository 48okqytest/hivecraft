package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Earning coins: jobs, bounties, mob rates, milestones, wage, earn events (MOD_PROTOCOL.md §5 "Earning coins"). */
class EarnStateTest {
    /** The local player in these tests is Robin (the mod's who() for /econ requests and "me" before a snapshot). */
    @BeforeEach
    void localPlayer() { EconState.setBridgeName(null); EconState.setLocalName("Robin"); }


    static JsonObject js(String s) { return JsonParser.parseString(s).getAsJsonObject(); }

    static final long NOW = 1763700000000L;

    static final String SNAP = """
            {"ok":true,"world":"w1","currency":"coins","rev":10,"startBalance":100,
             "me":{"name":"Robin","balance":136,"held":0},
             "wallets":{"Robin":136,"Ash":88},
             "jobs":[{"id":4,"item":"cobblestone","count":32,"left":12,"pay":2,"shopSell":1,"delivered":{"Ash":20},"created":1763700000000,"expiresAt":1763701200000,"status":"open"},
                     {"id":5,"item":"minecraft:oak_log","count":16,"left":0,"pay":3,"shopSell":2,"delivered":{"Robin":16},"status":"filled"},
                     {"id":6,"item":"iron_ingot","count":10,"left":10,"pay":9,"shopSell":6,"status":"open"}],
             "nextRotation":1763701200000,
             "bounties":[{"task":12,"title":"Mine 24 iron","total":30,"funders":{"Robin":20,"Ash":10},"status":"open","owner":null,"paidTo":null,"created":1763700000000},
                         {"task":14,"title":"Build a bridge","total":50,"funders":{"Ash":50},"status":"open","owner":"Flint","created":1763700000000}],
             "earnings":{"ok":true,"rates":{"mobs":{"zombie":3,"skeleton":3,"creeper":4,"witch":8},"mobCapPerMinute":60,
                 "milestones":[{"id":"diamond","label":"First diamond","reward":25,"first":12},{"id":"nether","label":"Enter the Nether","reward":40,"first":20}],
                 "wage":10,"jobPremiumPct":50},
               "who":"Robin","totals":{"mob":12,"job":48,"bounty":0,"milestone":25,"wage":10,"today":30},
               "nextSunrise":1763700600000,
               "milestones":[{"id":"diamond","label":"First diamond","reward":25,"first":12,"done":true,"ts":1763690000000,"worldFirst":true,"firstBy":"Robin"},
                             {"id":"nether","label":"Enter the Nether","reward":40,"first":20,"done":false,"firstBy":"Ash"}],
               "recent":[{"id":80,"ts":1763690000000,"kind":"milestone","from":"Bank","to":"Robin","amount":25,"note":"first diamond"},
                         {"id":81,"ts":1763695000000,"kind":"mob_bounty","from":"Bank","to":"Robin","amount":6,"note":"2 zombie"},
                         {"id":82,"ts":1763695000000,"kind":"pay","from":"Ash","to":"Robin","amount":5}]}}""";

    static EconState loaded(List<EconState.Notice> sink) {
        EconState s = new EconState();
        if (sink != null) s.addListener(sink::add);
        s.applySnapshot(js(SNAP));
        return s;
    }

    @Test
    void snapshotParsesJobsBountiesAndEarnings() {
        EconState s = loaded(null);
        EarnState e = s.earn();
        assertTrue(e.available());
        // open jobs first (most coins left first), filled last
        assertEquals(List.of(6, 4, 5), e.jobs().stream().map(EarnState.Job::id).toList());
        EarnState.Job j = e.job(4);
        assertEquals("cobblestone", j.item());
        assertEquals(20, j.done());
        assertEquals(20, j.deliveredBy("ash"));
        assertEquals(100, j.premiumPct());
        assertEquals(24, j.payFor(99)); // capped at the 12 left
        assertTrue(j.open());
        assertEquals("oak_log", e.job(5).item());
        assertFalse(e.job(5).open());
        assertEquals(1763701200000L, e.nextRotation());

        assertEquals(List.of(14, 12), e.bounties().stream().map(EarnState.Bounty::task).toList()); // biggest first
        assertEquals(20, e.bounty(12).share("Robin"));

        EarnState.Rates r = e.rates();
        assertEquals(List.of("witch", "creeper", "skeleton", "zombie"), new ArrayList<>(r.mobs().keySet()));
        assertEquals(60, r.mobCapPerMinute());
        assertEquals(10, r.wage());
        assertEquals(50, r.jobPremiumPct());

        assertEquals(2, e.milestones().size());
        assertTrue(e.milestone("diamond").done());
        assertTrue(e.milestone("diamond").worldFirst());
        assertFalse(e.milestone("nether").done());
        assertEquals("Ash", e.milestone("nether").firstBy());
        assertEquals(20, e.milestone("nether").first());

        assertEquals(48, e.totals().get("job"));
        assertEquals(95, e.total());
        assertFalse(e.totals().containsKey("today"));
        assertEquals(30, e.today(NOW));
        assertEquals(1763700600000L, e.nextSunrise(NOW));
        // recent: only earnings, newest first
        assertEquals(List.of("mob", "milestone"), e.recent().stream().map(EarnState.Earned::source).toList());
    }

    @Test
    void earnEventForRobinNotifiesAndCounts() {
        List<EconState.Notice> n = new ArrayList<>();
        EconState s = loaded(n);
        s.apply(js("""
                {"t":"econ","kind":"earn","rev":11,"source":"job","who":"Robin","amount":24,"balance":160,"text":"12 cobblestone for job #4"}"""), NOW);
        assertEquals(1, n.size());
        EconState.Notice x = n.get(0);
        assertEquals(EconState.Notice.Kind.EARNED, x.kind());
        assertEquals("job", x.other());
        assertEquals(24, x.coins());
        assertEquals("cobblestone", x.item());
        assertEquals("Server job · 12 cobblestone for job #4", x.text());
        assertEquals(160, s.balance());
        assertEquals(72, s.earn().totals().get("job"));
        assertEquals(54, s.earn().today(NOW));
        assertEquals("job", s.earn().recent().get(0).source());
    }

    @Test
    void earnEventForSomeoneElseOnlyUpdatesTheirWallet() {
        List<EconState.Notice> n = new ArrayList<>();
        EconState s = loaded(n);
        s.apply(js("""
                {"t":"econ","kind":"earn","rev":11,"source":"mob","who":"Ash","amount":6,"balance":94,"text":"2 zombie"}"""), NOW);
        assertTrue(n.isEmpty());
        assertEquals(94L, s.wallets().get("Ash"));
        assertEquals(136, s.balance());
        assertEquals(12, s.earn().totals().get("mob"));
        assertEquals(30, s.earn().today(NOW));
    }

    @Test
    void worldFirstByOtherIsAnnouncedAndRecorded() {
        List<EconState.Notice> n = new ArrayList<>();
        EconState s = loaded(n);
        // a fresh milestone row with no world first yet
        s.applyEarnings(js("""
                {"ok":true,"milestones":[{"id":"emerald","label":"First emerald","reward":20,"first":10,"done":false}]}"""));
        s.apply(js("""
                {"t":"econ","kind":"earn","rev":11,"source":"milestone","who":"Ash","amount":30,"balance":118,"text":"first emerald","id":"emerald","worldFirst":true}"""), NOW);
        assertEquals(1, n.size());
        assertEquals(EconState.Notice.Kind.WORLD_FIRST, n.get(0).kind());
        assertEquals("Ash got the world first: first emerald", n.get(0).text());
        assertEquals("emerald", n.get(0).item());
        assertEquals("Ash", s.earn().milestone("emerald").firstBy());
        assertFalse(s.earn().milestone("emerald").done());
    }

    @Test
    void milestoneEarnMarksItDone() {
        List<EconState.Notice> n = new ArrayList<>();
        EconState s = loaded(n);
        s.apply(js("""
                {"t":"econ","kind":"earn","rev":11,"source":"milestone","who":"Robin","amount":40,"balance":176,"text":"entered the Nether","id":"nether"}"""), NOW);
        assertTrue(s.earn().milestone("nether").done());
        assertEquals(NOW, s.earn().milestone("nether").ts());
        assertEquals("netherrack", n.get(0).item());
        assertEquals(65, s.earn().totals().get("milestone"));
    }

    @Test
    void todayRestartsAfterSunrise() {
        EconState s = loaded(null);
        long after = 1763700600000L + 5000;
        assertEquals(0, s.earn().today(after)); // the day rolled over since the snapshot
        assertEquals(1763700600000L + EarnState.MC_DAY_MS, s.earn().nextSunrise(after));
        s.apply(js("""
                {"t":"econ","kind":"earn","rev":11,"source":"wage","who":"Robin","amount":10,"balance":146,"text":"day 5"}"""), after);
        assertEquals(10, s.earn().today(after));
        assertEquals(20, s.earn().totals().get("wage"));
    }

    @Test
    void jobsDeltaReplacesTheListAndKeepsMissingFields() {
        EconState s = loaded(null);
        s.apply(js("""
                {"t":"econ","kind":"jobs","rev":11,"jobs":[{"id":4,"item":"cobblestone","count":32,"left":0,"pay":2,"status":"filled"},
                  {"id":9,"item":"wheat","count":20,"left":20,"pay":2,"shopSell":1,"status":"open"}],"nextRotation":1763702400000}"""), NOW);
        EarnState e = s.earn();
        assertEquals(List.of(9, 4), e.jobs().stream().map(EarnState.Job::id).toList());
        assertNull(e.job(6));
        assertEquals(20, e.job(4).deliveredBy("Ash")); // not in the short object: kept
        assertEquals(1, e.job(4).shopSell());
        assertFalse(e.job(4).open());
        assertEquals(1763702400000L, e.nextRotation());
    }

    @Test
    void bountyDeltaMergesAndClosedOnesSortLast() {
        EconState s = loaded(null);
        s.apply(js("""
                {"t":"econ","kind":"bounty","rev":11,"bounty":{"task":14,"title":"Build a bridge","total":50,"status":"paid","paidTo":"Flint"}}"""), NOW);
        EarnState e = s.earn();
        assertEquals(List.of(12, 14), e.bounties().stream().map(EarnState.Bounty::task).toList());
        EarnState.Bounty b = e.bounty(14);
        assertEquals("paid", b.status());
        assertEquals("Flint", b.paidTo());
        assertEquals(50, b.share("Ash")); // funders kept from before
        assertEquals(NOW, b.ended());
        // a later snapshot (open ones only) keeps the recently paid one
        s.applySnapshot(js(SNAP.replace("\"rev\":10", "\"rev\":12").replace("{\"task\":14,\"title\":\"Build a bridge\",\"total\":50,\"funders\":{\"Ash\":50},\"status\":\"open\",\"owner\":\"Flint\",\"created\":1763700000000}", "{\"task\":15,\"title\":\"x\",\"total\":5,\"status\":\"open\"}")));
        assertEquals(List.of(12, 15, 14), s.earn().bounties().stream().map(EarnState.Bounty::task).toList());
    }

    @Test
    void ourOwnAnswerUpdatesJobAndBountyRightAway() {
        EconState s = loaded(null);
        s.applyEarnAnswer(js("""
                {"ok":true,"job":{"id":4,"left":2},"count":10,"earned":20,"balance":156,"bounty":{"task":12,"total":45,"funders":{"Robin":35,"Ash":10}}}"""));
        assertEquals(2, s.earn().job(4).left());
        assertEquals("cobblestone", s.earn().job(4).item());
        assertEquals(45, s.earn().bounty(12).total());
        assertEquals(35, s.earn().bounty(12).share("Robin"));
    }

    @Test
    void resetAndClearDropEarnings() {
        EconState s = loaded(null);
        s.apply(js("""
                {"t":"econ","kind":"reset","rev":0,"world":"w2","state":{"ok":true,"world":"w2","wallets":{}}}"""), NOW);
        assertTrue(s.earn().jobs().isEmpty());
        assertTrue(s.earn().bounties().isEmpty());
        assertEquals(0, s.earn().today(NOW));
        EconState t = loaded(null);
        t.clear();
        assertFalse(t.earn().available());
        assertTrue(t.earn().milestones().isEmpty());
    }

    @Test
    void olderBridgeHasNoEarnings() {
        EconState s = new EconState();
        s.applySnapshot(js("""
                {"ok":true,"world":"w1","rev":1,"me":{"name":"Robin","balance":100,"held":0}}"""));
        assertTrue(s.loaded());
        assertFalse(s.earn().available());
    }

    @Test
    void economyOffIsDetectedAndClearedBySnapshot() {
        assertTrue(EconState.isOffError("the economy is turned off for this game (Hivecraft.exe setting)"));
        assertFalse(EconState.isOffError("not enough coins: have 40, need 64"));
        assertFalse(EconState.isOffError(null));
        EconState s = new EconState();
        s.setDisabled("the economy is turned off for this game (Hivecraft.exe setting)");
        assertNotNull(s.disabled());
        s.applySnapshot(js(SNAP));
        assertNull(s.disabled());
    }

    @Test
    void taskInfoParsesReward() {
        TaskInfo t = TaskInfo.parse(js("""
                {"id":12,"title":"Mine 24 iron","status":"claimed","owner":"Flint","by":"Robin","reward":30,"rewardStatus":"open"}"""));
        assertTrue(t.hasReward());
        assertEquals(30, t.reward());
        assertEquals("open", t.rewardStatus());
        assertNull(t.rewardTo());
        TaskInfo plain = TaskInfo.parse(js("{\"id\":3,\"title\":\"scout\"}"));
        assertFalse(plain.hasReward());
        assertNull(plain.rewardStatus());
    }

    @Test
    void boardRowsMergeTasksAndBounties() {
        EconState s = loaded(null);
        List<TaskInfo> board = List.of(
                TaskInfo.parse(js("{\"id\":3,\"title\":\"scout\",\"status\":\"open\",\"by\":\"Ash\"}")),
                TaskInfo.parse(js("{\"id\":12,\"title\":\"Mine 24 iron\",\"status\":\"open\",\"by\":\"Robin\",\"reward\":30,\"rewardStatus\":\"open\"}")),
                TaskInfo.parse(js("{\"id\":14,\"title\":\"Build a bridge\",\"status\":\"claimed\",\"owner\":\"Flint\",\"by\":\"Ash\",\"reward\":50,\"rewardStatus\":\"open\"}")),
                TaskInfo.parse(js("{\"id\":2,\"title\":\"old\",\"status\":\"done\",\"owner\":\"Ash\",\"reward\":8,\"rewardStatus\":\"paid\",\"rewardTo\":\"Ash\"}")),
                TaskInfo.parse(js("{\"id\":1,\"title\":\"older\",\"status\":\"done\"}")));
        List<EarnText.Row> rows = EarnText.rows(board, s.earn().bounties(), "Robin");
        assertEquals(List.of(14, 12, 3, 2), rows.stream().map(EarnText.Row::task).toList());
        EarnText.Row r14 = rows.get(0), r12 = rows.get(1), r3 = rows.get(2), r2 = rows.get(3);
        assertEquals("claimed by Flint", r14.status());
        assertTrue(r14.rewardOpen());
        assertEquals(20, r12.myShare());
        assertEquals(2, r12.funders());
        assertTrue(EarnText.canWithdraw(r12, "Robin"));
        assertFalse(EarnText.canWithdraw(r14, "Robin")); // not his coins
        assertEquals(0, r3.reward());
        assertFalse(r3.rewardOpen());
        assertTrue(r3.open());
        assertEquals("paid to Ash", r2.status());
        assertFalse(r2.open());
    }

    @Test
    void textHelpers() {
        assertEquals("mob", EarnText.sourceOfTx("mob_bounty"));
        assertEquals("milestone", EarnText.sourceOfTx("world_first"));
        assertEquals("bounty", EarnText.sourceOfTx("bounty_paid"));
        assertNull(EarnText.sourceOfTx("bounty_refund"));
        assertNull(EarnText.sourceOfTx("shop_sell"));
        assertEquals("zombie", EarnText.firstMob("2 zombie, 1 skeleton"));
        assertEquals("cave_spider", EarnText.firstMob("1 cave spider"));
        assertEquals("witch", EarnText.firstMob("witch"));
        assertNull(EarnText.firstMob(""));
        assertEquals("zombie_spawn_egg", EarnText.icon("mob", "3 zombie", null));
        assertEquals("cobblestone", EarnText.jobItem("32 cobblestone for job #4"));
        assertNull(EarnText.jobItem("for job"));
        assertEquals("deepslate_diamond_ore", EarnText.milestoneIcon("deepslate_diamond"));
        assertEquals("end_stone", EarnText.milestoneIcon("end"));
        assertEquals("ancient_debris", EarnText.milestoneIcon("ancient_debris"));
        assertEquals("clock", EarnText.icon("wage", "day 5", null));
        assertEquals(24000 * 50L, EarnText.msToSunrise(0));
        assertEquals(1000 * 50L, EarnText.msToSunrise(23000));
        assertEquals(1000 * 50L, EarnText.msToSunrise(24000 * 7 + 23000));
        assertEquals("Milestone · first diamond (world first!)",
                EarnText.line(new EarnState.Earned("milestone", "Robin", 37, "first diamond", "diamond", true, NOW)));
        assertEquals("Daily wage", EarnText.line(new EarnState.Earned("wage", "Robin", 10, "", null, false, NOW)));
        EarnState.Job j = new EarnState.Job(1, "wheat", 10, 4, 2, null, java.util.Map.of(), 0, 0, "open");
        assertEquals(3, EarnText.deliverable(j, 3));
        assertEquals(4, EarnText.deliverable(j, 64));
        assertNull(j.premiumPct());
    }

    @Test
    void describeAndNoticeForNewTxKinds() {
        EconState.Tx refund = new EconState.Tx(5, NOW, "bounty_refund", "Escrow", "Robin", 20, null, 0, "task #12");
        assertEquals("Bounty refunded · task #12", EconText.describe(refund, "Robin"));
        EconState.Notice n = EconText.noticeFor(refund, "Robin", NOW);
        assertNotNull(n);
        assertEquals(EconState.Notice.Kind.BOUNTY_REFUND, n.kind());
        assertEquals(20, n.coins());
        EconState.Tx job = new EconState.Tx(6, NOW, "job_pay", "Server", "Robin", 24, "cobblestone", 12, "job #4");
        assertEquals("Server job: delivered 12 Cobblestone", EconText.describe(job, "Robin"));
        assertNull(EconText.noticeFor(job, "Robin", NOW)); // the earn event announces it
        EconState.Tx hold = new EconState.Tx(7, NOW, "bounty_hold", "Robin", "Escrow", 20, null, 0, "task #12");
        assertEquals("Bounty held · task #12", EconText.describe(hold, "Robin"));
        assertEquals(-20, hold.delta("Robin"));
    }

    @Test
    void boardPostAnswerWithoutOkCountsAsSuccess() {
        assertTrue(Econ.parseResult(js("{\"id\":21,\"title\":\"Build a bridge\",\"reward\":50}")).ok());
        Econ.Result bad = Econ.parseResult(js("{\"ok\":false,\"error\":\"not enough coins: have 40, need 50\"}"));
        assertFalse(bad.ok());
        assertEquals("not enough coins: have 40, need 50", bad.error());
        assertFalse(Econ.parseResult(js("{\"error\":\"x\",\"id\":3}")).ok());
    }
}
