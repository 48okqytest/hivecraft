package com.hivecraft.overlay.ui;

import com.google.gson.JsonObject;
import com.hivecraft.overlay.core.BotEvent;
import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.ChatLine;
import com.hivecraft.overlay.core.CommandResult;
import com.hivecraft.overlay.core.Goal;
import com.hivecraft.overlay.core.Guard;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveClient;
import com.hivecraft.overlay.core.HiveListener;
import com.hivecraft.overlay.core.HiveState;
import com.hivecraft.overlay.core.LedgerEvent;
import com.hivecraft.overlay.core.Photo;
import com.hivecraft.overlay.core.TaskInfo;
import com.hivecraft.overlay.screen.ControlScreen;
import com.hivecraft.overlay.screen.EconomyScreen;
import com.hivecraft.overlay.core.Econ;
import com.hivecraft.overlay.ui.hud.EconChip;
import com.hivecraft.overlay.screen.TerminalScreen;
import com.hivecraft.overlay.ui.hud.HudRenderer;
import com.hivecraft.overlay.ui.hud.Ticker;
import com.hivecraft.overlay.ui.term.TermLine;
import com.hivecraft.overlay.ui.term.TerminalController;
import com.hivecraft.overlay.ui.util.UiMath;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.text.Text;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * UI entry point, called reflectively by the mod entrypoint after core/world are up. Registers the
 * HUD, keys and the client tick, and wires the bridge feeds into the ticker and terminal.
 */
public final class HiveUI {
    private static Keys keys;
    private static TerminalController terminal;
    private static Ticker ticker;
    private static HudRenderer hud;
    private static String version = "?";

    private HiveUI() {}

    public static Keys keys() { return keys; }
    public static TerminalController terminal() { return terminal; }
    public static Ticker ticker() { return ticker; }
    public static HudRenderer hud() { return hud; }
    public static String version() { return version; }

    public static void init() {
        version = FabricLoader.getInstance().getModContainer(Hive.MOD_ID)
                .map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");
        keys = new Keys();
        ticker = new Ticker(14, UiConfig.get().tickerSeconds * 1000L);
        hud = new HudRenderer(ticker);
        terminal = new TerminalController(
                () -> Hive.state().commands(),
                HiveUI::botNames,
                HiveUI::sendCommand);
        terminal.history().setAll(UiConfig.get().history);
        terminal.setOnExit(() -> {
            MinecraftClient mc = MinecraftClient.getInstance();
            if (mc.currentScreen instanceof TerminalScreen ts) ts.close();
        });
        terminal.setOnSpectate(bot -> MinecraftClient.getInstance().execute(() -> SpectateCam.toggle(bot)));

        Hive.setUiDrawsStatus(true);
        Hive.state().addListener(new Feed());

        HudRenderCallback.EVENT.register((ctx, tick) -> Guard.get().run("hud", () -> hud.render(ctx, tick)));
        // economy: coin chip by the team panel, notices into the ticker, snapshot loader
        HudRenderCallback.EVENT.register((ctx, tick) -> Guard.get().run("hud.econ", () -> EconChip.render(ctx, hud)));
        Hive.state().econ().addListener(n -> EconChip.onNotice(n, ticker));
        Econ.install();
        ClientTickEvents.END_CLIENT_TICK.register(mc -> Guard.get().run("ui.tick", () -> tick(mc)));
        // NOTE: never call getBoundKeyLocalizedText() here: it calls glfwGetKeyName before GLFW is
        // initialised (client entrypoints run before the window exists) and crashes the game.
        Hive.log("UI ready: terminal [" + keys.terminal.getBoundKeyTranslationKey() + "], control ["
                + keys.control.getBoundKeyTranslationKey() + "]");
    }

    /** Saves the terminal history into the config (called when the terminal closes). */
    public static void saveHistory() {
        UiConfig cfg = UiConfig.get();
        List<String> h = terminal.history().entries();
        cfg.history = new ArrayList<>(h.subList(Math.max(0, h.size() - 100), h.size()));
        cfg.save();
    }

    static List<String> botNames() {
        List<String> l = new ArrayList<>();
        for (BotState b : Hive.state().bots()) l.add(b.name());
        return l;
    }

