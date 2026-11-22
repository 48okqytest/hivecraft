package com.hivecraft.overlay.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Economy formatting / parsing helpers (pure, unit-tested). */
public final class EconText {
    private EconText() {}

    /** "minecraft:Oak Log" → "oak_log". */
    public static String normItem(String id) {
        if (id == null) return "";
        String s = id.trim().toLowerCase(Locale.ROOT).replace(' ', '_');
        if (s.startsWith("minecraft:")) s = s.substring(10);
        return s;
    }

    /** "oak_log" → "Oak Log". */
    public static String pretty(String id) {
        String s = normItem(id);
        int c = s.indexOf(':');
        if (c >= 0) s = s.substring(c + 1);
        StringBuilder sb = new StringBuilder();
        for (String w : s.split("_")) {
            if (w.isEmpty()) continue;
            if (sb.length() > 0) sb.append(' ');
            sb.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
        }
        return sb.toString();
    }

    public static boolean same(String a, String b) { return a != null && b != null && a.equalsIgnoreCase(b); }

    /** 1234567 → "1,234,567". */
    public static String coins(long n) {
        return String.format(Locale.ROOT, "%,d", n);
    }

    /** Short form for tight spots: 999 · 1.2k · 12k · 1.5M. */
    public static String coinsShort(long n) {
        long a = Math.abs(n);
        String sign = n < 0 ? "-" : "";
        if (a < 10_000) return sign + coins(a);
        if (a < 100_000) return sign + trim1(a / 1000.0) + "k";
        if (a < 1_000_000) return sign + (a / 1000) + "k";
        return sign + trim1(a / 1_000_000.0) + "M";
    }

    private static String trim1(double v) {
        String s = String.format(Locale.ROOT, "%.1f", Math.floor(v * 10) / 10);
        return s.endsWith(".0") ? s.substring(0, s.length() - 2) : s;
    }

    /** "+20" / "-6" / "0". */
    public static String signed(long n) { return (n > 0 ? "+" : n < 0 ? "-" : "") + coins(Math.abs(n)); }

    /** Auction countdown: "ended", "0:07", "4:59", "1:02:03". */
    public static String countdown(long msLeft) {
        if (msLeft <= 0) return "ended";
        long s = (msLeft + 999) / 1000;
        long h = s / 3600, m = (s % 3600) / 60, sec = s % 60;
        if (h > 0) return String.format(Locale.ROOT, "%d:%02d:%02d", h, m, sec);
        return String.format(Locale.ROOT, "%d:%02d", m, sec);
    }

    /** Bridge rule: start with no bids, else bid + max(1, ceil(bid × 5%)). */
    public static int minNextBid(Integer bid, int start) {
        if (bid == null) return start;
        return bid + Math.max(1, (int) Math.ceil(bid * 0.05));
    }

