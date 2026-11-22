package com.hivecraft.overlay.world;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Dims;
import com.hivecraft.overlay.core.Guard;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveClient;
import com.hivecraft.overlay.core.HiveConfig;
import com.hivecraft.overlay.core.PlayerInfo;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderContext;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.render.RenderLayer;
import net.minecraft.client.render.TexturedRenderLayers;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.util.BufferAllocator;
import net.minecraft.client.util.InputUtil;
import net.minecraft.text.Text;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.SequencedMap;

/** Registers and drives all in-world rendering, the world keybinds and the per-tick player/bot sync. */
public final class WorldOverlay {
    private WorldOverlay() {}

    private static final Frame FRAME = new Frame();
    private static final ActionFx FX = new ActionFx();
    private static VertexConsumerProvider.Immediate immediate;
    private static final List<BufferAllocator> allocators = new ArrayList<>();

    private static KeyBinding kToggleWorld, kCycleBot, kLabels, kTrails, kLedger, kGhosts, kXray;

    public static void init() {
        HiveConfig cfg = Hive.config();
        kToggleWorld = key("toggle_world", cfg);
        kCycleBot = key("cycle_ledger_bot", cfg);
        kLabels = key("toggle_labels", cfg);
        kTrails = key("toggle_trails", cfg);
        kLedger = key("toggle_ledger", cfg);
        kGhosts = key("toggle_ghosts", cfg);
        kXray = key("toggle_xray_labels", cfg);

        Hive.state().addListener(FX);
        WorldRenderEvents.LAST.register(WorldOverlay::render);
        HudRenderCallback.EVENT.register(WorldHud::render);
        ClientTickEvents.END_CLIENT_TICK.register(WorldOverlay::tick);
    }

    private static KeyBinding key(String id, HiveConfig cfg) {
        int code = InputUtil.UNKNOWN_KEY.getCode();
        String def = cfg.keys.get(id);
        if (def != null) {
            try { code = InputUtil.fromTranslationKey(def).getCode(); }
            catch (RuntimeException e) { Guard.get().warn("config", "bad key '" + def + "' for " + id + ", leaving it unbound", null); }
        }
        return KeyBindingHelper.registerKeyBinding(new KeyBinding("key.hivecraft." + id, InputUtil.Type.KEYSYM, code, "key.categories.hivecraft"));
    }

    // -------------------------------------------------------------------- tick

    private static void tick(MinecraftClient mc) {
        try {
            BotIndex.tick(mc);
            handleKeys(mc);
            HiveClient client = Hive.client();
            if (client != null) {
                if (mc.player != null && mc.world != null) {
                    int[] look = null;
                    HitResult hr = mc.crosshairTarget;
                    if (hr instanceof BlockHitResult bhr && hr.getType() == HitResult.Type.BLOCK) {
                        BlockPos p = bhr.getBlockPos();
                        look = new int[]{p.getX(), p.getY(), p.getZ()};
                    }
                    client.updatePlayer(new PlayerInfo(mc.getSession().getUsername(), mc.player.getX(), mc.player.getY(), mc.player.getZ(),
                            Dims.normalize(mc.world.getRegistryKey().getValue().toString()), mc.player.getYaw(), look));
                } else {
                    client.updatePlayer(null);
                }
            }
        } catch (Throwable t) {
            Guard.get().fail("world.tick", t);
        }
    }

    private static void handleKeys(MinecraftClient mc) {
        HiveConfig c = Hive.config();
        boolean changed = false;
        while (kToggleWorld.wasPressed()) { c.worldOverlay = !c.worldOverlay; say(mc, "World overlay " + onOff(c.worldOverlay)); changed = true; }
        while (kLabels.wasPressed()) { c.labels = !c.labels; say(mc, "Bot labels " + onOff(c.labels)); changed = true; }
        while (kTrails.wasPressed()) { c.trails = !c.trails; c.pathLines = c.trails; say(mc, "Trails & paths " + onOff(c.trails)); changed = true; }
        while (kLedger.wasPressed()) { c.ledger = !c.ledger; say(mc, "Block attribution " + onOff(c.ledger)); changed = true; }
        while (kGhosts.wasPressed()) { c.ghosts = !c.ghosts; say(mc, "Ghost builds " + onOff(c.ghosts)); changed = true; }
        while (kXray.wasPressed()) { c.labelsThroughWalls = !c.labelsThroughWalls; say(mc, "Labels through walls " + onOff(c.labelsThroughWalls)); changed = true; }
        while (kCycleBot.wasPressed()) {
            c.ledgerBot = nextBot(c.ledgerBot);
            say(mc, "Block attribution: " + (c.ledgerBot.isEmpty() ? "all bots" : "only " + c.ledgerBot));
            changed = true;
        }
        if (changed) Hive.saveConfig();
    }

