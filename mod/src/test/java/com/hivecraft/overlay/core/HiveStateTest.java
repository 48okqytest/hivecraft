package com.hivecraft.overlay.core;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/** Protocol parsing + state merging, using the examples from MOD_PROTOCOL.md. */
class HiveStateTest {
    final AtomicLong clock = new AtomicLong(1763700000000L);
    HiveState st;

    @BeforeEach
    void setUp() { st = new HiveState(clock::get); }

    static JsonObject j(String s) { return JsonParser.parseString(s).getAsJsonObject(); }

    static final String BOT_ASH = """
            {"name":"Ash","color":"#F2B134","colorInt":15905076,"role":"Lead","online":true,"status":"online",
             "pos":{"x":12.31,"y":64.0,"z":-3.70},"bpos":{"x":12,"y":64,"z":-4},"yaw":1.57,"pitch":0.0,"dim":"overworld",
             "health":18.5,"food":17,"held":"iron_pickaxe","armor":["iron_helmet",null,null,null],
             "action":"collect","actionArgs":{"block":"iron_ore","count":24},
             "actionText":"mining iron_ore 12/24","busyMs":41000,
             "progress":{"done":12,"total":24},
             "task":{"id":4,"title":"Get 24 iron","status":"claimed"},
             "lastChat":{"text":"@all found iron at 40,12,-80","ts":1763699990000},
             "thought":"Iron is close, I'll mine the vein then smelt.",
             "dead":false}""";

    static final String INIT = """
            {"t":"init","protocol":1,"serverTime":1763700000000,
             "bots":[%s],
             "chat":[{"id":511,"from":"Flint","to":"all","text":"hi","ts":1763699980000,"color":"#4FC3F7"}],
             "board":[{"id":4,"title":"Get 24 iron","detail":"","status":"claimed","owner":"Flint","priority":2,"by":"Ash","notes":[],"updated":1763699000000},
                      {"id":5,"title":"Build house","status":"open","priority":5,"by":"Ash"},
                      {"id":3,"title":"Wood","status":"done","priority":9,"by":"Ash"}],
             "goal":{"text":"Build a castle","by":"Robin","ts":1763690000000},
             "waypoints":[{"name":"base","x":10,"y":64,"z":5,"by":"Ash","note":"","dimension":"overworld"}],
             "ghosts":[],
             "ledgerRecent":[{"id":9000,"ts":1763699999000,"bot":"Ash","op":"place","block":"cobblestone","x":1,"y":64,"z":1,"dim":"overworld","cause":"place"}],
             "photos":[{"id":"Ash-1","agent":"Ash","ts":1,"caption":"old","mode":"orbit","url":"/photos/Ash-1.png"}],
             "commands":["help","bots","status"]}""".formatted(BOT_ASH);

    @Test
    void initPopulatesEverything() {
        assertEquals("init", st.applyText(INIT));
        assertEquals(1, st.protocol());
        assertEquals(1, st.bots().size());
        BotState a = st.bot("ash");
        assertNotNull(a);
        assertEquals(0xF2B134, a.color());
        assertEquals("Lead", a.role());
        assertEquals(12.31, a.x(), 1e-9);
        assertEquals(-4, a.bz());
        assertEquals(18.5f, a.health());
        assertEquals(17, a.food());
        assertEquals("iron_pickaxe", a.held());
        assertEquals(4, a.armor().size());
        assertNull(a.armor().get(1));
        assertEquals("collect", a.actionName());
        assertTrue(a.hasProgress());
        assertEquals(0.5f, a.progressFraction(), 1e-6);
        assertEquals(4, a.taskId());
        assertEquals("Get 24 iron", a.taskTitle());
        assertEquals("@all found iron at 40,12,-80", a.lastChat());
        assertFalse(a.dead());

        assertEquals(1, st.chat().size());
        assertEquals(0x4FC3F7, st.chat().get(0).color());
        // board sorted: claimed, open, done
        assertEquals(List.of(4, 5, 3), st.board().stream().map(TaskInfo::id).toList());
        assertEquals("Build a castle", st.goal().text());
        assertEquals("base", st.waypoints().get(0).name());
        assertEquals("overworld", st.waypoints().get(0).dim());
        assertEquals(1, st.ledger().size());
        assertEquals(1, st.photos().size());
        assertEquals(List.of("help", "bots", "status"), st.commands());
    }

