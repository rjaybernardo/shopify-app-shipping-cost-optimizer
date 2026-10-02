import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { locationsWithStock } from "../lib/admin.server";
import { carrierLabel, TIERS } from "../lib/carriers";
import { logQuote, optimize } from "../lib/optimizer.server";

// Shopify's carrier-calculated shipping callback. Shopify POSTs the cart and
// address here at checkout and shows whatever rates we return. Any error must
// degrade to backup rates (non-2xx) rather than hang: the time budget is ≤10s.

interface RateRequest {
  rate: {
    origin: { country: string; postal_code: string | null; province: string | null; city: string | null };
    destination: { country: string; postal_code: string | null; province: string | null; city: string | null };
    items: { quantity: number; grams: number; price: number; requires_shipping: boolean; variant_id: number | null }[];
    currency: string;
    order_totals?: { subtotal_price?: string };
  };
}

const STOCK_TTL_MS = 60_000;
const stockCache = new Map<string, { expires: number; value: Set<string> | null }>();

function verifyHmac(raw: string, header: string | null) {
  // The secret path token authenticates the shop; when Shopify also signs the
  // request we verify that too.
  if (!header) return true;
  const digest = createHmac("sha256", process.env.SHOPIFY_API_SECRET || "").update(raw, "utf8").digest();
  const given = Buffer.from(header, "base64");
  return given.length === digest.length && timingSafeEqual(given, digest);
}

async function stockFor(shop: string, lines: { variantId: number; quantity: number }[]) {
  const key = `${shop}|${lines.map((l) => `${l.variantId}x${l.quantity}`).sort().join(",")}`;
  const cached = stockCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const { admin } = await unauthenticated.admin(shop);
  const value = await locationsWithStock(admin, lines);
  stockCache.set(key, { expires: Date.now() + STOCK_TTL_MS, value });
  return value;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const settings = await db.shopSettings.findUnique({ where: { callbackToken: params.token ?? "" } });
  if (!settings || !settings.checkoutActive) return new Response("Unknown carrier service", { status: 404 });

  const raw = await request.text();
  if (!verifyHmac(raw, request.headers.get("x-shopify-hmac-sha256"))) {
    return new Response("Invalid signature", { status: 401 });
  }

  try {
    const { rate } = JSON.parse(raw) as RateRequest;
    const items = rate.items.filter((i) => i.requires_shipping);
    if (items.length === 0) return Response.json({ rates: [] });

    const weightGrams = items.reduce((sum, i) => sum + i.grams * i.quantity, 0);
    const subtotalCents = Number(rate.order_totals?.subtotal_price ?? items.reduce((s, i) => s + i.price * i.quantity, 0));
    const destination = {
      countryCode: rate.destination.country,
      zip: rate.destination.postal_code,
      province: rate.destination.province,
      city: rate.destination.city,
    };

    let stockByLocation: Set<string> | null = null;
    if (settings.stockAwareRouting && settings.routingMode === "CHEAPEST_LOCATION") {
      const lines = items.filter((i) => i.variant_id).map((i) => ({ variantId: i.variant_id!, quantity: i.quantity }));
      // Stock lookup is a nice-to-have; never let it cost us the checkout.
      stockByLocation = await Promise.race([
        stockFor(settings.shop, lines).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
      ]);
    }

    const result = await optimize({
      settings,
      destination,
      weightGrams,
      subtotal: subtotalCents / 100,
      requestOrigin: {
        countryCode: rate.origin.country,
        zip: rate.origin.postal_code,
        province: rate.origin.province,
        city: rate.origin.city,
      },
      stockByLocation,
    });

    if (!result.best) return Response.json({ rates: [] });

    const now = Date.now();
    const day = 86_400_000;
    const rates = result.best.selections.map((s) => ({
      service_name: settings.showCarrierName
        ? `${TIERS[s.tier].checkoutName} (${carrierLabel(s.chosen.carrier)} ${s.chosen.service})`
        : TIERS[s.tier].checkoutName,
      service_code: `sco_${s.tier.toLowerCase()}`,
      description: `Delivered in ${s.chosen.minDays === s.chosen.maxDays ? s.chosen.minDays : `${s.chosen.minDays}–${s.chosen.maxDays}`} business day${s.chosen.maxDays === 1 ? "" : "s"}`,
      total_price: String(Math.round(s.customerPrice * 100)),
      currency: rate.currency,
      min_delivery_date: new Date(now + s.chosen.minDays * day).toISOString(),
      max_delivery_date: new Date(now + s.chosen.maxDays * day).toISOString(),
    }));

    // Analytics write happens off the response path.
    logQuote(settings.shop, "CHECKOUT", { destination, currency: rate.currency }, result).catch((e) =>
      console.error("[carrier] failed to log quote", e),
    );

    return Response.json({ rates });
  } catch (error) {
    console.error("[carrier] rate request failed", error);
    return new Response("Rate calculation failed", { status: 500 });
  }
};

export const loader = () => new Response("Method not allowed", { status: 405 });
