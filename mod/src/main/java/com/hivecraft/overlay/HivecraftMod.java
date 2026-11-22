package com.hivecraft.overlay;

import com.hivecraft.overlay.core.Guard;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.world.WorldOverlay;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;

/**
 * Client entrypoint: config + core state + bridge connection, then world rendering, then HiveUI (HUD/screens/terminal).
 */
public class HivecraftMod implements ClientModInitializer {
    public static final Logger LOGGER = LoggerFactory.getLogger("Hivecraft");

    @Override
    public void onInitializeClient() {
        Guard.get().setSink((msg, t) -> { if (t != null) LOGGER.warn(msg, t); else LOGGER.warn(msg); });
        Path cfg = FabricLoader.getInstance().getConfigDir().resolve("hivecraft.json");
        String version = FabricLoader.getInstance().getModContainer(Hive.MOD_ID)
                .map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("dev");
        Hive.init(cfg, version, LOGGER::info);

        Guard.get().run("init.world", WorldOverlay::init);
        Guard.get().run("init.ui", HivecraftMod::initUi);

        Hive.client().start();
        ClientLifecycleEvents.CLIENT_STOPPING.register(c -> Hive.client().stop());
        LOGGER.info("Hivecraft Overlay {} ready; bridge {}", version, Hive.config().wsUrl());
    }

    /** Calls com.hivecraft.overlay.ui.HiveUI.init() (owned by the UI module) if present. */
    private static void initUi() {
        try {
            Class<?> c = Class.forName("com.hivecraft.overlay.ui.HiveUI");
            c.getMethod("init").invoke(null);
        } catch (ClassNotFoundException e) {
            LOGGER.warn("HiveUI not found; HUD/screens disabled");
        } catch (ReflectiveOperationException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            Guard.get().fail("init.ui", cause);
        }
    }
}
