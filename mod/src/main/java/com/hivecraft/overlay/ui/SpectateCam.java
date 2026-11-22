package com.hivecraft.overlay.ui;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.ui.hud.HudRenderer;
import com.hivecraft.overlay.ui.util.UiMath;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.Perspective;
import net.minecraft.entity.EntityType;
import net.minecraft.entity.decoration.ArmorStandEntity;
import net.minecraft.text.Text;

/**
 * Client-side spectate camera: the view follows a bot from behind and above using the streamed
 * position (no server involvement). Implemented by pointing {@code MinecraftClient.cameraEntity}
 * at an invisible, never-spawned armor stand that we move every tick; the player stays where they
 * are. Same bot again (or {@link #stop()}) returns the view.
 *
 * Note: the world only renders chunks the client has loaded around the PLAYER, so a bot far
 * outside render distance is seen over empty terrain.
 */
public final class SpectateCam {
    private static ArmorStandEntity cam;
    private static String target;
    private static double cx, cy, cz;    // smoothed camera position
    private static double cyaw = Double.NaN;
    private static Perspective savedPerspective;

    private SpectateCam() {}

    public static String target() { return target; }
    public static boolean active() { return target != null; }

    /** Start following {@code bot}; same bot again → stop. */
    public static void toggle(String bot) {
        if (bot == null) { stop(); return; }
        if (bot.equalsIgnoreCase(target == null ? "" : target)) { stop(); return; }
        start(bot);
    }

    public static void start(String bot) {
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc.world == null || mc.player == null) return;
        BotState b = Hive.state().bot(bot);
        if (b == null) {
            mc.player.sendMessage(Text.literal("§6[Hive]§r no bot named " + bot), true);
            return;
        }
        if (!b.dim().equals(HudRenderer.dimName(mc))) {
            mc.player.sendMessage(Text.literal("§6[Hive]§r " + b.name() + " is in the " + b.dim()), true);
            return;
        }
        if (cam == null || cam.getWorld() != mc.world) {
            cam = new ArmorStandEntity(EntityType.ARMOR_STAND, mc.world);
            cam.setInvisible(true);
            cam.setNoGravity(true);
            cam.noClip = true;
        }
        target = b.name();
        long now = System.currentTimeMillis();
        double[] want = desired(b, now, mc.player.getYaw());
        cx = want[0]; cy = want[1]; cz = want[2];
        cyaw = want[3];
        place(want[0], want[1], want[2], (float) want[3], (float) want[4], true);
        if (savedPerspective == null) savedPerspective = mc.options.getPerspective();
        mc.options.setPerspective(Perspective.FIRST_PERSON);
        mc.setCameraEntity(cam);
        Hive.setFocusedBot(target);
        mc.player.sendMessage(Text.literal("§6[Hive]§r watching §e" + target + "§r — press again to return"), true);
    }

    public static void stop() {
        MinecraftClient mc = MinecraftClient.getInstance();
        boolean was = target != null;
        target = null;
        cyaw = Double.NaN;
        if (mc.player != null && mc.getCameraEntity() != mc.player) mc.setCameraEntity(mc.player);
        if (savedPerspective != null) {
            mc.options.setPerspective(savedPerspective);
            savedPerspective = null;
        }
        if (was && mc.player != null) mc.player.sendMessage(Text.literal("§6[Hive]§r camera back"), true);
    }

    /** Client tick: move the camera behind the bot; stop on world change / bot gone / death. */
    public static void tick(MinecraftClient mc) {
        if (target == null) return;
        if (mc.world == null || mc.player == null || cam == null || cam.getWorld() != mc.world || mc.player.isDead()) {
            stop();
            return;
        }
        BotState b = Hive.state().bot(target);
        if (b == null || !b.online() || !b.dim().equals(HudRenderer.dimName(mc))) {
            stop();
            return;
        }
        // something else (another mod, F5 spam) took the camera: give up quietly
        if (mc.getCameraEntity() != cam) {
            target = null;
            savedPerspective = null;
            return;
        }
        long now = System.currentTimeMillis() + 100; // aim slightly ahead: the camera lerps over the next tick
        double[] want = desired(b, now, cyaw);
        double dt = 0.05;
        cx = UiMath.approach(cx, want[0], dt, 5);
        cy = UiMath.approach(cy, want[1], dt, 5);
        cz = UiMath.approach(cz, want[2], dt, 5);
        // look at the bot's head from wherever the smoothed camera is
        double bx = b.lerpX(now), by = b.lerpY(now) + 1.5, bz = b.lerpZ(now);
        double dx = bx - cx, dy = by - cy, dz = bz - cz;
        double hd = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
        float pitch = (float) -Math.toDegrees(Math.atan2(dy, Math.max(0.001, hd)));
        place(cx, cy, cz, yaw, pitch, false);
    }

    /** Desired camera {x,y,z,yaw,pitch}: behind the bot (by its facing; fallback current yaw), raised. */
    private static double[] desired(BotState b, long now, double fallbackYaw) {
        UiConfig cfg = UiConfig.get();
        double yaw = b.yaw() != null ? b.mcYaw() : (Double.isNaN(fallbackYaw) ? 0 : fallbackYaw);
        if (!Double.isNaN(cyaw)) {
            // smooth the orbit angle so bot head-turns don't whip the camera around
            double d = UiMath.wrapDeg(yaw - cyaw);
            yaw = cyaw + d * 0.08;
        }
        cyaw = yaw;
        double rad = Math.toRadians(yaw);
        // MC forward = (-sin(yaw), cos(yaw)); camera sits behind = minus forward
        double fx = -Math.sin(rad), fz = Math.cos(rad);
        double dist = cfg.spectateDistance, up = cfg.spectateHeight;
        double x = b.lerpX(now) - fx * dist, z = b.lerpZ(now) - fz * dist, y = b.lerpY(now) + 1.6 + up;
        return new double[]{x, y, z, yaw, 20};
    }

    private static void place(double x, double y, double z, float yaw, float pitch, boolean snap) {
        // eye position = entity pos + eye height, so subtract it
        double eye = cam.getStandingEyeHeight();
        if (snap) {
            cam.setPos(x, y - eye, z);
            cam.prevX = cam.lastRenderX = x;
            cam.prevY = cam.lastRenderY = y - eye;
            cam.prevZ = cam.lastRenderZ = z;
            cam.setYaw(yaw);
            cam.setPitch(pitch);
            cam.prevYaw = yaw;
            cam.prevPitch = pitch;
            cam.setHeadYaw(yaw);
            return;
        }
        cam.prevX = cam.getX();
        cam.prevY = cam.getY();
        cam.prevZ = cam.getZ();
        cam.lastRenderX = cam.getX();
        cam.lastRenderY = cam.getY();
        cam.lastRenderZ = cam.getZ();
        cam.prevYaw = cam.getYaw();
        cam.prevPitch = cam.getPitch();
        cam.setPos(x, y - eye, z);
        // keep yaw continuous so interpolation doesn't spin the long way round
        float prev = cam.getYaw();
        float cont = prev + (float) UiMath.wrapDeg(yaw - prev);
        cam.setYaw(cont);
        cam.setPitch(pitch);
        cam.setHeadYaw(cont);
    }
}
