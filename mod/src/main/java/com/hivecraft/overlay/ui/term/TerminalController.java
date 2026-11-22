package com.hivecraft.overlay.ui.term;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Everything the terminal does except drawing: input submit, local commands, chat mode, history,
 * completion, and the async round trip to the bridge ({@code POST /mod/command}). Results come back
 * on another thread and are queued; {@link #drain()} moves them into the scrollback on the render
 * thread. Kept free of Minecraft classes so it can be unit tested with a fake sender.
 */
public final class TerminalController {

    /** Sends one command line to the bridge; completes with the output lines (or exceptionally). */
    @FunctionalInterface
    public interface Sender {
        CompletableFuture<Reply> send(String text);
    }

    /** A bridge reply: {@code ok} + coloured lines. */
    public record Reply(boolean ok, List<TermLine> lines) {}

    public enum Mode { COMMAND, CHAT }

    public static final List<String> LOCAL_COMMANDS = List.of("clear", "chat", "history", "exit", "spectate");

    private final Scrollback scrollback = new Scrollback(2000);
    private final CommandHistory history = new CommandHistory(200);
    private final TabCompleter completer;
    private final Supplier<Collection<String>> serverCommands;
    private final Supplier<Collection<String>> botNames;
    private final ConcurrentLinkedQueue<TermLine> inbox = new ConcurrentLinkedQueue<>();
    private Sender sender;
    private Runnable onExit = () -> {};
    private Consumer<String> onSpectate = b -> {};

    private Mode mode = Mode.COMMAND;
    private String chatTarget = "all";
    private final AtomicInteger pending = new AtomicInteger();
    private boolean greeted = false;

    public TerminalController(Supplier<Collection<String>> serverCommands, Supplier<Collection<String>> botNames, Sender sender) {
        this.serverCommands = serverCommands;
        this.botNames = botNames;
        this.sender = sender;
        this.completer = new TabCompleter(this::allCommands, botNames);
    }

    public void setSender(Sender s) { this.sender = s; }
    public void setOnExit(Runnable r) { this.onExit = r == null ? () -> {} : r; }
    public void setOnSpectate(Consumer<String> c) { this.onSpectate = c == null ? b -> {} : c; }

    public Scrollback scrollback() { return scrollback; }
    public CommandHistory history() { return history; }
    public TabCompleter completer() { return completer; }
    public Mode mode() { return mode; }
    public String chatTarget() { return chatTarget; }
    public boolean busy() { return pending.get() > 0; }

    public List<String> allCommands() {
        List<String> l = new ArrayList<>();
        Collection<String> sc = serverCommands.get();
        if (sc != null) l.addAll(sc);
        for (String c : LOCAL_COMMANDS) if (!containsIgnoreCase(l, c)) l.add(c);
        return l;
    }

    /** Prompt user name: the local player's name, lowercase, letters/digits/_ only ("player" if unknown). */
    static String promptName() {
        String n = com.hivecraft.overlay.core.EconState.who().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9_]", "");
        return n.isEmpty() ? "player" : n;
    }

    /** The prompt drawn before the input. */
    public String prompt() {
        return mode == Mode.CHAT ? "say@" + chatTarget + " > " : promptName() + "@hive:~$ ";
    }

    /** Banner printed the first time the terminal opens. */
    public void greetOnce(String version) {
        if (greeted) return;
        greeted = true;
        print(TermLine.of(TermLine.seg("HIVECRAFT ", TermLine.AMBER), TermLine.seg("overlay terminal " + version, TermLine.DIM)));
        print(TermLine.of("type 'help' for commands  ·  Tab completes  ·  ↑/↓ history  ·  'chat' talks to the team  ·  Esc closes", TermLine.DIM));
    }

    /** Thread-safe: queue output from any thread (network callbacks, chat feed). */
    public void post(TermLine line) {
        inbox.add(line);
    }

    /** Render thread: move queued output into the scrollback. Returns true if anything arrived. */
    public boolean drain() {
        boolean any = false;
        TermLine l;
        while ((l = inbox.poll()) != null) {
            scrollback.add(l);
            any = true;
        }
        return any;
    }

    private void print(TermLine l) {
        scrollback.add(l);
    }

    public void toggleChatMode() {
        setMode(mode == Mode.CHAT ? Mode.COMMAND : Mode.CHAT, chatTarget);
    }

    public void setMode(Mode m, String target) {
        mode = m;
        if (target != null && !target.isBlank()) chatTarget = target;
        if (m == Mode.CHAT) {
            print(TermLine.of("chat mode: lines go to " + chatTarget + " as you. '/cmd' runs a command, '/exit' or Ctrl+T leaves.", TermLine.CYAN));
        } else {
            print(TermLine.of("command mode", TermLine.CYAN));
        }
    }

    /**
     * Submit one input line. Returns the text the input box should hold afterwards (normally "").
     */
    public String submit(String raw) {
        String line = raw == null ? "" : raw.strip();
        completer.reset();
        if (line.isEmpty()) {
            print(TermLine.of(prompt(), TermLine.DIM));
            history.resetCursor();
            return "";
        }
        history.add(line);
        scrollback.scrollToBottom();

        if (mode == Mode.CHAT && !line.startsWith("/")) {
            echo(line);
            send("say " + chatTarget + " " + line, true);
            return "";
        }
        String cmdLine = mode == Mode.CHAT ? line.substring(1).strip() : line;
        if (mode == Mode.CHAT && (cmdLine.equals("exit") || cmdLine.isEmpty())) {
            echo(line);
            setMode(Mode.COMMAND, null);
            return "";
        }
        echo(line);
        runCommand(cmdLine);
        return "";
    }

    private void echo(String line) {
        print(TermLine.of(TermLine.seg(prompt(), mode == Mode.CHAT ? TermLine.CYAN : TermLine.GREEN), TermLine.seg(line, TermLine.WHITE)));
    }

    /** Runs a command line (local or remote). Also used by clickable segments. */
    public void runCommand(String cmdLine) {
        List<String> words = TabCompleter.splitWords(cmdLine);
        if (words.isEmpty()) return;
        String cmd = words.get(0).toLowerCase(Locale.ROOT);
        switch (cmd) {
            case "clear", "cls" -> scrollback.clear();
            case "exit", "quit" -> onExit.run();
            case "history" -> {
                List<String> h = history.entries();
                int from = Math.max(0, h.size() - 30);
                for (int i = from; i < h.size(); i++) print(TermLine.of(String.format("%4d  %s", i + 1, h.get(i)), TermLine.DIM));
            }
            case "chat" -> {
                String target = words.size() > 1 ? canonicalBot(words.get(1)) : chatTarget;
                if (words.size() > 2) { // one-shot: chat Ash hello there
                    send("say " + target + " " + cmdLine.strip().split("\\s+", 3)[2], true);
                } else {
                    setMode(Mode.CHAT, target);
                }
            }
            case "spectate" -> {
                if (words.size() < 2) print(TermLine.of("usage: spectate <bot>   (again to return)", TermLine.YELLOW));
                else {
                    onSpectate.accept(canonicalBot(words.get(1)));
                    print(TermLine.of("camera → " + canonicalBot(words.get(1)) + "  (press the same again, or Esc in-game key, to return)", TermLine.CYAN));
                }
            }
            case "help" -> {
                send(cmdLine, false);
                if (words.size() == 1) print(TermLine.of("local: clear · history · chat [bot|all] · spectate <bot> · exit", TermLine.DIM));
            }
            default -> send(cmdLine, false);
        }
    }

    private void send(String text, boolean quietOk) {
        Sender s = sender;
        if (s == null) {
            print(TermLine.of("not connected to the bridge (127.0.0.1:47960)", TermLine.RED));
            return;
        }
        pending.incrementAndGet();
        CompletableFuture<Reply> f;
        try {
            f = s.send(text);
        } catch (RuntimeException e) {
            pending.decrementAndGet();
            print(TermLine.of("send failed: " + e.getMessage(), TermLine.RED));
            return;
        }
        f.whenComplete((reply, err) -> {
            pending.updateAndGet(v -> Math.max(0, v - 1));
            if (err != null) {
                Throwable c = err.getCause() != null ? err.getCause() : err;
                post(TermLine.of("✖ bridge: " + (c.getMessage() == null ? c.getClass().getSimpleName() : c.getMessage()), TermLine.RED));
                return;
            }
            if (reply == null) return;
            if (reply.lines() == null || reply.lines().isEmpty()) {
                if (!quietOk || !reply.ok()) post(TermLine.of(reply.ok() ? "ok" : "failed", reply.ok() ? TermLine.DIM : TermLine.RED));
                return;
            }
            for (TermLine l : reply.lines()) post(l);
        });
    }

    /** Matches a typed bot name to the real case ("ash" → "Ash"); unknown names pass through. */
    public String canonicalBot(String typed) {
        if (typed.equalsIgnoreCase("all")) return "all";
        Collection<String> bots = botNames.get();
        if (bots != null) for (String b : bots) if (b.equalsIgnoreCase(typed)) return b;
        return typed;
    }

    /** Tab key. */
    public TabCompleter.Result tab(String text, int cursor, boolean reverse) {
        // in chat mode only "/command" lines complete commands; plain chat completes bot names (@mentions)
        if (mode == Mode.CHAT) {
            if (text.startsWith("/")) {
                TabCompleter.Result r = completer.complete(text.substring(1), Math.max(0, cursor - 1), reverse);
                return new TabCompleter.Result("/" + r.text(), r.cursor() + 1, r.candidates(), r.changed());
            }
            return completeMention(text, cursor);
        }
        return completer.complete(text, cursor, reverse);
    }

    private TabCompleter.Result completeMention(String text, int cursor) {
        String before = text.substring(0, cursor);
        int s = before.lastIndexOf(' ') + 1;
        String tok = before.substring(s);
        String prefix = tok.startsWith("@") ? tok.substring(1) : tok;
        List<String> names = new ArrayList<>(botNames.get() == null ? List.of() : botNames.get());
        List<String> m = TabCompleter.filter(names, prefix);
        if (m.size() != 1) return new TabCompleter.Result(text, cursor, m, false);
        String rep = (tok.startsWith("@") ? "@" : "") + m.get(0) + " ";
        String out = before.substring(0, s) + rep;
        return new TabCompleter.Result(out + text.substring(cursor), out.length(), m, true);
    }

    /** Up arrow. */
    public String historyUp(String current) { return history.up(current); }

    /** Down arrow. */
    public String historyDown(String current) { return history.down(current); }

    /** Any non-Tab edit. */
    public void edited() {
        completer.reset();
    }

    private static boolean containsIgnoreCase(Collection<String> c, String s) {
        for (String x : c) if (x.equalsIgnoreCase(s)) return true;
        return false;
    }
}
