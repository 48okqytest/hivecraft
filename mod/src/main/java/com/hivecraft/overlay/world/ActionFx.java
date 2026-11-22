package com.hivecraft.overlay.world;

import com.hivecraft.overlay.core.BotState;
import com.hivecraft.overlay.core.Fade;
import com.hivecraft.overlay.core.FxRules;
import com.hivecraft.overlay.core.Hive;
import com.hivecraft.overlay.core.HiveListener;
import com.hivecraft.overlay.core.LedgerEvent;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * Small icon pops above a bot when it mines / places / crafts / attacks. Fed from ledger events and bot action
 * changes (network thread), drawn on the render thread.
 */
public final class ActionFx implements HiveListener {
    public static final long LIFE_MS = 1300;
    public static final int MAX = 48;
    /** At most one pop per bot per this many ms (bots place fast during builds). */
    public static final long PER_BOT_GAP_MS = 220;

    private record Pop(String bot, FxRules.Fx fx, long start, double ox, double oz) {}

    private final ConcurrentLinkedQueue<Pop> incoming = new ConcurrentLinkedQueue<>();
    private final List<Pop> live = new ArrayList<>();
    private final java.util.Map<String, Long> lastByBot = new java.util.concurrent.ConcurrentHashMap<>();

    private void push(String bot, FxRules.Fx fx) {
        if (fx == null || bot == null) return;
        long now = System.currentTimeMillis();
        Long last = lastByBot.get(bot);
        if (last != null && now - last < PER_BOT_GAP_MS) return;
        lastByBot.put(bot, now);
        double ang = Math.random() * Math.PI * 2;
        incoming.add(new Pop(bot, fx, now, Math.cos(ang) * 0.25, Math.sin(ang) * 0.25));
    }

    @Override public void onLedger(List<LedgerEvent> added) {
        if (!Hive.config().actionFx) return;
        for (LedgerEvent e : added) push(e.bot(), FxRules.forLedger(e));
    }

    @Override public void onBotAction(BotState bot, String previousAction) {
        if (!Hive.config().actionFx) return;
        push(bot.name(), FxRules.forAction(bot.actionName()));
    }

    public void render(Frame f) {
        Pop p;
        while ((p = incoming.poll()) != null) live.add(p);
        while (live.size() > MAX) live.remove(0);
        long now = System.currentTimeMillis();
        for (Iterator<Pop> it = live.iterator(); it.hasNext(); ) {
            Pop pop = it.next();
            double t = (now - pop.start()) / (double) LIFE_MS;
            if (t >= 1) { it.remove(); continue; }
            BotState b = f.st.bot(pop.bot());
            if (b == null || !f.dim.equals(b.dim())) continue;
            Vec3d pos = BotRenderer.renderPos(f, b);
            double d = f.dist(pos.x, pos.y, pos.z);
            if (d > 64) continue;
            float env = Fade.popEnvelope(t);
            double rise = 1.0 + 0.9 * t;
            // icons sit beside the head, under the label stack
            f.pushBillboard(pos.x + pop.ox(), pos.y + rise, pos.z + pop.oz(), 0.025f * (float) Math.max(1, d / 14));
            try {
                float size = 14 * (0.6f + 0.4f * env);
                f.item(BlockStates.item(pop.fx().item()), 0, 0, size);
                String glyph = switch (pop.fx().kind()) {
                    case PLACE -> "+";
                    case BREAK -> "-";
                    case CRAFT -> "⚒";
                    case ATTACK -> "⚔";
                    default -> "";
                };
                if (!glyph.isEmpty()) f.textAt(glyph, 6, -10, b.color(), env, false);
            } finally {
                f.ms.pop();
            }
        }
    }
}
