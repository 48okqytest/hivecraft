package com.hivecraft.overlay.ui;

import com.google.gson.JsonParser;
import com.hivecraft.overlay.ui.term.CommandHistory;
import com.hivecraft.overlay.ui.term.Scrollback;
import com.hivecraft.overlay.ui.term.TabCompleter;
import com.hivecraft.overlay.ui.term.TermLine;
import com.hivecraft.overlay.ui.term.TerminalController;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.jupiter.api.Assertions.*;

class TerminalLogicTest {

    static final List<String> CMDS = List.of("help", "bots", "status", "say", "goal", "board", "stop", "come", "follow", "who", "placed", "photos", "log", "builds", "where");
    static final List<String> BOTS = List.of("Ash", "Flint", "Wren", "Fern");

    // ------------------------------------------------------------ history

    @Test
    void historyWalksAndRestoresDraft() {
        CommandHistory h = new CommandHistory(10);
        h.add("bots");
        h.add("status Ash");
        h.add("status Ash"); // duplicate ignored
        h.add("   ");        // blank ignored
        assertEquals(2, h.size());
        assertEquals("status Ash", h.up("half typed"));
        assertEquals("bots", h.up("status Ash"));
        assertEquals("bots", h.up("bots")); // stays at oldest
        assertEquals("status Ash", h.down("bots"));
        assertEquals("half typed", h.down("status Ash")); // back to draft
        assertEquals("half typed", h.down("half typed")); // nothing newer
        assertFalse(h.isBrowsing());
    }

    @Test
    void historyCapsSize() {
        CommandHistory h = new CommandHistory(3);
        for (int i = 0; i < 6; i++) h.add("c" + i);
        assertEquals(List.of("c3", "c4", "c5"), h.entries());
    }

    @Test
    void historyEmptyUpReturnsCurrent() {
        CommandHistory h = new CommandHistory(3);
        assertEquals("x", h.up("x"));
        assertEquals("x", h.down("x"));
    }

    // ------------------------------------------------------------ completion

    TabCompleter tc() {
        return new TabCompleter(() -> CMDS, () -> BOTS);
    }

    @Test
    void completesUniqueCommandWithSpace() {
        TabCompleter.Result r = tc().complete("sta", 3, false);
        assertEquals("status ", r.text());
        assertEquals(7, r.cursor());
    }

    @Test
    void completesBotNameCaseInsensitive() {
        assertEquals("status Flint ", tc().complete("status fl", 9, false).text());
    }

    @Test
    void ambiguousCyclesBothWays() {
        TabCompleter t = tc();
        // "b" -> board, bots, builds: no common extension beyond "b" -> cycles
        TabCompleter.Result r1 = t.complete("b", 1, false);
        assertEquals(3, r1.candidates().size());
        assertEquals("board", r1.text());
        TabCompleter.Result r2 = t.complete(r1.text(), r1.cursor(), false);
        assertEquals("bots", r2.text());
        TabCompleter.Result r3 = t.complete(r2.text(), r2.cursor(), false);
        assertEquals("builds", r3.text());
        TabCompleter.Result r4 = t.complete(r3.text(), r3.cursor(), false);
        assertEquals("board", r4.text()); // wraps
        TabCompleter.Result r5 = t.complete(r4.text(), r4.cursor(), true);
        assertEquals("builds", r5.text()); // shift-tab backwards
    }

    @Test
    void extendsToCommonPrefixThenCycles() {
        TabCompleter t = new TabCompleter(() -> List.of("photos", "photograph"), () -> BOTS);
        TabCompleter.Result p = t.complete("ph", 2, false);
        assertEquals("photo", p.text());
        TabCompleter.Result q = t.complete(p.text(), p.cursor(), false);
        assertEquals("photograph", q.text()); // sorted: photograph < photos
        assertEquals("photos", t.complete(q.text(), q.cursor(), false).text());
    }

    @Test
    void editResetsCycling() {
        TabCompleter t = tc();
        TabCompleter.Result r1 = t.complete("b", 1, false);
        assertEquals("board", r1.text());
        // user typed something else: fresh completion
        assertEquals("status ", t.complete("sta", 3, false).text());
    }