    @Test
    void mcYawConversion() {
        BotState a = BotState.parse(j("{\"name\":\"A\",\"yaw\":0}"), null, 0, 0);
        assertEquals(180f, Math.abs(a.mcYaw()), 1e-3); // facing north = MC 180/-180
        BotState b = BotState.parse(j("{\"name\":\"A\",\"yaw\":" + (Math.PI / 2) + "}"), null, 0, 0);
        assertEquals(90f, b.mcYaw(), 1e-3); // mineflayer +90deg (west) = MC yaw 90
        BotState c = BotState.parse(j("{\"name\":\"A\"}"), null, 0, 0);
        assertNull(c.yaw());
        assertEquals(0f, c.mcYaw());
        assertNull(c.actionName());
        assertTrue(c.idle());
        assertFalse(c.hasProgress());
    }

    @Test
    void botsInterpolateBetweenUpdatesAndSnapOnTeleport() {
        st.applyText("{\"t\":\"bots\",\"bots\":[{\"name\":\"Ash\",\"online\":true,\"pos\":{\"x\":0,\"y\":64,\"z\":0}}]}");
        clock.addAndGet(200);
        st.applyText("{\"t\":\"bots\",\"bots\":[{\"name\":\"Ash\",\"online\":true,\"pos\":{\"x\":1,\"y\":64,\"z\":0}}]}");
        BotState a = st.bot("Ash");
        long t0 = a.receivedAt();
        assertEquals(0, a.lerpX(t0), 1e-9);
        assertEquals(0.5, a.lerpX(t0 + BotState.LERP_MS / 2), 1e-9);
        assertEquals(1, a.lerpX(t0 + BotState.LERP_MS * 3), 1e-9);
        // teleport: no lerp
        clock.addAndGet(200);
        st.applyText("{\"t\":\"bots\",\"bots\":[{\"name\":\"Ash\",\"online\":true,\"pos\":{\"x\":500,\"y\":64,\"z\":0}}]}");
        BotState b = st.bot("Ash");
        assertEquals(500, b.lerpX(b.receivedAt()), 1e-9);
    }

    @Test
    void botsListReplacesAndSortsAndFiresActionChanges() {
        List<String> changes = new ArrayList<>();
        st.addListener(new HiveListener() {
            @Override public void onBotAction(BotState bot, String prev) { changes.add(bot.name() + ":" + prev + "->" + bot.actionName()); }
        });
        st.applyText("{\"t\":\"bots\",\"bots\":[{\"name\":\"Wren\",\"action\":null},{\"name\":\"Ash\",\"action\":\"collect\"}]}");
        assertEquals(List.of("Ash", "Wren"), st.bots().stream().map(BotState::name).toList());
        st.applyText("{\"t\":\"bots\",\"bots\":[{\"name\":\"Wren\",\"action\":\"auto:eat\"},{\"name\":\"Ash\",\"action\":\"collect\"}]}");
        assertEquals(List.of("Wren:null->eat"), changes);
        st.applyText("{\"t\":\"bots\",\"bots\":[{\"name\":\"Ash\"}]}");
        assertNull(st.bot("Wren"));
    }

    @Test
    void pathsSetAndClear() {
        st.applyText("""
                {"t":"path","bot":"Ash","ts":1763700000300,"dim":"overworld",
                 "goal":{"x":40,"y":12,"z":-80},"points":[[12,64,-4],[13,64,-4],[14,63,-5]],"status":"success"}""");
        PathInfo p = st.path("Ash");
        assertEquals(3, p.points().size());
        assertArrayEquals(new int[]{40, 12, -80}, p.goal());
        assertArrayEquals(new int[]{14, 63, -5}, p.points().get(2));
        st.applyText("{\"t\":\"path\",\"bot\":\"Ash\",\"points\":[],\"status\":\"cleared\"}");
        assertNull(st.path("Ash"));
    }