    /** Terminal → bridge. HiveClient.sendCommand never fails exceptionally. */
    static CompletableFuture<TerminalController.Reply> sendCommand(String text) {
        HiveClient c = Hive.client();
        if (c == null) return CompletableFuture.failedFuture(new IllegalStateException("Hivecraft client not started"));
        return c.sendCommand(text).thenApply(HiveUI::toReply);
    }

    public static TerminalController.Reply toReply(CommandResult r) {
        List<TermLine> out = new ArrayList<>();
        int def = r.ok() ? TermLine.WHITE : TermLine.RED;
        for (List<CommandResult.Segment> line : r.lines()) {
            List<TermLine.Seg> segs = new ArrayList<>();
            for (CommandResult.Segment s : line) {
                int col = s.color() < 0 ? def : 0xFF000000 | s.color();
                segs.add(new TermLine.Seg(s.text(), col, s.bold(), s.italic(), s.click()));
            }
            out.add(new TermLine(segs, System.currentTimeMillis()));
        }
        return new TerminalController.Reply(r.ok(), out);
    }

    // ------------------------------------------------------------------ tick

    private static void tick(MinecraftClient mc) {
        SpectateCam.tick(mc);
        terminal.drain();
        if (mc.player == null) {
            // drain presses so they don't fire when the world loads
            while (keys.terminal.wasPressed()) {}
            while (keys.control.wasPressed()) {}
            while (keys.economy.wasPressed()) {}
            return;
        }
        while (keys.terminal.wasPressed()) {
            if (mc.currentScreen == null) mc.setScreen(new TerminalScreen(terminal));
        }
        while (keys.control.wasPressed()) {
            if (mc.currentScreen == null) mc.setScreen(new ControlScreen());
        }
        while (keys.economy.wasPressed()) {
            if (mc.currentScreen == null) mc.setScreen(new EconomyScreen());
        }
        while (keys.toggleHud.wasPressed()) {
            UiConfig cfg = UiConfig.get();
            cfg.hud = !cfg.hud;
            cfg.save();
            actionBar("HUD " + (cfg.hud ? "§aon" : "§7off"));
        }
        while (keys.cycleFocus.wasPressed()) cycleFocus();
        while (keys.spectate.wasPressed()) {
            String f = Hive.focusedBot();
            if (SpectateCam.active()) SpectateCam.stop();
            else if (f != null) SpectateCam.start(f);
            else if (!Hive.state().bots().isEmpty()) SpectateCam.start(Hive.state().bots().get(0).name());
        }
        // focus on a bot that left the team → clear
        String f = Hive.focusedBot();
        if (f != null && Hive.state().bot(f) == null && Hive.state().online() && !Hive.state().bots().isEmpty()) Hive.setFocusedBot(null);
    }

    /** none → first → … → last → none. */
    public static void cycleFocus() {
        List<BotState> bots = Hive.state().bots();
        if (bots.isEmpty()) {
            actionBar("no bots");
            return;
        }
        String cur = Hive.focusedBot();
        int idx = -1;
        for (int i = 0; i < bots.size(); i++) if (bots.get(i).name().equalsIgnoreCase(cur == null ? "" : cur)) idx = i;
        String next = idx + 1 < bots.size() ? bots.get(idx + 1).name() : null;
        Hive.setFocusedBot(next);
        if (next == null) actionBar("focus: none");
        else {
            BotState b = bots.get(idx + 1);
            actionBar("focus: §l" + next + "§r · " + b.actionText());
        }
    }