    @Test
    void stopAcceptsAll() {
        TabCompleter.Result r = tc().complete("stop a", 6, false);
        assertEquals(List.of("Ash", "all"), r.candidates());
        assertEquals("stop all ", tc().complete("stop al", 7, false).text());
    }

    @Test
    void boardSubcommandsAndFreeText() {
        assertEquals("board add ", tc().complete("board a", 7, false).text());
        TabCompleter.Result r = tc().complete("board add fl", 12, false);
        assertFalse(r.changed());
        assertTrue(r.candidates().isEmpty());
    }

    @Test
    void completesInMiddleKeepsTail() {
        TabCompleter.Result r = tc().complete("sta Ash", 3, false);
        assertEquals("status Ash", r.text());
        assertEquals(6, r.cursor());
    }

    @Test
    void unknownCommandNoArgs() {
        assertFalse(tc().complete("frobnicate A", 12, false).changed());
    }

    // ------------------------------------------------------------ lines + scrollback

    static final Scrollback.Measurer MONO = (seg, s) -> s.length() * 6; // 6 px per char

    @Test
    void parsesProtocolLine() {
        TermLine l = TermLine.fromJson(JsonParser.parseString(
                "[{\"text\":\"Ash\",\"color\":\"#F2B134\",\"bold\":true},{\"text\":\"  online\",\"click\":\"status Ash\"}]"), 0xFFFFFFFF);
        assertEquals(2, l.segs().size());
        assertEquals(0xFFF2B134, l.segs().get(0).argb());
        assertTrue(l.segs().get(0).bold());
        assertEquals("status Ash", l.segs().get(1).click());
        assertEquals(0xFFFFFFFF, l.segs().get(1).argb());
        assertEquals("Ash  online", l.plain());
        assertEquals(0xFF123456, TermLine.parseColor("#123456", 0));
        assertEquals(7, TermLine.parseColor("nope", 7));
    }

    @Test
    void wrapsOnWordsAndHardBreaks() {
        TermLine l = TermLine.of("hello world this is long", 0xFFFFFFFF);
        List<Scrollback.Row> rows = Scrollback.wrap(l, 12 * 6, MONO); // 12 chars per row
        assertEquals(List.of("hello world", "this is long"), rows.stream().map(TerminalLogicTest::plain).toList());
        assertTrue(rows.get(0).first());
        assertFalse(rows.get(1).first());

        List<Scrollback.Row> hard = Scrollback.wrap(TermLine.of("abcdefghijklmnop", 0), 5 * 6, MONO);
        assertEquals(List.of("abcde", "fghij", "klmno", "p"), hard.stream().map(TerminalLogicTest::plain).toList());
    }

    @Test
    void wrapAcrossSegmentsMovesWord() {
        TermLine l = TermLine.of(TermLine.seg("Ash ", 1), TermLine.seg("mining iron", 2));
        List<Scrollback.Row> rows = Scrollback.wrap(l, 10 * 6, MONO);
        assertEquals("Ash mining", plain(rows.get(0)));
        assertEquals("iron", plain(rows.get(1)));
        for (Scrollback.Row r : rows) assertTrue(plain(r).length() <= 10);
    }

    @Test
    void newlinesSplitRows() {
        assertEquals(3, Scrollback.wrap(TermLine.of("a\nb\nc", 0), 100, MONO).size());
    }

    @Test
    void scrollbackScrollsAndAnchors() {
        Scrollback sb = new Scrollback(100);
        for (int i = 0; i < 30; i++) sb.add(TermLine.of("line " + i, 0));
        List<Scrollback.Row> v = sb.visible(600, 10, MONO);
        assertEquals("line 29", plain(v.get(9)));
        sb.scrollBy(5, 10);
        v = sb.visible(600, 10, MONO);
        assertEquals("line 24", plain(v.get(9)));
        // new output while scrolled up: view stays on the same lines
        sb.add(TermLine.of("line 30", 0));
        sb.add(TermLine.of("line 31", 0));
        v = sb.visible(600, 10, MONO);
        assertEquals("line 24", plain(v.get(9)));
        sb.scrollBy(1000, 10);
        assertEquals("line 0", plain(sb.visible(600, 10, MONO).get(0)));
        sb.scrollToBottom();
        assertEquals("line 31", plain(sb.visible(600, 10, MONO).get(9)));
    }

