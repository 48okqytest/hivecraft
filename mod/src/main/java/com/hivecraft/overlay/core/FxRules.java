package com.hivecraft.overlay.core;

/** Which icon pops above a bot for an action / ledger event (item ids, no namespace). */
public final class FxRules {
    private FxRules() {}

    public enum Kind { PLACE, BREAK, CRAFT, ATTACK, SMELT, EAT, OTHER }

    /** Icon + kind for a bot action name (from BotState.actionName()), or null when it deserves no pop. */
    public static Fx forAction(String action) {
        if (action == null) return null;
        String a = action.toLowerCase(java.util.Locale.ROOT);
        if (a.startsWith("craft")) return new Fx(Kind.CRAFT, "crafting_table");
        if (a.equals("attack") || a.equals("hunt") || a.equals("defend") || a.equals("fight")) return new Fx(Kind.ATTACK, "iron_sword");
        if (a.startsWith("smelt") || a.equals("cook")) return new Fx(Kind.SMELT, "furnace");
        if (a.equals("eat")) return new Fx(Kind.EAT, "bread");
        if (a.equals("sleep")) return new Fx(Kind.OTHER, "red_bed");
        if (a.startsWith("chest")) return new Fx(Kind.OTHER, "chest");
        if (a.equals("fish")) return new Fx(Kind.OTHER, "fishing_rod");
        if (a.equals("photo") || a.equals("take_photo")) return new Fx(Kind.OTHER, "spyglass");
        return null;
    }

    /** Icon for a ledger event: the placed block, or the broken block (pickaxe fallback for unknown items). */
    public static Fx forLedger(LedgerEvent e) {
        if (e == null) return null;
        String b = e.block() == null ? "" : e.block();
        if (b.startsWith("minecraft:")) b = b.substring(10);
        if (e.isPlace()) return new Fx(Kind.PLACE, b.isEmpty() ? "cobblestone" : itemFor(b));
        return new Fx(Kind.BREAK, b.isEmpty() || b.endsWith("air") ? "iron_pickaxe" : itemFor(b));
    }

    /** Block ids whose item has another name. */
    public static String itemFor(String block) {
        return switch (block) {
            case "wall_torch" -> "torch";
            case "redstone_wall_torch" -> "redstone_torch";
            case "soul_wall_torch" -> "soul_torch";
            case "redstone_wire" -> "redstone";
            case "water", "bubble_column" -> "water_bucket";
            case "lava" -> "lava_bucket";
            case "fire" -> "flint_and_steel";
            case "farmland", "dirt_path" -> "dirt";
            case "wheat" -> "wheat_seeds";
            case "carrots" -> "carrot";
            case "potatoes" -> "potato";
            case "beetroots" -> "beetroot_seeds";
            case "tripwire" -> "string";
            case "cave_vines", "cave_vines_plant" -> "glow_berries";
            default -> block.endsWith("_wall_sign") ? block.replace("_wall_sign", "_sign") : block;
        };
    }

    public record Fx(Kind kind, String item) {}
}
