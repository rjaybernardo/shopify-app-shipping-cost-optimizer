import type { ShipOrigin, ShopSettings } from "@prisma/client";
import db from "../db.server";
import {
  CARRIER_KEYS,
  TIER_KEYS,
  parseList,
  simulateQuotes,
  tierForService,
  type Address,
  type Carrier,
  type CarrierQuote,
  type Parcel,
} from "./carriers";
import { selectRates, type RateContext, type Selection } from "./rules";

// ---------------------------------------------------------------------------
// Rate providers

export interface RateProvider {
  id: string;
  quote(origin: Address, destination: Address, parcel: Parcel, carriers: Carrier[]): Promise<CarrierQuote[]>;
}

const simulatedProvider: RateProvider = {
  id: "SIMULATED",
  async quote(origin, destination, parcel, carriers) {
    return simulateQuotes(origin, destination, parcel, carriers);
  },
};

// EasyPost returns live negotiated rates for every carrier account linked to the key.
function easypostProvider(apiKey: string): RateProvider {
  return {
    id: "EASYPOST",
    async quote(origin, destination, parcel, carriers) {
      const address = (a: Address) => ({ zip: a.zip, state: a.province, city: a.city, country: a.countryCode });
      const response = await fetch("https://api.easypost.com/v2/shipments", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shipment: {
            from_address: address(origin),
            to_address: address(destination),
            parcel: {
              weight: Math.max(1, Math.round(parcel.weightGrams / 28.3495)),
              length: parcel.lengthIn,
              width: parcel.widthIn,
              height: parcel.heightIn,
            },
          },
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`EasyPost responded ${response.status}`);
      const json = (await response.json()) as {
        rates: { carrier: string; service: string; rate: string; delivery_days: number | null }[];
      };
      return json.rates.flatMap((r) => {
        const carrier = r.carrier.toUpperCase().replace(/\s.*/, "") as Carrier;
        if (!carriers.includes(carrier)) return [];
        const days = r.delivery_days ?? 5;
        return [{
          carrier,
          service: r.service.replace(/([a-z])([A-Z])/g, "$1 $2"),
          tier: tierForService(r.service, r.delivery_days),
          cost: Number(r.rate),
          minDays: days,
          maxDays: days,
        }];
      });
    },
  };
}

export function providerFor(settings: ShopSettings): RateProvider {
  if (settings.provider === "EASYPOST" && settings.easypostApiKey) {
    return easypostProvider(settings.easypostApiKey);
  }
  return simulatedProvider;
}

// ---------------------------------------------------------------------------
// Rate cache: checkout asks for the same lane repeatedly as shoppers edit their
// cart, so quotes are cached per lane + weight bucket for the shop's TTL.

const cache = new Map<string, { expires: number; quotes: CarrierQuote[] }>();
const MAX_CACHE_ENTRIES = 5000;

function cacheKey(shop: string, provider: string, origin: Address, destination: Address, parcel: Parcel) {
  const ounces = Math.ceil(parcel.weightGrams / 28.3495);
  const zip = (a: Address) => (a.zip ?? "").replace(/\s/g, "").slice(0, 5).toUpperCase();
  return [shop, provider, origin.countryCode, zip(origin), destination.countryCode, zip(destination), ounces, parcel.lengthIn, parcel.widthIn, parcel.heightIn].join("|");
}

export function clearRateCache(shop: string) {
  for (const key of cache.keys()) if (key.startsWith(`${shop}|`)) cache.delete(key);
}

async function cachedQuotes(
  settings: ShopSettings,
  provider: RateProvider,
  origin: Address,
  destination: Address,
  parcel: Parcel,
  carriers: Carrier[],
  bypassCache: boolean,
): Promise<{ quotes: CarrierQuote[]; hit: boolean }> {
  const key = cacheKey(settings.shop, provider.id, origin, destination, parcel);
  const now = Date.now();
  const hit = cache.get(key);
  if (!bypassCache && hit && hit.expires > now) {
    return { quotes: hit.quotes.filter((q) => carriers.includes(q.carrier)), hit: true };
  }

  let quotes: CarrierQuote[];
  try {
    quotes = await provider.quote(origin, destination, parcel, carriers);
  } catch (error) {
    // A live provider outage must never break checkout: fall back to list rates.
    console.error(`[optimizer] ${provider.id} failed, using simulated rates`, error);
    quotes = await simulatedProvider.quote(origin, destination, parcel, carriers);
  }

  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: now + settings.cacheTtlSeconds * 1000, quotes });
  return { quotes, hit: false };
}

// ---------------------------------------------------------------------------
// Optimization

export interface OptimizeInput {
  settings: ShopSettings;
  destination: Address;
  weightGrams: number; // product weight, packaging is added here
  subtotal: number;
  requestOrigin?: Address | null; // origin Shopify sent with the checkout request
  stockByLocation?: Set<string> | null; // location IDs able to fulfil every line
  bypassCache?: boolean;
}