    @Test
    void chatDedupesAndCaps() {
        List<ChatLine> seen = new ArrayList<>();
        st.addListener(new HiveListener() { @Override public void onChat(ChatLine l) { seen.add(l); } });
        String m = "{\"t\":\"chat\",\"msg\":{\"id\":512,\"from\":\"Ash\",\"to\":\"all\",\"text\":\"found iron\",\"ts\":1,\"color\":\"#F2B134\"}}";
        st.applyText(m);
        st.applyText(m);
        assertEquals(1, st.chat().size());
        assertEquals(1, seen.size());
        for (int i = 0; i < HiveState.MAX_CHAT + 20; i++)
            st.applyText("{\"t\":\"chat\",\"msg\":{\"id\":" + (1000 + i) + ",\"from\":\"Ash\",\"text\":\"x\"}}");
        assertEquals(HiveState.MAX_CHAT, st.chat().size());
        assertEquals(1000 + HiveState.MAX_CHAT + 19, st.chat().get(st.chat().size() - 1).id());
    }

    @Test
    void boardUpdateAndDelete() {
        st.applyText(INIT);
        st.applyText("{\"t\":\"board\",\"task\":{\"id\":5,\"title\":\"Build house\",\"status\":\"claimed\",\"owner\":\"Wren\",\"priority\":5}}");
        assertEquals(5, st.board().get(0).id()); // claimed with higher priority first
        assertEquals("Wren", st.board().get(0).owner());
        st.applyText("{\"t\":\"board\",\"task\":{\"id\":4},\"deleted\":true}");
        assertTrue(st.board().stream().noneMatch(t -> t.id() == 4));
    }

    @Test
    void waypointsAddAndDelete() {
        st.applyText("{\"t\":\"waypoint\",\"waypoint\":{\"name\":\"mine1\",\"x\":40,\"y\":12,\"z\":-80,\"by\":\"Flint\",\"dimension\":\"overworld\"}}");
        st.applyText("{\"t\":\"waypoint\",\"waypoint\":{\"name\":\"nport\",\"x\":1,\"y\":70,\"z\":1,\"dimension\":\"the_nether\"}}");
        assertEquals(2, st.waypoints().size());
        assertEquals("nether", st.waypoints().get(1).dim());
        st.applyText("{\"t\":\"waypoint\",\"waypoint\":{\"name\":\"mine1\"},\"deleted\":true}");
        assertEquals(List.of("nport"), st.waypoints().stream().map(Waypoint::name).toList());
    }

    static final String GHOSTS = """
            {"t":"ghosts","ghosts":[
             {"id":"house_10_64_5","kind":"build","blueprint":"house","bot":"Wren","bots":["Wren","Moss"],
              "origin":{"x":10,"y":64,"z":5},"rotation":0,"dim":"overworld",
              "bounds":{"minX":10,"maxX":16,"minY":64,"maxY":70,"minZ":5,"maxZ":11},
              "total":312,"done":120,"remaining":192,"progress":38,"finished":false,"updated":1763700000000,
              "rev":17,
              "blocks":[[11,64,5,"cobblestone","",1],[11,65,6,"oak_stairs","facing=east,half=bottom",0]]},
             {"id":"preview:Wren:house:20:64:5","kind":"preview","blueprint":"house","bot":"Wren","origin":{"x":20,"y":64,"z":5},
              "rotation":90,"total":312,"done":0,"remaining":312,"progress":0,"expires":1763700600000,"rev":1,
              "blocks":[[21,64,5,"cobblestone","",0,"ok"],[22,64,5,"cobblestone","",0,"conflict"]]}
            ]}""";

