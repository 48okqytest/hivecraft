package com.hivecraft.overlay.world;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Fade;
import com.hivecraft.overlay.core.Ghost;
import com.hivecraft.overlay.core.GhostBlock;
import net.minecraft.block.BlockRenderType;
import net.minecraft.block.BlockState;
import net.minecraft.client.render.OverlayTexture;
import net.minecraft.client.render.TexturedRenderLayers;
import net.minecraft.client.render.VertexConsumer;
import net.minecraft.client.render.block.BlockRenderManager;
import net.minecraft.client.render.model.BakedModel;
import net.minecraft.util.math.BlockPos;
import org.joml.Matrix4f;

import java.util.Locale;

/**
 * Ghost builds: blueprint previews and running builds drawn as translucent real-textured block models.
 * Remaining cells = textured ghost; the current layer pulses with an outline; done cells faint; conflicts red.
 */
public final class GhostRenderer {
    private GhostRenderer() {}

    public static final int MAX_TEXTURED = 6000;
    private static final int CYAN = 0x4DD0E1, RED = 0xFF3B30, GREEN = 0x66BB6A;
    private static final AlphaConsumer ALPHA = new AlphaConsumer();

    public static void render(Frame f) {
        int budget = MAX_TEXTURED;
        double t = (f.now % 100000L) / 1000.0;
        float pulse = (float) (0.5 + 0.5 * Math.sin(t * 5));
        BlockRenderManager brm = f.mc.getBlockRenderManager();
        BlockPos.Mutable pos = new BlockPos.Mutable();
        double maxD = f.cfg.ghostMaxDistance;

        for (Ghost g : f.st.ghosts()) {
            if (!f.dim.equals(g.dim())) continue;
            if (g.finished() && g.remaining() == 0 && !g.isPreview()) {
                label(f, g, pulse);
                continue;
            }
            if (!f.visible(g.minX(), g.minY(), g.minZ(), g.maxX() + 1, g.maxY() + 1, g.maxZ() + 1)) continue;
            double gcx = (g.minX() + g.maxX() + 1) / 2.0, gcy = (g.minY() + g.maxY() + 1) / 2.0, gcz = (g.minZ() + g.maxZ() + 1) / 2.0;
            if (f.dist(gcx, gcy, gcz) > maxD + Math.max(g.maxX() - g.minX(), g.maxZ() - g.minZ())) continue;
            int col = botColor(f, g);

            // the lowest y still missing blocks = the layer being built now
            int buildY = Integer.MAX_VALUE;
            for (GhostBlock b : g.blocks()) if (!b.placed() && !b.conflict() && b.y() < buildY) buildY = b.y();

            Matrix4f m = f.m();
            VertexConsumer q = f.quads(false);
            VertexConsumer ln = f.lines(false);
            VertexConsumer tex = f.vcp.getBuffer(TexturedRenderLayers.getEntityTranslucentCull());
            for (GhostBlock b : g.blocks()) {
                double d = f.dist(b.x() + 0.5, b.y() + 0.5, b.z() + 0.5);
                if (d > maxD) continue;
                float da = Fade.distance(d, maxD, 0.8);
                float x = f.rx(b.x()), y = f.ry(b.y()), z = f.rz(b.z());
                pos.set(b.x(), b.y(), b.z());
                BlockState target = BlockStates.parse(b.block(), b.state());
                BlockState world = f.world.getBlockState(pos);
                boolean present = BlockStates.sameBlock(world, target);

                if (g.isPreview()) {
                    String tint = b.tint() == null ? "ok" : b.tint().toLowerCase(Locale.ROOT);
                    if ("conflict".equals(tint)) {
                        Draw.box(q, m, x - 0.003f, y - 0.003f, z - 0.003f, x + 1.003f, y + 1.003f, z + 1.003f, RED, (0.25f + 0.15f * pulse) * da);
                        Draw.outline(ln, f.e(), x, y, z, x + 1, y + 1, z + 1, RED, 0.9f * da);
                    } else if ("done".equals(tint) || present) {
                        Draw.outline(ln, f.e(), x + 0.02f, y + 0.02f, z + 0.02f, x + 0.98f, y + 0.98f, z + 0.98f, GREEN, 0.35f * da);
                    } else {
                        if (budget-- > 0) model(f, brm, tex, target, b, f.cfg.ghostAlpha * da, 0.75f, 0.95f, 1.0f);
                        Draw.outline(ln, f.e(), x + 0.01f, y + 0.01f, z + 0.01f, x + 0.99f, y + 0.99f, z + 0.99f, CYAN, 0.35f * da);
                    }
                    continue;
                }

                if (b.placed() || present) {
                    if (f.cfg.ghostShowDone && d < 48)
                        Draw.outline(ln, f.e(), x - 0.002f, y - 0.002f, z - 0.002f, x + 1.002f, y + 1.002f, z + 1.002f, col, 0.12f * da);
                    continue;
                }
                boolean blocked = !world.isAir() && !world.isReplaceable() && world.getFluidState().isEmpty();
                if (blocked) {
                    Draw.box(q, m, x - 0.004f, y - 0.004f, z - 0.004f, x + 1.004f, y + 1.004f, z + 1.004f, RED, (0.2f + 0.2f * pulse) * da);
                    Draw.outline(ln, f.e(), x - 0.004f, y - 0.004f, z - 0.004f, x + 1.004f, y + 1.004f, z + 1.004f, RED, 0.85f * da);
                    continue;
                }
                if (target != null && budget-- > 0) model(f, brm, tex, target, b, f.cfg.ghostAlpha * da, 1f, 1f, 1f);
                if (b.y() == buildY) {
                    Draw.outline(ln, f.e(), x + 0.01f, y + 0.01f, z + 0.01f, x + 0.99f, y + 0.99f, z + 0.99f,
                            Fade.lighten(col, 0.3f * pulse), (0.45f + 0.45f * pulse) * da);
                }
            }
            label(f, g, pulse);
        }
    }