export interface OriginResult {
  origin: { name: string; locationId: string | null; address: Address };
  quotes: CarrierQuote[];
  selections: Selection[];
  cacheHit: boolean;
}

export interface OptimizeResult {
  best: OriginResult | null;
  origins: OriginResult[];
  parcel: Parcel;
  latencyMs: number;
}

export function defaultParcel(settings: ShopSettings, weightGrams: number): Parcel {
  return {
    weightGrams: Math.max(1, weightGrams) + settings.packagingGrams,
    lengthIn: settings.boxLengthIn,
    widthIn: settings.boxWidthIn,
    heightIn: settings.boxHeightIn,
  };
}

function toAddress(o: ShipOrigin): Address {
  return { countryCode: o.countryCode, zip: o.zip, province: o.province, city: o.city };
}

// Quotes every candidate origin across every enabled carrier, applies rules, and
// keeps the origin whose cheapest offered rate is lowest.
export async function optimize(input: OptimizeInput): Promise<OptimizeResult> {
  const started = Date.now();
  const { settings } = input;
  const carriers = parseList(settings.enabledCarriers, CARRIER_KEYS);
  const tiers = parseList(settings.enabledTiers, TIER_KEYS);
  const parcel = defaultParcel(settings, input.weightGrams);
  const provider = providerFor(settings);

  const [rules, storedOrigins] = await Promise.all([
    db.shippingRule.findMany({ where: { shop: settings.shop, enabled: true } }),
    db.shipOrigin.findMany({ where: { shop: settings.shop, enabled: true } }),
  ]);

  let candidates: OriginResult["origin"][] = storedOrigins
    .filter((o) => !input.stockByLocation || input.stockByLocation.has(o.locationId))
    .map((o) => ({ name: o.name, locationId: o.locationId, address: toAddress(o) }));

  if (settings.routingMode === "SHOPIFY_ORIGIN" || candidates.length === 0) {
    const fallback = input.requestOrigin ?? (storedOrigins[0] ? toAddress(storedOrigins[0]) : null);
    candidates = fallback
      ? [{ name: storedOrigins.find((o) => o.zip === fallback.zip)?.name ?? "Shopify origin", locationId: null, address: fallback }]
      : [];
  }

  const ctx: RateContext = {
    destCountry: input.destination.countryCode,
    weightGrams: parcel.weightGrams,
    subtotal: input.subtotal,
  };

  const origins = await Promise.all(
    candidates.map(async (origin) => {
      const { quotes, hit } = await cachedQuotes(settings, provider, origin.address, input.destination, parcel, carriers, !!input.bypassCache);
      const selections = selectRates(quotes, rules, ctx, {
        tiers,
        baselineCarrier: settings.baselineCarrier as Carrier,
        markupPercent: settings.markupPercent,
        handlingFee: settings.handlingFee,
      });
      return { origin, quotes, selections, cacheHit: hit };
    }),
  );

  const lowest = (r: OriginResult) =>
    r.selections.length ? Math.min(...r.selections.map((s) => s.chosen.cost)) : Infinity;
  const best = origins.filter((o) => o.selections.length).sort((a, b) => lowest(a) - lowest(b))[0] ?? null;

  // Measure savings against the status quo: the baseline carrier shipping from the
  // location Shopify would have used, so routing savings count too.
  const defaultOrigin =
    origins.find((o) => input.requestOrigin?.zip && o.origin.address.zip === input.requestOrigin.zip) ?? origins[0];
  if (best && defaultOrigin && defaultOrigin !== best) {
    for (const s of best.selections) {
      const status = defaultOrigin.selections.find((d) => d.tier === s.tier);
      if (status) s.baselineCost = Math.max(s.baselineCost, status.baselineCost);
    }
  }

  return { best, origins, parcel, latencyMs: Date.now() - started };
}

// The tier a shopper most likely buys; used so analytics count one shipment per request.
export function primarySelection(selections: Selection[]) {
  return selections.find((s) => s.tier === "STANDARD") ?? selections[0];
}

export async function logQuote(
  shop: string,
  source: "CHECKOUT" | "CALCULATOR",
  input: { destination: Address; currency: string },
  result: OptimizeResult,
) {
  if (!result.best) return;
  const s = primarySelection(result.best.selections);
  if (!s) return;
  await db.rateQuote.create({
    data: {
      shop,
      source,
      destCountry: input.destination.countryCode,
      destZip: input.destination.zip ?? null,
      weightGrams: result.parcel.weightGrams,
      originName: result.best.origin.name,
      tier: s.tier,
      carrier: s.chosen.carrier,
      service: s.chosen.service,
      cost: s.chosen.cost,
      baselineCost: s.baselineCost,
      savings: Math.max(0, Math.round((s.baselineCost - s.chosen.cost) * 100) / 100),
      customerPrice: s.customerPrice,
      quotesCompared: result.origins.reduce((n, o) => n + o.quotes.length, 0),
      cacheHit: result.best.cacheHit,
      latencyMs: result.latencyMs,
      currency: input.currency,
    },
  });
}