    @Test
    void ghostsParseKeepBlocksWhenRevUnchangedAndDropMissing() {
        st.applyText(GHOSTS);
        assertEquals(2, st.ghosts().size());
        Ghost h = st.ghost("house_10_64_5");
        assertEquals(38, h.progress());
        assertEquals(List.of("Wren", "Moss"), h.bots());
        assertEquals(2, h.blocks().size());
        assertTrue(h.blocks().get(0).placed());
        assertEquals("facing=east,half=bottom", h.blocks().get(1).state());
        assertEquals(16, h.maxX());
        Ghost p = st.ghost("preview:Wren:house:20:64:5");
        assertTrue(p.isPreview());
        assertTrue(p.blocks().get(1).conflict());
        // bounds computed from blocks when missing
        assertEquals(21, p.minX());
        assertEquals(22, p.maxX());

        // summary without blocks (rev unchanged): blocks kept; preview gone
        st.applyText("""
                {"t":"ghosts","ghosts":[{"id":"house_10_64_5","kind":"build","blueprint":"house","bot":"Wren",
                 "origin":{"x":10,"y":64,"z":5},"dim":"overworld","total":312,"done":130,"progress":42,"rev":17}]}""");
        assertEquals(1, st.ghosts().size());
        h = st.ghost("house_10_64_5");
        assertEquals(42, h.progress());
        assertEquals(2, h.blocks().size());
        assertFalse(st.takeGhostResync());
    }

    @Test
    void ghostWithoutKnownBlocksRequestsResync() {
        st.applyText("{\"t\":\"ghosts\",\"ghosts\":[{\"id\":\"g1\",\"total\":10,\"rev\":3}]}");
        assertTrue(st.takeGhostResync());
        assertFalse(st.takeGhostResync()); // one-shot
    }

    @Test
    void ledgerEventsTickGhostCellsLive() {
        st.applyText(GHOSTS);
        st.applyText("""
                {"t":"ledger","events":[
                 {"id":9123,"ts":1763700000400,"bot":"Wren","op":"place","block":"oak_stairs","state":"facing=east,half=bottom,shape=straight,waterlogged=false",
                  "prev":"air","x":11,"y":65,"z":6,"dim":"overworld","cause":"blueprint","action":"blueprint_build","build":"house_10_64_5","section":1,"phase":"place"}]}""");
        Ghost h = st.ghost("house_10_64_5");
        assertTrue(h.blockAt(11, 65, 6).placed());
        assertEquals(121, h.done());
        assertEquals(39, h.progress()); // round(121*100/312)
        // breaking it again unticks
        st.applyText("{\"t\":\"ledger\",\"events\":[{\"id\":9124,\"ts\":1763700000500,\"bot\":\"Wren\",\"op\":\"break\",\"block\":\"oak_stairs\",\"x\":11,\"y\":65,\"z\":6,\"build\":\"house_10_64_5\"}]}");
        assertFalse(st.ghost("house_10_64_5").blockAt(11, 65, 6).placed());
        assertEquals(120, st.ghost("house_10_64_5").done());
    }

    @Test
    void ledgerListenerGetsOnlyNewEvents() {
        List<Integer> sizes = new ArrayList<>();
        st.addListener(new HiveListener() { @Override public void onLedger(List<LedgerEvent> a) { sizes.add(a.size()); } });
        String m = "{\"t\":\"ledger\",\"events\":[{\"id\":1,\"ts\":5,\"bot\":\"Ash\",\"op\":\"place\",\"block\":\"dirt\",\"x\":0,\"y\":0,\"z\":0}]}";
        st.applyText(m);
        st.applyText(m);
        assertEquals(List.of(1), sizes);
    }

