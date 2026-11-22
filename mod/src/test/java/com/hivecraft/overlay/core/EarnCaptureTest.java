package com.hivecraft.overlay.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Feeds REAL bridge output into EconState / EarnState. {@code bridge-capture/earnings-capture.json} was recorded from
 * {@code bridge/hub/app.js} + {@code earnings.js} offline (mock engine, fake RCON; script next to it): init.econ, the
 * ws events that followed (board bounties, job delivery, mob kills, a world-first diamond, a new day's wage, job
 * rotation), the final GET /econ/state, /econ/jobs, /econ/bounties, /econ/earnings, POST answers and economy-off.
 */
class EarnCaptureTest {
    /** The local player in these tests is Robin (the mod's who() for /econ requests and "me" before a snapshot). */
    @BeforeEach
    void localPlayer() { EconState.setBridgeName(null); EconState.setLocalName("Robin"); }

    static JsonObject cap;

    @BeforeAll
    static void load() throws Exception {
        try (InputStream in = EarnCaptureTest.class.getResourceAsStream("/bridge-capture/earnings-capture.json")) {
            assertNotNull(in, "capture resource missing");
            cap = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
        }
    }

    static JsonObject o(String k) { return cap.getAsJsonObject(k); }

    /** init.econ, then every captured ws econ event in order (as HiveState would). */
    static EconState replay(List<EconState.Notice> sink) {
        EconState s = new EconState();
        if (sink != null) s.addListener(sink::add);
        s.applySnapshot(o("init"));
        long now = J.lng(o("state").getAsJsonArray("tx").get(0).getAsJsonObject(), "ts", 0);
        for (JsonElement e : cap.getAsJsonArray("ws")) {
            JsonObject m = e.getAsJsonObject();
            if ("econ".equals(J.str(m, "t"))) s.apply(m, now);
        }
        return s;
    }

    static EconState snapshot() {
        EconState s = new EconState();
        s.applySnapshot(o("state"));
        return s;
    }

    @Test
    void finalSnapshotParses() {
        EconState s = snapshot();
        EarnState e = s.earn();
        JsonObject st = o("state");
        assertTrue(e.available());
        assertEquals(96, s.balance());
        assertEquals(st.getAsJsonArray("jobs").size(), e.jobs().size());
        for (JsonElement je : st.getAsJsonArray("jobs")) {
            JsonObject jo = je.getAsJsonObject();
            EarnState.Job j = e.job(J.integer(jo, "id", -1));
            assertNotNull(j);
            assertEquals(J.str(jo, "item"), j.item());
            assertEquals(J.integer(jo, "left", -1), j.left());
            assertEquals(J.integer(jo, "pay", -1), j.pay());
            assertEquals(J.integer(jo, "shopSell", -1), j.shopSell());
            assertEquals(J.lng(jo, "expiresAt", -1), j.expiresAt());
            assertTrue(j.open());
            // shipped catalog: +50% over the shop's sell price, at least +1 coin (so cheap items show more)
            int sell = J.integer(jo, "shopSell", 0);
            assertEquals(Math.max(sell + 1, (int) Math.round(sell * 1.5)), j.pay());
            assertEquals((int) Math.round((j.pay() - sell) * 100.0 / sell), j.premiumPct());
        }
        assertEquals(J.lng(st, "nextRotation", -1), e.nextRotation());
        assertEquals(1, e.bounties().size());
        EarnState.Bounty b = e.bounties().get(0);
        assertEquals("Mine 24 iron", b.title());
        assertEquals(30, b.share("Robin"));
        assertNull(b.owner());

        JsonObject ea = st.getAsJsonObject("earnings");
        JsonObject tot = ea.getAsJsonObject("totals");
        for (String src : EarnState.SOURCES) assertEquals(J.lng(tot, src, -1), e.totals().get(src), src);
        assertFalse(e.totals().containsKey("all"), "the bridge's 'all' is not a source");
        assertEquals(J.lng(tot, "all", -1), e.total());
        assertEquals(J.lng(tot, "today", -1), e.today(0));
        assertEquals(J.lng(ea, "nextSunrise", -1), e.nextSunrise(0));
        assertEquals(J.lng(ea, "day", -2), e.day());

        EarnState.Rates r = e.rates();
        assertEquals(ea.getAsJsonObject("rates").getAsJsonObject("mobs").size(), r.mobs().size());
        assertEquals("ravager", r.mobs().keySet().iterator().next()); // priciest first
        assertEquals(3, r.mobs().get("zombie"));
        assertEquals(60, r.mobCapPerMinute());
        assertEquals(10, r.wage());
        assertEquals(50, r.jobPremiumPct());

        assertEquals(6, e.milestones().size());
        EarnState.Milestone d = e.milestone("diamond");
        assertTrue(d.done());
        assertTrue(d.worldFirst());
        assertEquals("Robin", d.firstBy());
        assertEquals(13, d.first());
        assertEquals("First diamond", EarnText.cap(d.label()));
        assertFalse(e.milestone("end").done());
        assertEquals(100, e.milestone("end").reward());
        // recent = earning tx only
        assertEquals(List.of("wage", "milestone", "milestone", "mob", "job"), e.recent().stream().map(EarnState.Earned::source).toList());
    }

