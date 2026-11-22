package com.hivecraft.overlay.screen.econ;

import com.hivecraft.overlay.core.EconText;
import net.minecraft.client.MinecraftClient;
import net.minecraft.component.DataComponentTypes;
import net.minecraft.entity.player.PlayerInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.Identifier;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The player's inventory summed per item id (what the bridge's RCON clear can take). Client thread only. */
public final class Inv {
    private Inv() {}

    /** {@code risky} = some stack has enchantments / damage / a custom name (lost when sold). */
    public record Entry(String id, int count, boolean risky) {}

    private static long cachedAt;
    private static List<Entry> cached = List.of();

    public static String idOf(ItemStack st) {
        Identifier id = Registries.ITEM.getId(st.getItem());
        return "minecraft".equals(id.getNamespace()) ? id.getPath() : id.toString();
    }

    /** Items in main inventory + hotbar + offhand + armor, in inventory order (hotbar first). Cached for 250 ms. */
    public static List<Entry> items() {
        long now = System.currentTimeMillis();
        if (now - cachedAt < 250) return cached;
        cachedAt = now;
        MinecraftClient mc = MinecraftClient.getInstance();
        if (mc.player == null) return cached = List.of();
        PlayerInventory inv = mc.player.getInventory();
        Map<String, int[]> sum = new LinkedHashMap<>();
        List<ItemStack> all = new ArrayList<>(inv.main);
        all.addAll(inv.offHand);
        all.addAll(inv.armor);
        for (ItemStack st : all) {
            if (st == null || st.isEmpty()) continue;
            String id = idOf(st);
            int[] a = sum.computeIfAbsent(id, k -> new int[2]);
            a[0] += st.getCount();
            if (st.hasEnchantments() || st.isDamaged() || st.contains(DataComponentTypes.CUSTOM_NAME)) a[1] = 1;
        }
        List<Entry> out = new ArrayList<>();
        for (var e : sum.entrySet()) out.add(new Entry(e.getKey(), e.getValue()[0], e.getValue()[1] != 0));
        return cached = List.copyOf(out);
    }

    /** How many of {@code item} the player carries. */
    public static int count(String item) {
        String n = EconText.normItem(item);
        for (Entry e : items()) if (e.id().equals(n)) return e.count();
        return 0;
    }

    public static boolean risky(String item) {
        String n = EconText.normItem(item);
        for (Entry e : items()) if (e.id().equals(n)) return e.risky();
        return false;
    }

    /** Forget the cache (after a sale/list, so the next frame re-reads). */
    public static void invalidate() { cachedAt = 0; }
}