    /**
     * Parses what a player typed as an amount: "64", "1,000", "1_000", "2k", " 15 ". Returns null when it is
     * not a positive whole number (≤ 1,000,000,000).
     */
    public static Long parseAmount(String s) {
        if (s == null) return null;
        String t = s.trim().toLowerCase(Locale.ROOT).replace(",", "").replace("_", "");
        if (t.isEmpty()) return null;
        long mul = 1;
        if (t.endsWith("k")) { mul = 1000; t = t.substring(0, t.length() - 1); }
        else if (t.endsWith("m")) { mul = 1_000_000; t = t.substring(0, t.length() - 1); }
        if (t.isEmpty() || t.length() > 10) return null;
        try {
            if (t.contains(".")) {
                if (mul == 1) return null;
                double d = Double.parseDouble(t) * mul;
                if (d != Math.floor(d) || d <= 0 || d > 1e9) return null;
                return (long) d;
            }
            for (int i = 0; i < t.length(); i++) if (!Character.isDigit(t.charAt(i))) return null;
            long v = Long.parseLong(t) * mul;
            return v > 0 && v <= 1_000_000_000L ? v : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** Count phrase: "10 Oak Log", "Diamond" for 1. */
    public static String countItem(int count, String item) {
        String p = pretty(item);
        return count > 1 ? count + " " + p : p;
    }

    /** One line for the Wallet's transaction list, from {@code me}'s point of view. */
    public static String describe(EconState.Tx t, String me) {
        boolean out = same(t.from(), me);
        String other = out ? t.to() : t.from();
        String what = t.item() != null && !t.item().isEmpty() ? countItem(Math.max(1, t.count()), t.item()) : null;
        return switch (t.kind()) {
            case "start" -> "Starting coins";
            case "pay" -> out ? "Paid " + other + (t.note() != null && !t.note().isBlank() ? " · " + t.note() : "")
                    : other + " paid you" + (t.note() != null && !t.note().isBlank() ? " · " + t.note() : "");
            case "shop_buy" -> "Bought " + nz(what) + " from the shop";
            case "shop_sell" -> "Sold " + nz(what) + " to the shop";
            case "market_buy" -> out ? "Bought " + nz(what) + " from " + other : other + " bought " + nz(what);
            case "list" -> "Listed " + nz(what) + " on the market";
            case "unlist" -> "Took back " + nz(what);
            case "auction_create" -> "Put " + nz(what) + " up for auction";
            case "bid_hold" -> "Bid held" + (what != null ? " on " + what : "");
            case "bid_refund" -> "Bid refunded" + (what != null ? " · " + what : "");
            case "auction_sale" -> out ? "Won auction: " + nz(what) : "Auction sold: " + nz(what);
            case "auction_unsold" -> "Auction unsold: " + nz(what) + " returned";
            case "auction_cancel" -> "Auction cancelled: " + nz(what);
            case "deliver" -> "Delivered " + nz(what);
            case "job_pay" -> "Server job: delivered " + nz(what);
            case "mob_bounty" -> "Mob bounty" + (t.note() != null && !t.note().isBlank() ? " · " + t.note() : "");
            case "milestone" -> "Milestone" + (t.note() != null && !t.note().isBlank() ? " · " + t.note() : "");
            case "world_first" -> "World-first bonus" + (t.note() != null && !t.note().isBlank() ? " · " + EarnText.trimNote(t.note()) : "");
            case "wage" -> "Daily wage" + (t.note() != null && !t.note().isBlank() ? " · " + t.note() : "");
            case "bounty_hold" -> "Bounty held" + (t.note() != null && !t.note().isBlank() ? " · " + EarnText.trimNote(t.note()) : "");
            case "bounty_paid" -> out ? "Bounty paid to " + other : "Bounty reward" + (t.note() != null && !t.note().isBlank() ? " · " + t.note() : "");
            case "bounty_refund" -> "Bounty refunded" + (t.note() != null && !t.note().isBlank() ? " · " + EarnText.trimNote(t.note()) : "");
            default -> pretty(t.kind()) + (what != null ? " · " + what : "");
        };
    }

    private static String nz(String s) { return s == null ? "items" : s; }

    /** Ticker notice for a new transaction involving {@code me}, or null when it isn't worth one. */
    public static EconState.Notice noticeFor(EconState.Tx t, String me, long now) {
        boolean out = same(t.from(), me), in = same(t.to(), me);
        if (!out && !in) return null;
        String what = t.item() != null && !t.item().isEmpty() ? countItem(Math.max(1, t.count()), t.item()) : "";
        long a = t.amount();
        return switch (t.kind()) {
            case "shop_buy" -> out ? n(EconState.Notice.Kind.BOUGHT, "Bought " + what, t.item(), -a, "Server", now) : null;
            case "shop_sell" -> in ? n(EconState.Notice.Kind.SOLD, "Sold " + what + " to the shop", t.item(), a, "Server", now) : null;
            case "market_buy" -> out ? n(EconState.Notice.Kind.BOUGHT, "Bought " + what + " from " + t.to(), t.item(), -a, t.to(), now)
                    : n(EconState.Notice.Kind.SOLD, t.from() + " bought " + what, t.item(), a, t.from(), now);
            case "pay" -> out ? n(EconState.Notice.Kind.PAID, "Paid " + t.to(), null, -a, t.to(), now)
                    : n(EconState.Notice.Kind.RECEIVED, t.from() + " paid you", null, a, t.from(), now);
            case "deliver" -> in ? n(EconState.Notice.Kind.DELIVERED, "Delivered " + what, t.item(), 0, null, now) : null;
            case "bounty_refund" -> in ? n(EconState.Notice.Kind.BOUNTY_REFUND, "Bounty refunded"
                    + (t.note() != null && !t.note().isBlank() ? " · " + EarnText.trimNote(t.note()) : ""), "writable_book", a, null, now) : null;
            // earnings (job_pay, mob_bounty, milestone, wage, bounty_paid) come from the {kind:"earn"} events
            default -> null; // auctions are announced from the auction updates (outbid / won / sold)
        };
    }

    /** Notices from an auction change: outbid, won, your auction sold / ended unsold. */
    public static List<EconState.Notice> auctionNotices(EconState.Auction prev, EconState.Auction a, String me, boolean endedMsg, long now) {
        List<EconState.Notice> out = new ArrayList<>();
        String what = countItem(a.count(), a.item());
        if (prev != null && same(prev.bidder(), me) && !same(a.bidder(), me) && a.bidder() != null)
            out.add(n(EconState.Notice.Kind.OUTBID, "Outbid on " + what + " by " + a.bidder() + " · now " + coins(a.price()), a.item(), 0, a.bidder(), now));
        boolean justEnded = a.ended() && (prev == null || !prev.ended());
        if (justEnded || (endedMsg && prev == null)) {
            if (same(a.winner(), me) || ("sold".equals(a.status()) && a.winner() == null && same(a.bidder(), me)))
                out.add(n(EconState.Notice.Kind.WON, "Won the auction: " + what, a.item(), -a.price(), a.seller(), now));
            else if (same(a.seller(), me)) {
                if ("sold".equals(a.status()))
                    out.add(n(EconState.Notice.Kind.AUCTION_SOLD, "Auction sold: " + what + (a.winner() != null ? " to " + a.winner() : ""),
                            a.item(), a.price(), a.winner(), now));
                else if ("unsold".equals(a.status()))
                    out.add(n(EconState.Notice.Kind.AUCTION_UNSOLD, "Auction ended unsold: " + what + " returned", a.item(), 0, null, now));
            }
        }
        return out;
    }

    private static EconState.Notice n(EconState.Notice.Kind k, String text, String item, long coins, String other, long now) {
        return new EconState.Notice(k, text, item, coins, other, now);
    }
}
