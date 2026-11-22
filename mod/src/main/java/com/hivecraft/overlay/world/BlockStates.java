package com.hivecraft.overlay.world;

import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.registry.Registries;
import net.minecraft.state.property.Property;
import net.minecraft.util.Identifier;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Parses bridge block ids + "k=v,k=v" state strings into BlockStates / items, cached. */
public final class BlockStates {
    private BlockStates() {}

    private static final Map<String, ItemStack> ITEMS = new ConcurrentHashMap<>();

    private static Identifier id(String s) {
        if (s == null || s.isEmpty()) return null;
        return Identifier.tryParse(s.indexOf(':') >= 0 ? s : "minecraft:" + s);
    }

    /** block id -> state string -> parsed state (two-level so the per-frame lookup builds no strings). */
    private static final Map<String, Map<String, BlockState>> BY_BLOCK = new ConcurrentHashMap<>();
    private static final BlockState UNKNOWN = Blocks.VOID_AIR.getDefaultState();

    /** BlockState for id+state; null when the block id is unknown. Cached; safe to call per block per frame. */
    public static BlockState parse(String blockId, String state) {
        if (blockId == null) return null;
        String st = state == null ? "" : state;
        Map<String, BlockState> m = BY_BLOCK.get(blockId);
        if (m != null) {
            BlockState c = m.get(st);
            if (c != null) return c == UNKNOWN ? null : c;
        }
        BlockState s = parseUncached(blockId, st);
        if (BY_BLOCK.size() > 2048) BY_BLOCK.clear();
        BY_BLOCK.computeIfAbsent(blockId, k -> new ConcurrentHashMap<>()).put(st, s == null ? UNKNOWN : s);
        return s;
    }

    private static BlockState parseUncached(String blockId, String state) {
        Identifier ident = id(blockId);
        if (ident == null || !Registries.BLOCK.containsId(ident)) return null;
        Block b = Registries.BLOCK.get(ident);
        BlockState s = b.getDefaultState();
        if (!state.isEmpty()) {
            for (String kv : state.split(",")) {
                int eq = kv.indexOf('=');
                if (eq <= 0) continue;
                Property<?> p = b.getStateManager().getProperty(kv.substring(0, eq).trim());
                if (p != null) s = with(s, p, kv.substring(eq + 1).trim());
            }
        }
        return s;
    }

    private static <T extends Comparable<T>> BlockState with(BlockState s, Property<T> p, String v) {
        return p.parse(v).map(val -> s.with(p, val)).orElse(s);
    }

    /** ItemStack for an item (or block) id, EMPTY when unknown. */
    public static ItemStack item(String itemId) {
        if (itemId == null || itemId.isEmpty()) return ItemStack.EMPTY;
        return ITEMS.computeIfAbsent(itemId, k -> {
            Identifier ident = id(k);
            if (ident != null && Registries.ITEM.containsId(ident)) {
                Item it = Registries.ITEM.get(ident);
                if (it != Items.AIR) return new ItemStack(it);
            }
            if (ident != null && Registries.BLOCK.containsId(ident)) {
                Item it = Registries.BLOCK.get(ident).asItem();
                if (it != Items.AIR) return new ItemStack(it);
            }
            return ItemStack.EMPTY;
        });
    }

    /** True when the world block counts as "the same" as the ghost's target (ignores state). */
    public static boolean sameBlock(BlockState world, BlockState target) {
        return world != null && target != null && world.getBlock() == target.getBlock();
    }
}