    @Test
    void photosDedupeNewestFirst() {
        st.applyText("{\"t\":\"photo\",\"photo\":{\"id\":\"Ash-1\",\"agent\":\"Ash\",\"ts\":1,\"caption\":\"a\"}}");
        st.applyText("{\"t\":\"photo\",\"photo\":{\"id\":\"Ash-2\",\"agent\":\"Ash\",\"ts\":2,\"caption\":\"b\",\"url\":\"/photos/Ash-2.png\",\"width\":768,\"height\":432}}");
        st.applyText("{\"t\":\"photo\",\"photo\":{\"id\":\"Ash-1\",\"agent\":\"Ash\",\"ts\":1}}");
        assertEquals(List.of("Ash-2", "Ash-1"), st.photos().stream().map(Photo::id).toList());
        assertEquals("/photos/Ash-1.png", st.photos().get(1).url());
        assertEquals(768, st.photos().get(0).width());
    }

    @Test
    void logEventGoalAndUnknownTypes() {
        st.applyText("{\"t\":\"log\",\"bot\":\"Ash\",\"kind\":\"tool\",\"text\":\"collect {}\",\"ts\":1}");
        st.applyText("{\"t\":\"event\",\"bot\":\"Flint\",\"kind\":\"death\",\"text\":\"You died\",\"ts\":2}");
        st.applyText("{\"t\":\"goal\",\"goal\":{\"text\":\"Castle\",\"by\":\"Robin\",\"ts\":3}}");
        long rev = st.revision();
        assertEquals("future_thing", st.applyText("{\"t\":\"future_thing\",\"x\":1}"));
        assertTrue(st.revision() > rev);
        assertNull(st.applyText("not json {"));
        assertNull(st.applyText("[1,2]"));
        assertEquals("tool", st.log().get(0).kind());
        assertEquals("death", st.events().get(0).kind());
        assertEquals("Castle", st.goal().text());
    }

    @Test
    void malformedFieldsDoNotThrow() {
        assertDoesNotThrow(() -> st.applyText("{\"t\":\"bots\",\"bots\":[{\"name\":\"A\",\"pos\":\"nope\",\"health\":\"x\",\"armor\":5,\"progress\":[]}, 7, null]}"));
        assertEquals(1, st.bots().size());
        assertEquals(20f, st.bot("A").health());
        assertDoesNotThrow(() -> st.applyText("{\"t\":\"ghosts\",\"ghosts\":[{\"id\":\"g\",\"blocks\":[[1,2],\"x\",[1,2,3,\"stone\"]]}]}"));
        assertEquals(1, st.ghost("g").blocks().size());
        assertDoesNotThrow(() -> st.applyText("{\"t\":\"ledger\",\"events\":\"bad\"}"));
        assertDoesNotThrow(() -> st.applyText("{\"t\":\"chat\"}"));
        assertDoesNotThrow(() -> st.applyText("{\"t\":\"board\",\"task\":null}"));
    }

    @Test
    void listenerExceptionsAreContained() {
        st.addListener(new HiveListener() { @Override public void onMessage(String t, JsonObject m) { throw new RuntimeException("boom"); } });
        assertDoesNotThrow(() -> st.applyText("{\"t\":\"goal\",\"goal\":{\"text\":\"x\"}}"));
        assertEquals("x", st.goal().text());
    }

    @Test
    void previewsExpireOnPrune() {
        st.applyText(GHOSTS);
        clock.set(1763700600001L);
        st.prune(60_000, 300_000);
        assertNull(st.ghost("preview:Wren:house:20:64:5"));
        assertNotNull(st.ghost("house_10_64_5"));
    }

    @Test
    void connectionStateNotifies() {
        List<HiveState.Connection> seen = new ArrayList<>();
        st.addListener(new HiveListener() { @Override public void onConnection(HiveState.Connection c) { seen.add(c); } });
        st.setConnection(HiveState.Connection.CONNECTING, null);
        st.setConnection(HiveState.Connection.ONLINE, null);
        st.setConnection(HiveState.Connection.ONLINE, null);
        st.setConnection(HiveState.Connection.OFFLINE, "closed 1006");
        assertEquals(List.of(HiveState.Connection.CONNECTING, HiveState.Connection.ONLINE, HiveState.Connection.OFFLINE), seen);
        assertEquals("closed 1006", st.lastError());
        assertFalse(st.online());
    }
}
