package com.hivecraft.overlay.world;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Dims;
import com.hivecraft.overlay.core.Fade;
import com.hivecraft.overlay.core.Guard;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveClient;
import com.hivecraft.overlay.core.HiveConfig;
import com.hivecraft.overlay.core.HiveState;
import com.hivecraft.overlay.core.LedgerCache;
import com.hivecraft.overlay.core.LedgerEvent;
import com.hivecraft.overlay.core.LedgerText;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.TextRenderer;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.render.RenderTickCounter;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;

/** Screen-space bits owned by the world module: the crosshair block tooltip and the fallback offline indicator. */
public final class WorldHud {
    private WorldHud() {}

    public static void render(DrawContext ctx, RenderTickCounter tick) {
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc.options.hudHidden || mc.world == null) return;
        HiveConfig cfg = Hive.config();
        Guard g = Guard.get();
        if (!Hive.uiDrawsStatus()) g.run("hud.status", () -> offline(ctx, mc));
        g.run("hud.disabled", () -> disabledNotes(ctx, mc));
        if (cfg.worldOverlay && cfg.ledgerTooltip && mc.currentScreen == null) g.run("hud.tooltip", () -> tooltip(ctx, mc));
    }

    /** "Hivecraft: world.ghosts disabled (error, see log)" for each layer the Guard switched off. */
    private static void disabledNotes(DrawContext ctx, MinecraftClient mc) {
        java.util.List<String> off = Guard.get().disabledLayers();
        if (off.isEmpty()) return;
        TextRenderer tr = mc.textRenderer;
        int y = Hive.uiDrawsStatus() ? 20 : (Hive.state().online() ? 6 : 20);
        for (String l : off) {
            String s = "Hivecraft: " + l + " disabled (error, see log)";
            int w = tr.getWidth(s);
            int x = ctx.getScaledWindowWidth() - w - 6;
            ctx.fill(x - 3, y - 2, x + w + 3, y + 10, 0x90000000);
            ctx.drawTextWithShadow(tr, s, x, y, 0xFFFF8A65);
            y += 12;
        }
    }

    private static void offline(DrawContext ctx, MinecraftClient mc) {
        HiveState st = Hive.state();
        if (st.online()) return;
        String s = st.connection() == HiveState.Connection.CONNECTING ? "Hivecraft: connecting…" : "Hivecraft: offline";
        TextRenderer tr = mc.textRenderer;
        int w = tr.getWidth(s);
        int x = ctx.getScaledWindowWidth() - w - 6, y = 6;
        ctx.fill(x - 3, y - 2, x + w + 3, y + 10, 0x90000000);
        ctx.drawTextWithShadow(tr, s, x, y, st.connection() == HiveState.Connection.CONNECTING ? 0xFFFFD54F : 0xFFFF6B6B);
    }

    private static void tooltip(DrawContext ctx, MinecraftClient mc) {
        HitResult hr = mc.crosshairTarget;
        if (!(hr instanceof BlockHitResult bhr) || hr.getType() != HitResult.Type.BLOCK) return;
        BlockPos p = bhr.getBlockPos();
        String dim = Dims.normalize(mc.world.getRegistryKey().getValue().toString());
        HiveClient client = Hive.client();
        LedgerEvent last = null;
        int changes = 0;
        if (client != null) {
            LedgerCache.AtResult at = client.ledgerAt(p.getX(), p.getY(), p.getZ(), dim);
            if (at != null) { last = at.last(); changes = at.history().size(); }
        }
        if (last == null) last = Hive.state().ledger().latestAt(p.getX(), p.getY(), p.getZ(), dim);
        if (last == null) return;
        long now = System.currentTimeMillis();
        String head = LedgerText.headline(last, now);
        String detail = LedgerText.detail(last);
        String hist = LedgerText.historySummary(changes);
        if (!hist.isEmpty()) detail += " · " + hist;
        BotState b = Hive.state().bot(last.bot());
        int col = b != null ? b.color() : 0xFFFFFF;

        TextRenderer tr = mc.textRenderer;
        int cx = ctx.getScaledWindowWidth() / 2, y = ctx.getScaledWindowHeight() / 2 + 12;
        int w = Math.max(tr.getWidth(head), tr.getWidth(detail)) + 10;
        int x = cx - w / 2;
        ctx.fill(x, y, x + w, y + 24, 0xB0101014);
        ctx.fill(x, y, x + 2, y + 24, 0xFF000000 | col);
        ctx.drawTextWithShadow(tr, head, x + 6, y + 3, 0xFF000000 | Fade.lighten(col, 0.25f));
        ctx.drawTextWithShadow(tr, detail, x + 6, y + 13, 0xFFBBBBBB);
    }
}
