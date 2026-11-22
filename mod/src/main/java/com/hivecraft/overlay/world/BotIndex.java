package com.hivecraft.overlay.world;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveConfig;
import net.minecraft.client.MinecraftClient;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerEntity;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Maps bot names to their loaded player entities and colours. Rebuilt on the client thread each tick;
 * read by the mixins (outline glow) and renderers.
 */
public final class BotIndex {
    private BotIndex() {}

    private static volatile Map<String, Integer> colors = Map.of();
    private static volatile Map<String, PlayerEntity> entities = Map.of();
    private static volatile boolean glow;

    static String key(String name) { return name.toLowerCase(Locale.ROOT); }

    /** Client thread, END_CLIENT_TICK. */
    public static void tick(MinecraftClient mc) {
        HiveConfig cfg = Hive.config();
        Map<String, Integer> c = new HashMap<>();
        for (BotState b : Hive.state().bots()) c.put(key(b.name()), b.color());
        colors = c;
        glow = cfg.worldOverlay && cfg.outlines;
        Map<String, PlayerEntity> e = new HashMap<>();
        if (mc.world != null && !c.isEmpty()) {
            for (PlayerEntity p : mc.world.getPlayers()) {
                String k = key(p.getGameProfile().getName());
                if (c.containsKey(k)) e.put(k, p);
            }
        }
        entities = e;
    }

    /** The loaded entity of a bot, or null when it is out of range. */
    public static PlayerEntity entity(String botName) { return botName == null ? null : entities.get(key(botName)); }

    /** Bot colour for an entity (0xRRGGBB) or -1 when it isn't a bot. */
    public static int colorOf(Entity e) {
        if (!(e instanceof PlayerEntity p)) return -1;
        Integer c = colors.get(key(p.getGameProfile().getName()));
        return c == null ? -1 : c;
    }

    /** True when the outline glow should be forced on for this entity. */
    public static boolean glows(Entity e) { return glow && colorOf(e) >= 0; }
}
