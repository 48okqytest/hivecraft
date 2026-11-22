package com.hivecraft.overlay.world;

import com.hivecraft.overlay.core.HiveConfig;
import com.hivecraft.overlay.core.HiveState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.render.Camera;
import net.minecraft.client.render.Frustum;
import net.minecraft.client.render.LightmapTextureManager;
import net.minecraft.client.render.VertexConsumer;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.client.world.ClientWorld;
import net.minecraft.item.ItemStack;
import net.minecraft.client.render.model.json.ModelTransformationMode;
import net.minecraft.client.render.OverlayTexture;
import net.minecraft.util.math.Box;
import org.joml.Matrix4f;

/** Per-frame render context shared by the world renderers. Positions passed to helpers are world coordinates. */
public final class Frame {
    public static final int FULL_BRIGHT = LightmapTextureManager.MAX_LIGHT_COORDINATE;

    public MinecraftClient mc;
    public ClientWorld world;
    public Camera camera;
    public Frustum frustum;
    public double cx, cy, cz;
    public float tickDelta;
    public long now;
    public String dim;
    public HiveConfig cfg;
    public HiveState st;
    public final MatrixStack ms = new MatrixStack();
    public VertexConsumerProvider.Immediate vcp;
    public String focused;

    public float rx(double x) { return (float) (x - cx); }
    public float ry(double y) { return (float) (y - cy); }
    public float rz(double z) { return (float) (z - cz); }

    public double dist(double x, double y, double z) {
        double dx = x - cx, dy = y - cy, dz = z - cz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    public double distSq(double x, double y, double z) {
        double dx = x - cx, dy = y - cy, dz = z - cz;
        return dx * dx + dy * dy + dz * dz;
    }

    /** Camera-relative identity matrix (vanilla's model-view already holds the camera rotation at LAST). */
    public Matrix4f m() { return ms.peek().getPositionMatrix(); }
    public MatrixStack.Entry e() { return ms.peek(); }

    public VertexConsumer quads(boolean xray) { return vcp.getBuffer(xray ? HiveLayers.QUADS_XRAY : HiveLayers.QUADS); }
    public VertexConsumer lines(boolean xray) { return vcp.getBuffer(xray ? HiveLayers.LINES_XRAY : HiveLayers.LINES); }
    public VertexConsumer thickLines() { return vcp.getBuffer(HiveLayers.LINES_THICK); }

    public boolean visible(double x1, double y1, double z1, double x2, double y2, double z2) {
        return frustum == null || frustum.isVisible(new Box(x1, y1, z1, x2, y2, z2));
    }

    public TextRenderer font() { return mc.textRenderer; }

    /**
     * Pushes a camera-facing billboard at a world position; text units = pixels at {@code scale} blocks per pixel
     * (vanilla nametags use 0.025). Must be balanced with {@code ms.pop()}.
     */
    public void pushBillboard(double x, double y, double z, float scale) {
        ms.push();
        ms.translate(x - cx, y - cy, z - cz);
        ms.multiply(camera.getRotation());
        ms.scale(scale, -scale, scale);
    }

    /** Text centred at (0,y) in billboard space; skips when alpha is too low (the font treats ~0 alpha as opaque). */
    public void text(String s, float y, int rgb, float a, boolean xray, int bgArgb) {
        if (a < 0.04f || s == null || s.isEmpty()) return;
        TextRenderer tr = font();
        float x = -tr.getWidth(s) / 2f;
        Matrix4f m = m();
        int col = com.hivecraft.overlay.core.Fade.argb(rgb, a);
        if (xray) {
            tr.draw(s, x, y, com.hivecraft.overlay.core.Fade.argb(rgb, a * 0.5f), false, m, vcp, TextRenderer.TextLayerType.SEE_THROUGH, bgArgb, FULL_BRIGHT);
            tr.draw(s, x, y, col, false, m, vcp, TextRenderer.TextLayerType.NORMAL, 0, FULL_BRIGHT);
        } else {
            tr.draw(s, x, y, col, false, m, vcp, TextRenderer.TextLayerType.NORMAL, bgArgb, FULL_BRIGHT);
        }
    }

    /** Text with left edge at x (billboard space). */
    public void textAt(String s, float x, float y, int rgb, float a, boolean xray) {
        if (a < 0.04f || s == null || s.isEmpty()) return;
        TextRenderer tr = font();
        Matrix4f m = m();
        if (xray) tr.draw(s, x, y, com.hivecraft.overlay.core.Fade.argb(rgb, a * 0.5f), false, m, vcp, TextRenderer.TextLayerType.SEE_THROUGH, 0, FULL_BRIGHT);
        tr.draw(s, x, y, com.hivecraft.overlay.core.Fade.argb(rgb, a), false, m, vcp, TextRenderer.TextLayerType.NORMAL, 0, FULL_BRIGHT);
    }

    /** Draws an item icon at billboard (x,y) pixel position, size px. */
    public void item(ItemStack stack, float x, float y, float sizePx) {
        if (stack == null || stack.isEmpty()) return;
        ms.push();
        ms.translate(x, y, -0.5f);
        // billboard space has y flipped; items are rendered in block units centred on the origin
        ms.scale(sizePx, -sizePx, 0.001f * sizePx);
        mc.getItemRenderer().renderItem(stack, ModelTransformationMode.GUI, FULL_BRIGHT, OverlayTexture.DEFAULT_UV, ms, vcp, world, 0);
        ms.pop();
    }
}