    @Test
    void scrollbackCapsLines() {
        Scrollback sb = new Scrollback(10);
        for (int i = 0; i < 25; i++) sb.add(TermLine.of("l" + i, 0));
        assertEquals(10, sb.lineCount());
        assertEquals("l15", sb.lines().get(0).plain());
    }

    static String plain(Scrollback.Row r) {
        StringBuilder sb = new StringBuilder();
        for (TermLine.Seg s : r.segs()) sb.append(s.text());
        return sb.toString();
    }

    // ------------------------------------------------------------ controller

    static final class FakeSender implements TerminalController.Sender {
        final List<String> sent = new ArrayList<>();

        @Override
        public CompletableFuture<TerminalController.Reply> send(String text) {
            sent.add(text);
            return CompletableFuture.completedFuture(new TerminalController.Reply(true, List.of(TermLine.of("reply:" + text, 0))));
        }
    }

    @Test
    void controllerSendsCommandsAndPrintsReplies() {
        FakeSender fs = new FakeSender();
        TerminalController t = new TerminalController(() -> CMDS, () -> BOTS, fs);
        assertEquals("", t.submit("status ash"));
        assertEquals(List.of("status ash"), fs.sent);
        t.drain();
        List<TermLine> lines = t.scrollback().lines();
        assertTrue(lines.get(0).plain().endsWith("status ash"));        // echo with prompt
        assertEquals("reply:status ash", lines.get(lines.size() - 1).plain());
        assertEquals(List.of("status ash"), t.history().entries());
    }

    @Test
    void chatModeWrapsInSay() {
        FakeSender fs = new FakeSender();
        TerminalController t = new TerminalController(() -> CMDS, () -> BOTS, fs);
        t.submit("chat wren");
        assertEquals(TerminalController.Mode.CHAT, t.mode());
        assertEquals("Wren", t.chatTarget());
        t.submit("hi there, build a wall");
        assertEquals("say Wren hi there, build a wall", fs.sent.get(0));
        t.submit("/bots");                 // command from chat mode
        assertEquals("bots", fs.sent.get(1));
        t.submit("/exit");
        assertEquals(TerminalController.Mode.COMMAND, t.mode());
        t.submit("chat all go home now");  // one-shot
        assertEquals("say all go home now", fs.sent.get(2));
        assertEquals(TerminalController.Mode.COMMAND, t.mode());
    }

    @Test
    void localCommandsStayLocal() {
        FakeSender fs = new FakeSender();
        TerminalController t = new TerminalController(() -> CMDS, () -> BOTS, fs);
        boolean[] exited = {false};
        String[] spect = {null};
        t.setOnExit(() -> exited[0] = true);
        t.setOnSpectate(b -> spect[0] = b);
        t.submit("bots");
        t.drain();
        t.submit("clear");
        assertEquals(0, t.scrollback().lineCount());
        t.submit("spectate flint");
        assertEquals("Flint", spect[0]);
        t.submit("exit");
        assertTrue(exited[0]);
        assertEquals(List.of("bots"), fs.sent);
        assertTrue(t.allCommands().contains("clear"));
    }

    @Test
    void bridgeErrorsShowRed() {
        TerminalController t = new TerminalController(() -> CMDS, () -> BOTS,
                text -> CompletableFuture.failedFuture(new java.io.IOException("connection refused")));
        t.submit("bots");
        t.drain();
        TermLine last = t.scrollback().lines().get(t.scrollback().lineCount() - 1);
        assertTrue(last.plain().contains("connection refused"));
        assertEquals(TermLine.RED, last.segs().get(0).argb());
        assertFalse(t.busy());
    }

    @Test
    void noSenderSaysNotConnected() {
        TerminalController t = new TerminalController(() -> CMDS, () -> BOTS, null);
        t.submit("bots");
        assertTrue(t.scrollback().lines().get(1).plain().contains("not connected"));
    }

    @Test
    void chatModeTabCompletesMentionsAndSlashCommands() {
        TerminalController t = new TerminalController(() -> CMDS, () -> BOTS, new FakeSender());
        t.setMode(TerminalController.Mode.CHAT, "all");
        assertEquals("hey @Wren ", t.tab("hey @wr", 7, false).text());
        assertEquals("/status ", t.tab("/stat", 5, false).text());
    }
}