    public static void actionBar(String msg) {
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc.player != null) mc.player.sendMessage(Text.literal("§6[Hive]§r " + msg), true);
    }

    static int botColor(String name) {
        BotState b = name == null ? null : Hive.state().bot(name);
        return b != null ? b.color() & 0xFFFFFF : 0xFFC24A;
    }

    // ------------------------------------------------------------------ feeds (network thread)

    /** Turns bridge messages into ticker entries and terminal lines. Never touches MC objects. */
    private static final class Feed implements HiveListener {
        private final Map<Integer, String> taskStatus = new ConcurrentHashMap<>();
        private final SimpleDateFormat hhmm = new SimpleDateFormat("HH:mm");
        private volatile HiveState.Connection lastConn = HiveState.Connection.OFFLINE;

        @Override
        public void onMessage(String type, JsonObject msg) {
            if ("init".equals(type)) {
                taskStatus.clear();
                for (TaskInfo t : Hive.state().board()) taskStatus.put(t.id(), t.status());
            }
        }

        @Override
        public void onChat(ChatLine c) {
            UiConfig cfg = UiConfig.get();
            long now = System.currentTimeMillis();
            int col = c.color() & 0xFFFFFF;
            String to = c.to() == null || c.to().equals("all") ? "" : " → " + c.to();
            if (cfg.tickerChat && !EconChip.coversChat(c.from())) {
                List<TermLine.Seg> segs = List.of(
                        TermLine.seg(c.from() + to, 0xFF000000 | col),
                        TermLine.seg(": " + UiMath.ellipsize(c.text(), 64), 0xFFDADFE8));
                ticker.push(Ticker.Kind.CHAT, col, null, now, segs);
            }
            if (cfg.terminalShowsChat) {
                String time;
                synchronized (hhmm) { time = hhmm.format(new Date(c.ts() > 0 ? c.ts() : now)); }
                terminal.post(TermLine.of(
                        TermLine.seg(time + " ", 0xFF4A5A50),
                        TermLine.seg("<" + c.from() + (to.isEmpty() ? "" : to) + "> ", 0xFF000000 | col),
                        TermLine.seg(c.text(), 0xFFB9C4BC)));
            }
        }

        @Override
        public void onLedger(List<LedgerEvent> added) {
            if (!UiConfig.get().tickerBlocks) return;
            long now = System.currentTimeMillis();
            for (LedgerEvent e : added) {
                // pathfinder digging and scaffolding are noise in the ticker
                String cause = e.cause() == null ? "" : e.cause();
                if (cause.startsWith("pathfinder") || cause.equals("scaffold")) continue;
                if (e.phase() != null && (e.phase().equals("scaffold") || e.phase().equals("unscaffold"))) continue;
                ticker.blocks(e.bot(), botColor(e.bot()), e.isPlace() ? "placed" : "broke", e.block(), 1, now);
            }
        }

        @Override
        public void onTask(TaskInfo t, boolean deleted) {
            String prev = deleted ? taskStatus.remove(t.id()) : taskStatus.put(t.id(), t.status());
            if (deleted || !UiConfig.get().tickerTasks) return;
            if (t.status() != null && t.status().equals(prev)) return;
            long now = System.currentTimeMillis();
            String title = UiMath.ellipsize(t.title(), 48);
            String owner = t.owner() == null || t.owner().isBlank() ? null : t.owner();
            switch (t.status() == null ? "" : t.status()) {
                case "done" -> ticker.push(Ticker.Kind.TASK, 0x4CE06A, null, now, List.of(
                        TermLine.seg("✔ ", 0xFF4CE06A),
                        TermLine.seg(owner != null ? owner : "task", owner != null ? 0xFF000000 | botColor(owner) : 0xFFB8BEC8),
                        TermLine.seg(" finished ", 0xFFB8BEC8),
                        TermLine.seg(title, 0xFFFFFFFF)));
                case "claimed" -> {
                    if (owner == null) return;
                    ticker.push(Ticker.Kind.TASK, botColor(owner), null, now, List.of(
                            TermLine.seg(owner, 0xFF000000 | botColor(owner)),
                            TermLine.seg(" took ▸ ", 0xFFB8BEC8),
                            TermLine.seg(title, 0xFFE8D7A8)));
                }
                case "blocked" -> ticker.push(Ticker.Kind.TASK, 0xFFB13B, null, now, List.of(
                        TermLine.seg("⚠ blocked: ", 0xFFFFB13B), TermLine.seg(title, 0xFFFFFFFF)));
                default -> {
                    if (prev == null) ticker.push(Ticker.Kind.TASK, 0xFFC24A, null, now, List.of(
                            TermLine.seg("+ new task ", 0xFFFFC24A),
                            TermLine.seg(title, 0xFFFFFFFF),
                            TermLine.seg(t.by() == null || t.by().isBlank() ? "" : " (" + t.by() + ")", 0xFF8A93A3)));
                }
            }
        }

        @Override
        public void onEvent(BotEvent e) {
            if (!UiConfig.get().tickerEvents) return;
            long now = System.currentTimeMillis();
            String kind = e.kind() == null ? "" : e.kind();
            int col = botColor(e.bot());
            switch (kind) {
                case "hurt" -> { /* too frequent for the ticker */ }
                case "death" -> {
                    ticker.push(Ticker.Kind.DEATH, 0xFF4545, null, now, List.of(
                            TermLine.seg("☠ ", 0xFFFF4545), TermLine.seg(e.bot(), 0xFF000000 | col),
                            TermLine.seg(" died", 0xFFFF8080)));
                    terminal.post(TermLine.of("☠ " + e.bot() + ": " + UiMath.ellipsize(e.text(), 120), TermLine.RED));
                }
                case "respawn" -> ticker.push(Ticker.Kind.EVENT, col, null, now, List.of(
                        TermLine.seg(e.bot(), 0xFF000000 | col), TermLine.seg(" respawned", 0xFFB8BEC8)));
                case "joined" -> ticker.push(Ticker.Kind.EVENT, 0x4CE06A, null, now, List.of(
                        TermLine.seg("+ ", 0xFF4CE06A), TermLine.seg(e.bot(), 0xFF000000 | col), TermLine.seg(" joined", 0xFFB8BEC8)));
                case "kicked", "disconnected", "left" -> ticker.push(Ticker.Kind.EVENT, 0x9099A8, null, now, List.of(
                        TermLine.seg("− ", 0xFF9099A8), TermLine.seg(e.bot(), 0xFF000000 | col), TermLine.seg(" " + kind, 0xFF9099A8)));
                default -> ticker.push(Ticker.Kind.EVENT, col, null, now, List.of(
                        TermLine.seg(e.bot(), 0xFF000000 | col),
                        TermLine.seg(" " + UiMath.ellipsize(e.text() == null || e.text().isBlank() ? kind.replace('_', ' ') : e.text(), 56), 0xFFB8BEC8)));
            }
        }

        @Override
        public void onGoal(Goal g) {
            if (g == null || g.text() == null || g.text().isBlank()) return;
            ticker.push(Ticker.Kind.GOAL, 0xFFC24A, null, System.currentTimeMillis(), List.of(
                    TermLine.seg("★ new goal: ", 0xFFFFC24A), TermLine.seg(UiMath.ellipsize(g.text(), 60), 0xFFFFFFFF)));
            terminal.post(TermLine.of("★ goal: " + g.text() + (g.by() == null ? "" : "  (" + g.by() + ")"), TermLine.AMBER));
        }

        @Override
        public void onPhoto(Photo p) {
            ticker.push(Ticker.Kind.PHOTO, botColor(p.agent()), "spyglass", System.currentTimeMillis(), List.of(
                    TermLine.seg(p.agent(), 0xFF000000 | botColor(p.agent())),
                    TermLine.seg(" took a photo", 0xFFB8BEC8),
                    TermLine.seg(p.caption() == null || p.caption().isBlank() ? "" : ": " + UiMath.ellipsize(p.caption(), 40), 0xFFFFFFFF)));
        }

        @Override
        public void onConnection(HiveState.Connection status) {
            long now = System.currentTimeMillis();
            HiveState.Connection prev = lastConn;
            lastConn = status;
            if (status == prev) return;
            if (status == HiveState.Connection.ONLINE) {
                ticker.push(Ticker.Kind.SYSTEM, 0x4CE06A, null, now, List.of(TermLine.seg("● connected to the hive", 0xFF4CE06A)));
                terminal.post(TermLine.of("● connected to bridge", TermLine.GREEN));
            } else if (status == HiveState.Connection.OFFLINE && prev == HiveState.Connection.ONLINE) {
                terminal.post(TermLine.of("○ bridge connection lost — retrying", TermLine.DIM));
            }
        }
    }
}