    @Test
    void liveEventsEndWhereTheSnapshotDoes() {
        List<EconState.Notice> n = new ArrayList<>();
        EconState live = replay(n);
        EconState snap = snapshot();
        EarnState a = live.earn(), b = snap.earn();
        assertEquals(snap.balance(), live.balance());
        assertEquals(b.jobs().stream().map(EarnState.Job::id).toList(), a.jobs().stream().map(EarnState.Job::id).toList());
        assertEquals(b.nextRotation(), a.nextRotation());
        assertEquals(b.totals(), a.totals());
        assertEquals(b.today(0), a.today(0), "a new day (wage day 4) restarts today");
        assertEquals(openTasks(b), openTasks(a));
        assertTrue(a.milestone("diamond").done());
        assertTrue(a.milestone("diamond").worldFirst());
        // paid / refunded bounties stay visible after the open ones
        assertEquals("paid", a.bounty(1).status());
        assertEquals("Ash", a.bounty(1).paidTo());
        assertEquals("refunded", a.bounty(2).status());
        assertTrue(a.bounty(3).open());
        assertEquals(3, a.bounties().get(0).task());

        // Robin's earnings → ticker / HUD notices (Ash's mob kill and wage are not ours)
        List<EconState.Notice> earned = n.stream().filter(x -> x.kind() == EconState.Notice.Kind.EARNED).toList();
        assertEquals(List.of("job", "mob", "milestone", "milestone", "wage"), earned.stream().map(EconState.Notice::other).toList());
        assertEquals(List.of(9L, 9L, 25L, 13L, 10L), earned.stream().map(EconState.Notice::coins).toList());
        assertEquals("bread", earned.get(0).item()); // looked up from job #1
        assertEquals("Server job · 3 bread for job #1", earned.get(0).text());
        assertEquals("zombie_spawn_egg", earned.get(1).item());
        assertEquals("Mob bounty · 2 zombie, 1 skeleton", earned.get(1).text());
        assertEquals("Milestone · first diamond", earned.get(2).text());
        assertEquals("Milestone · world first: first diamond", earned.get(3).text()); // no doubled "(world first!)"
        assertEquals("diamond", earned.get(3).item());
        assertEquals("Daily wage · day 4", earned.get(4).text());
        assertEquals("clock", earned.get(4).item());
        assertTrue(n.stream().noneMatch(x -> x.kind() == EconState.Notice.Kind.WORLD_FIRST), "our own world first isn't announced as someone else's");
        assertTrue(n.stream().anyMatch(x -> x.kind() == EconState.Notice.Kind.BOUNTY_REFUND && x.coins() == 12 && x.text().equals("Bounty refunded · task #2 withdrawn")));
    }

    static Set<Integer> openTasks(EarnState e) {
        Set<Integer> s = new TreeSet<>();
        for (EarnState.Bounty b : e.bounties()) if (b.open()) s.add(b.task());
        return s;
    }

