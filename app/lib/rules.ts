import type { ShippingRule } from "@prisma/client";
import {
  TIER_KEYS,
  carrierLabel,
  type Carrier,
  type CarrierQuote,
  type Tier,
} from "./carriers";

export const RULE_ACTIONS = {
  EXCLUDE_CARRIER: { label: "Never use carrier", needsCarrier: true, needsTier: false, valueLabel: null },
  PREFER_CARRIER: { label: "Prefer carrier", needsCarrier: true, needsTier: false, valueLabel: "Max premium (%)" },
  HIDE_TIER: { label: "Hide service level", needsCarrier: false, needsTier: true, valueLabel: null },
  FREE_SHIPPING: { label: "Free shipping", needsCarrier: false, needsTier: true, valueLabel: null },
  ADJUST_PRICE: { label: "Adjust customer price", needsCarrier: false, needsTier: false, valueLabel: "Change (%)" },
} as const;
export type RuleAction = keyof typeof RULE_ACTIONS;

export interface RateContext {
  destCountry: string;
  weightGrams: number;
  subtotal: number;
}

export function ruleMatches(rule: ShippingRule, ctx: RateContext) {
  if (!rule.enabled) return false;
  const countries = (rule.countries ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  if (countries.length && !countries.includes(ctx.destCountry.toUpperCase())) return false;
  if (rule.minWeightG != null && ctx.weightGrams < rule.minWeightG) return false;
  if (rule.maxWeightG != null && ctx.weightGrams > rule.maxWeightG) return false;
  if (rule.minSubtotal != null && ctx.subtotal < rule.minSubtotal) return false;
  if (rule.maxSubtotal != null && ctx.subtotal > rule.maxSubtotal) return false;
  return true;
}

export interface Selection {
  tier: Tier;
  chosen: CarrierQuote;
  cheapest: CarrierQuote;
  baselineCost: number;
  customerPrice: number;
  alternatives: number;
  appliedRules: string[];
}

export interface SelectOptions {
  tiers: Tier[];
  baselineCarrier: Carrier;
  markupPercent: number;
  handlingFee: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Picks one quote per service tier: the cheapest by default, bent by any matching
// rules. Baseline cost is what the merchant's previous carrier would have charged
// for the same tier (or the priciest option when that carrier has no such service).
export function selectRates(
  quotes: CarrierQuote[],
  rules: ShippingRule[],
  ctx: RateContext,
  opts: SelectOptions,
): Selection[] {
  const matching = rules
    .filter((r) => ruleMatches(r, ctx))
    .sort((a, b) => a.priority - b.priority);

  const excluded = new Set(
    matching.filter((r) => r.action === "EXCLUDE_CARRIER").map((r) => r.carrier),
  );
  const hidden = new Set(matching.filter((r) => r.action === "HIDE_TIER").map((r) => r.tier));
  const preferred = matching.filter((r) => r.action === "PREFER_CARRIER");
  const freeTiers = matching.filter((r) => r.action === "FREE_SHIPPING");
  const adjustments = matching.filter((r) => r.action === "ADJUST_PRICE");

  const selections: Selection[] = [];
  for (const tier of TIER_KEYS) {
    if (!opts.tiers.includes(tier) || hidden.has(tier)) continue;
    const inTier = quotes.filter((q) => q.tier === tier);
    const eligible = inTier
      .filter((q) => !excluded.has(q.carrier))
      .sort((a, b) => a.cost - b.cost);
    if (eligible.length === 0) continue;

    const applied: string[] = [];
    const cheapest = eligible[0];
    let chosen = cheapest;
    for (const rule of preferred) {
      const tolerance = (rule.value ?? 0) / 100;
      const candidate = eligible.find((q) => q.carrier === rule.carrier);
      if (candidate && candidate.cost <= cheapest.cost * (1 + tolerance)) {
        chosen = candidate;
        if (candidate !== cheapest) {
          applied.push(`${rule.name}: prefer ${carrierLabel(candidate.carrier)}`);
        }
        break;
      }
    }
    for (const rule of matching) {
      if (rule.action === "EXCLUDE_CARRIER" && inTier.some((q) => q.carrier === rule.carrier)) {
        applied.push(`${rule.name}: excluded ${carrierLabel(rule.carrier ?? "")}`);
      }
    }

    const baseline =
      inTier.filter((q) => q.carrier === opts.baselineCarrier).sort((a, b) => a.cost - b.cost)[0] ??
      inTier.reduce((max, q) => (q.cost > max.cost ? q : max), inTier[0]);

    let price = chosen.cost * (1 + opts.markupPercent / 100) + opts.handlingFee;
    for (const rule of adjustments) {
      price *= 1 + (rule.value ?? 0) / 100;
      applied.push(`${rule.name}: ${rule.value! > 0 ? "+" : ""}${rule.value}%`);
    }
    const free = freeTiers.find((r) => !r.tier || r.tier === tier);
    if (free) {
      price = 0;
      applied.push(`${free.name}: free`);
    }

    selections.push({
      tier,
      chosen,
      cheapest,
      baselineCost: baseline.cost,
      customerPrice: round2(Math.max(0, price)),
      alternatives: inTier.length,
      appliedRules: applied,
    });
  }
  return selections;
}

export function describeRule(rule: ShippingRule) {
  const action = RULE_ACTIONS[rule.action as RuleAction];
  const parts: string[] = [action?.label ?? rule.action];
  if (rule.carrier) parts.push(carrierLabel(rule.carrier));
  if (rule.tier) parts.push(`(${rule.tier.toLowerCase()})`);
  if (rule.action === "PREFER_CARRIER") parts.push(`if within ${rule.value ?? 0}% of cheapest`);
  if (rule.action === "ADJUST_PRICE") parts.push(`${rule.value! > 0 ? "+" : ""}${rule.value ?? 0}%`);
  return parts.join(" ");
}

export function describeConditions(rule: ShippingRule, currency: string) {
  const parts: string[] = [];
  if (rule.countries) parts.push(`to ${rule.countries}`);
  if (rule.minWeightG != null || rule.maxWeightG != null) {
    parts.push(`weight ${rule.minWeightG ?? 0}–${rule.maxWeightG ?? "∞"} g`);
  }
  if (rule.minSubtotal != null || rule.maxSubtotal != null) {
    parts.push(`subtotal ${rule.minSubtotal ?? 0}–${rule.maxSubtotal ?? "∞"} ${currency}`);
  }
  return parts.length ? parts.join(", ") : "All orders";
}