    static String nextBot(String current) {
        List<String> names = new ArrayList<>();
        for (BotState b : Hive.state().bots()) names.add(b.name());
        return HiveConfig.cycleBot(names, current);
    }

    private static String onOff(boolean b) { return b ? "§aON" : "§cOFF"; }

    private static void say(MinecraftClient mc, String s) {
        if (mc.player != null) mc.player.sendMessage(Text.literal("§6Hivecraft§r · " + s), true);
    }

    // ------------------------------------------------------------------ render

    private static VertexConsumerProvider.Immediate immediate() {
        if (immediate == null) {
            SequencedMap<RenderLayer, BufferAllocator> fixed = new LinkedHashMap<>();
            // draw order: textured ghosts, fills, lines, then the see-through layers on top
            fixed.put(TexturedRenderLayers.getEntityTranslucentCull(), alloc(1 << 20));
            fixed.put(HiveLayers.QUADS, alloc(1 << 19));
            fixed.put(HiveLayers.LINES, alloc(1 << 19));
            fixed.put(HiveLayers.LINES_THICK, alloc(1 << 15));
            fixed.put(HiveLayers.QUADS_XRAY, alloc(1 << 16));
            fixed.put(HiveLayers.LINES_XRAY, alloc(1 << 16));
            immediate = VertexConsumerProvider.immediate(fixed, alloc(1 << 18));
        }
        return immediate;
    }

    private static void render(WorldRenderContext ctx) {
        HiveConfig cfg = Hive.config();
        if (!cfg.worldOverlay || Guard.get().isDisabled("world.draw")) return;
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc.world == null || mc.player == null) return;
        Frame f = FRAME;
        f.mc = mc;
        f.world = mc.world;
        f.camera = ctx.camera();
        f.frustum = ctx.frustum();
        f.cx = f.camera.getPos().x; f.cy = f.camera.getPos().y; f.cz = f.camera.getPos().z;
        f.tickDelta = ctx.tickCounter().getTickDelta(false);
        f.now = System.currentTimeMillis();
        f.dim = Dims.normalize(mc.world.getRegistryKey().getValue().toString());
        f.cfg = cfg;
        f.st = Hive.state();
        f.vcp = immediate();
        f.focused = Hive.focusedBot();
        // model-view already holds the camera rotation at LAST; our stack only offsets to camera-relative
        while (!f.ms.isEmpty()) f.ms.pop();
        f.ms.loadIdentity();
        // each layer is contained: a failing layer is logged, auto-disabled after repeated errors, and never stops the others
        if (cfg.ghosts) layer("world.ghosts", f, GhostRenderer::render);
        layer("world.ledger", f, LedgerRenderer::render); // ledger blocks only when cfg.ledger; UI highlights always
        if (cfg.waypoints) layer("world.waypoints", f, WaypointRenderer::render);
        layer("world.bots", f, BotRenderer::render);
        if (cfg.actionFx) layer("world.fx", f, FX::render);
        try {
            f.vcp.draw();
        } catch (Throwable t) {
            // a layer left a half-written vertex or GL state broke: drop the buffers and start clean next frame
            Guard.get().fail("world.draw", t);
            resetBuffers();
        }
        while (!f.ms.isEmpty()) f.ms.pop();
    }

    private static void layer(String name, Frame f, java.util.function.Consumer<Frame> body) {
        Guard.get().run(name, () -> body.accept(f));
        while (!f.ms.isEmpty()) f.ms.pop(); // a throw mid-billboard must not shift the next layer
    }

    private static void resetBuffers() {
        immediate = null;
        for (BufferAllocator a : allocators) {
            try { a.close(); } catch (Throwable t) { Guard.get().warn("world.draw", "freeing buffer failed: " + t, null); }
        }
        allocators.clear();
    }

    private static BufferAllocator alloc(int size) {
        BufferAllocator a = new BufferAllocator(size);
        allocators.add(a);
        return a;
    }
}