    @Test
    void httpAnswersParse() {
        EconState s = new EconState();
        s.applySnapshot(o("init"));
        // GET /econ/jobs has the same Job objects and nextRotation
        JsonObject jobs = o("jobsGet");
        JsonObject m = new JsonObject();
        m.add("jobs", jobs.get("jobs"));
        m.add("nextRotation", jobs.get("nextRotation"));
        s.earn().apply("jobs", m, "Robin", 0);
        assertEquals(4, s.earn().jobs().size());
        assertEquals(J.lng(jobs, "nextRotation", -1), s.earn().nextRotation());
        // POST /econ/jobs/deliver → Result ok + optimistic job update
        Econ.Result dr = Econ.parseResult(o("deliver"));
        assertTrue(dr.ok());
        assertEquals(9, J.lng(dr.body(), "earned", 0));
        s.applyEarnAnswer(o("deliver"));
        assertEquals(5, s.earn().job(1).left());
        assertEquals(3, s.earn().job(1).deliveredBy("Robin"));
        // POST /econ/bounty and /econ/bounty/cancel
        assertTrue(Econ.parseResult(o("bountyAdd")).ok());
        s.applyEarnAnswer(o("bountyAdd"));
        assertEquals(45, s.earn().bounty(1).total());
        assertEquals(5, s.earn().bounty(1).share("Ash"));
        assertTrue(Econ.parseResult(o("bountyCancel")).ok());
        assertEquals(12, J.lng(o("bountyCancel"), "refunded", 0));
        s.applyEarnAnswer(o("bountyCancel"));
        assertEquals("refunded", s.earn().bounty(2).status());
        // POST /board answers with the bare task (no "ok"); too much → {ok:false,error}
        Econ.Result bp = Econ.parseResult(o("boardPost"));
        assertTrue(bp.ok());
        assertEquals(1, J.integer(bp.body(), "id", -1));
        Econ.Result bad = Econ.parseResult(o("boardPostTooMuch"));
        assertFalse(bad.ok());
        assertTrue(bad.error().startsWith("not enough coins"));
        // GET /econ/earnings
        s.applyEarnings(o("earningsGet"));
        assertEquals(66, s.earn().total());
        assertEquals(10, s.earn().today(0));
        // GET /econ/bounties?all=1 → rows with the board
        List<EarnState.Bounty> all = new ArrayList<>();
        for (JsonElement e : o("bountiesAll").getAsJsonArray("bounties")) {
            JsonObject bm = new JsonObject();
            bm.add("bounty", e);
            s.earn().apply("bounty", bm, "Robin", 0);
        }
        all.addAll(s.earn().bounties());
        List<TaskInfo> board = new ArrayList<>();
        for (JsonElement e : cap.getAsJsonArray("boardGet")) board.add(TaskInfo.parse(e.getAsJsonObject()));
        List<EarnText.Row> rows = EarnText.rows(board, all, "Robin");
        assertEquals(List.of(3, 2, 1), rows.stream().map(EarnText.Row::task).toList());
        assertEquals("open", rows.get(0).status());
        assertTrue(EarnText.canWithdraw(rows.get(0), "Robin"));
        assertEquals("open · reward refunded", rows.get(1).status());
        assertFalse(rows.get(1).rewardOpen());
        assertEquals("paid to Ash", rows.get(2).status());
        assertFalse(rows.get(2).open());
    }

    @Test
    void boardTasksCarryTheReward() {
        TaskInfo done = TaskInfo.parse(o("boardDone"));
        assertEquals(40, done.reward());
        assertEquals("paid", done.rewardStatus());
        assertEquals("Ash", done.rewardTo());
        assertEquals(0, done.priority()); // the bridge sends priority "normal" (a word): parsed as 0, no crash
        // every captured ws board task parses; one without a reward has none
        JsonArray ws = cap.getAsJsonArray("ws");
        int withReward = 0;
        for (JsonElement e : ws) {
            JsonObject m = e.getAsJsonObject();
            if (!"board".equals(J.str(m, "t"))) continue;
            TaskInfo t = TaskInfo.parse(m.getAsJsonObject("task"));
            if (t.hasReward()) withReward++;
            else assertTrue(t.rewardStatus() == null || "refunded".equals(t.rewardStatus()));
        }
        assertTrue(withReward >= 5);
    }

    @Test
    void walletDescribesTheRealTx() {
        EconState s = snapshot();
        List<String> lines = s.tx().stream().map(t -> EconText.describe(t, "Robin")).toList();
        assertTrue(lines.contains("Daily wage · day 4"), lines.toString());
        assertTrue(lines.contains("World-first bonus · first diamond"), lines.toString());
        assertTrue(lines.contains("Milestone · first diamond"), lines.toString());
        assertTrue(lines.contains("Mob bounty · 2 zombie, 1 skeleton"), lines.toString());
        assertTrue(lines.contains("Server job: delivered 3 Bread"), lines.toString());
        assertTrue(lines.contains("Bounty held · task #3 Mine 24 iron"), lines.toString());
        assertTrue(lines.contains("Bounty refunded · task #2 withdrawn"), lines.toString());
    }

    @Test
    void economyOffAnswer() {
        JsonObject off = o("off");
        assertEquals(404, J.integer(off, "status", 0));
        String err = J.str(off.getAsJsonObject("json"), "error");
        assertTrue(EconState.isOffError(err), err);
        EconState s = new EconState();
        s.setDisabled(err);
        assertEquals(err, s.disabled());
        assertFalse(s.earn().available());
    }
}