    private static int botColor(Frame f, Ghost g) {
        if (g.bot() != null) {
            BotState b = f.st.bot(g.bot());
            if (b != null) return b.color();
        }
        return g.isPreview() ? CYAN : 0xFFD54F;
    }

    /** Draws the real block model, shrunk a hair to avoid z-fighting, with alpha. */
    private static void model(Frame f, BlockRenderManager brm, VertexConsumer tex, BlockState s, GhostBlock b, float alpha,
                              float tr, float tg, float tb) {
        if (s == null || alpha <= 0.02f) return;
        if (s.getRenderType() != BlockRenderType.MODEL) {
            // chests, signs... have no baked model: tinted box instead
            float x = f.rx(b.x()), y = f.ry(b.y()), z = f.rz(b.z());
            Draw.box(f.quads(false), f.m(), x + 0.06f, y, z + 0.06f, x + 0.94f, y + 0.88f, z + 0.94f, 0xC8A165, alpha * 0.8f);
            return;
        }
        BakedModel model = brm.getModel(s);
        int tint = tintOf(f, s, b);
        float r = 1, g = 1, bl = 1;
        if (tint != -1) { r = ((tint >> 16) & 255) / 255f; g = ((tint >> 8) & 255) / 255f; bl = (tint & 255) / 255f; }
        f.ms.push();
        f.ms.translate(f.rx(b.x() + 0.5), f.ry(b.y() + 0.5), f.rz(b.z() + 0.5));
        f.ms.scale(0.996f, 0.996f, 0.996f);
        f.ms.translate(-0.5f, -0.5f, -0.5f);
        ALPHA.set(tex, alpha).tint(tr, tg, tb);
        brm.getModelRenderer().render(f.ms.peek(), ALPHA, s, model, r, g, bl, Frame.FULL_BRIGHT, OverlayTexture.DEFAULT_UV);
        f.ms.pop();
    }

    /** Biome/block tint (grass, leaves, water) cached per state for a few seconds; -1 = none. */
    private static final java.util.Map<BlockState, Integer> TINTS = new java.util.IdentityHashMap<>();
    private static long tintsAt;

    private static int tintOf(Frame f, BlockState s, GhostBlock b) {
        if (f.now - tintsAt > 5000) { TINTS.clear(); tintsAt = f.now; }
        Integer c = TINTS.get(s);
        if (c != null) return c;
        int tint = -1;
        try { tint = f.mc.getBlockColors().getColor(s, f.world, new BlockPos(b.x(), b.y(), b.z()), 0); }
        catch (RuntimeException e) { com.hivecraft.overlay.core.Guard.get().warn("world.ghosts", "block colour for " + b.block() + " failed: " + e, e); }
        TINTS.put(s, tint);
        return tint;
    }

    /** Floating "house · 38%" + progress bar above the build. */
    private static void label(Frame f, Ghost g, float pulse) {
        double cx = (g.minX() + g.maxX() + 1) / 2.0, cz = (g.minZ() + g.maxZ() + 1) / 2.0, top = g.maxY() + 2.2;
        double d = f.dist(cx, top, cz);
        float a = Fade.distance(d, Math.max(96, f.cfg.ghostMaxDistance * 1.5), 0.7);
        if (a <= 0.03f) return;
        int col = botColor(f, g);
        f.pushBillboard(cx, top, cz, 0.025f * (float) Math.max(1.2, Math.min(d / 9, 10)));
        try {
            String name = g.blueprint() == null || g.blueprint().isEmpty() ? g.id() : g.blueprint();
            String head;
            if (g.isPreview()) head = "PREVIEW " + name;
            else if (g.finished()) head = name + " · done ✔";
            else head = name + " · " + g.progress() + "%";
            String sub = g.isPreview()
                    ? (g.expires() > 0 ? "expires in " + Math.max(0, (g.expires() - f.now) / 60000) + "m" : "planned")
                    : g.done() + "/" + g.total() + (g.bots().isEmpty() ? "" : " · " + String.join(", ", g.bots()));
            int bg = Fade.argb(0, 0.45f * a);
            f.text(head, -22, g.isPreview() ? CYAN : col, a, true, bg);
            f.text(sub, -11, 0xDDDDDD, a * 0.9f, true, bg);
            if (!g.isPreview()) {
                Matrix4f m = f.m();
                VertexConsumer q = f.quads(true);
                Draw.rect(q, m, -41, -1, 41, 4, 0.01f, 0x101010, 0.65f * a);
                Draw.rect(q, m, -40, 0, -40 + 80 * Fade.clamp01(g.progress() / 100.0), 3, 0f, Fade.lighten(col, 0.15f * pulse), 0.95f * a);
            }
        } finally {
            f.ms.pop();
        }
    }
}
