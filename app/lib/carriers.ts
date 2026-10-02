// Carrier catalog, parcel math and the built-in tariff model. Everything here is
// pure so it can run inside the checkout callback without I/O.

export const CARRIERS = {
  USPS: { label: "USPS" },
  UPS: { label: "UPS" },
  FEDEX: { label: "FedEx" },
  DHL: { label: "DHL" },
} as const;
export type Carrier = keyof typeof CARRIERS;
export const CARRIER_KEYS = Object.keys(CARRIERS) as Carrier[];

export const TIERS = {
  ECONOMY: { label: "Economy", checkoutName: "Economy shipping" },
  STANDARD: { label: "Standard", checkoutName: "Standard shipping" },
  EXPRESS: { label: "Express", checkoutName: "Express shipping" },
  OVERNIGHT: { label: "Overnight", checkoutName: "Overnight shipping" },
} as const;
export type Tier = keyof typeof TIERS;
export const TIER_KEYS = Object.keys(TIERS) as Tier[];

export interface Address {
  countryCode: string;
  zip?: string | null;
  province?: string | null;
  city?: string | null;
}

export interface Parcel {
  weightGrams: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

export interface CarrierQuote {
  carrier: Carrier;
  service: string;
  tier: Tier;
  cost: number;
  minDays: number;
  maxDays: number;
}

// Billable weight in whole pounds: the greater of actual and dimensional weight.
export function billableLbs(parcel: Parcel, dimDivisor: number) {
  const actual = parcel.weightGrams / 453.592;
  const dim = (parcel.lengthIn * parcel.widthIn * parcel.heightIn) / dimDivisor;
  return Math.max(1, Math.ceil(Math.max(actual, dim)));
}

// Rough centroid per leading US ZIP digit, enough to derive a 1–8 shipping zone.
const ZIP_REGIONS: Record<string, [number, number]> = {
  "0": [42.5, -72],
  "1": [41.5, -75.5],
  "2": [37.5, -78.5],
  "3": [32, -84.5],
  "4": [39.5, -85],
  "5": [44, -93],
  "6": [38.5, -94],
  "7": [31.5, -97],
  "8": [39.5, -108],
  "9": [37.5, -120],
};

function haversineMiles([lat1, lon1]: [number, number], [lat2, lon2]: [number, number]) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(a));
}

// Returns a domestic zone (1–8) or "INTL" for cross-border shipments.
export function shippingZone(origin: Address, destination: Address): number | "INTL" {
  if (origin.countryCode !== destination.countryCode) return "INTL";
  const o = origin.zip?.trim()[0];
  const d = destination.zip?.trim()[0];
  if (origin.countryCode === "US" && o && d && ZIP_REGIONS[o] && ZIP_REGIONS[d]) {
    const miles = haversineMiles(ZIP_REGIONS[o], ZIP_REGIONS[d]);
    if (miles < 50) return 1;
    if (miles < 150) return 2;
    if (miles < 300) return 3;
    if (miles < 600) return 4;
    if (miles < 1000) return 5;
    if (miles < 1400) return 6;
    if (miles < 1800) return 7;
    return 8;
  }
  // Outside the US: same postal prefix ≈ regional, otherwise national.
  return o && d && o.toUpperCase() === d.toUpperCase() ? 2 : 5;
}

interface Tariff {
  carrier: Carrier;
  service: string;
  tier: Tier;
  base: number;
  perLb: number;
  zoneStep: number; // added per zone above 1
  dimDivisor: number;
  maxLbs: number;
  days: [number, number];
  domestic: boolean;
  international: boolean;
  intlBase?: number;
  intlPerLb?: number;
}

// Published-style list rates. Each carrier has a sweet spot (USPS for light
// parcels, UPS/FedEx ground for heavy, DHL for cross-border) so the optimizer has
// real trade-offs to make.
const TARIFFS: Tariff[] = [
  { carrier: "USPS", service: "Ground Advantage", tier: "ECONOMY", base: 4.75, perLb: 0.95, zoneStep: 0.55, dimDivisor: 166, maxLbs: 70, days: [2, 5], domestic: true, international: false },
  { carrier: "USPS", service: "Priority Mail", tier: "STANDARD", base: 7.9, perLb: 1.35, zoneStep: 0.85, dimDivisor: 166, maxLbs: 70, days: [1, 3], domestic: true, international: true, intlBase: 32, intlPerLb: 4.1 },
  { carrier: "USPS", service: "Priority Mail Express", tier: "EXPRESS", base: 26.35, perLb: 2.4, zoneStep: 1.6, dimDivisor: 166, maxLbs: 70, days: [1, 2], domestic: true, international: true, intlBase: 48, intlPerLb: 5.2 },
  { carrier: "UPS", service: "Ground Saver", tier: "ECONOMY", base: 6.4, perLb: 0.7, zoneStep: 0.45, dimDivisor: 139, maxLbs: 150, days: [2, 7], domestic: true, international: false },
  { carrier: "UPS", service: "Ground", tier: "STANDARD", base: 9.45, perLb: 0.62, zoneStep: 0.7, dimDivisor: 139, maxLbs: 150, days: [1, 5], domestic: true, international: false },
  { carrier: "UPS", service: "2nd Day Air", tier: "EXPRESS", base: 19.8, perLb: 2.05, zoneStep: 1.35, dimDivisor: 139, maxLbs: 150, days: [2, 2], domestic: true, international: false },
  { carrier: "UPS", service: "Next Day Air", tier: "OVERNIGHT", base: 34.5, perLb: 3.6, zoneStep: 2.3, dimDivisor: 139, maxLbs: 150, days: [1, 1], domestic: true, international: false },
  { carrier: "UPS", service: "Worldwide Saver", tier: "EXPRESS", base: 0, perLb: 0, zoneStep: 0, dimDivisor: 139, maxLbs: 150, days: [2, 5], domestic: false, international: true, intlBase: 52, intlPerLb: 4.6 },
  { carrier: "FEDEX", service: "Ground Economy", tier: "ECONOMY", base: 6.1, perLb: 0.74, zoneStep: 0.5, dimDivisor: 139, maxLbs: 70, days: [2, 7], domestic: true, international: false },
  { carrier: "FEDEX", service: "Ground", tier: "STANDARD", base: 9.2, perLb: 0.66, zoneStep: 0.72, dimDivisor: 139, maxLbs: 150, days: [1, 5], domestic: true, international: false },
  { carrier: "FEDEX", service: "Express Saver", tier: "EXPRESS", base: 18.9, perLb: 1.95, zoneStep: 1.4, dimDivisor: 139, maxLbs: 150, days: [3, 3], domestic: true, international: false },
  { carrier: "FEDEX", service: "Priority Overnight", tier: "OVERNIGHT", base: 36.1, perLb: 3.45, zoneStep: 2.2, dimDivisor: 139, maxLbs: 150, days: [1, 1], domestic: true, international: false },
  { carrier: "FEDEX", service: "International Economy", tier: "STANDARD", base: 0, perLb: 0, zoneStep: 0, dimDivisor: 139, maxLbs: 150, days: [4, 6], domestic: false, international: true, intlBase: 38, intlPerLb: 3.9 },
  { carrier: "DHL", service: "eCommerce Ground", tier: "ECONOMY", base: 4.4, perLb: 1.15, zoneStep: 0.6, dimDivisor: 166, maxLbs: 25, days: [3, 8], domestic: true, international: true, intlBase: 14.5, intlPerLb: 3.1 },
  { carrier: "DHL", service: "Express Worldwide", tier: "EXPRESS", base: 0, perLb: 0, zoneStep: 0, dimDivisor: 139, maxLbs: 150, days: [2, 4], domestic: false, international: true, intlBase: 41, intlPerLb: 3.4 },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

// Deterministic list-rate estimate for every carrier service that can carry the
// parcel between the two addresses.
export function simulateQuotes(
  origin: Address,
  destination: Address,
  parcel: Parcel,
  carriers: Carrier[] = CARRIER_KEYS,
): CarrierQuote[] {
  const zone = shippingZone(origin, destination);
  const quotes: CarrierQuote[] = [];

  for (const t of TARIFFS) {
    if (!carriers.includes(t.carrier)) continue;
    const lbs = billableLbs(parcel, t.dimDivisor);
    if (lbs > t.maxLbs) continue;

    let cost: number;
    if (zone === "INTL") {
      if (!t.international) continue;
      cost = t.intlBase! + t.intlPerLb! * lbs;
    } else {
      if (!t.domestic) continue;
      cost = t.base + t.perLb * lbs + t.zoneStep * (zone - 1) * Math.sqrt(lbs);
    }
    const extraDays = zone === "INTL" ? 0 : zone >= 7 ? 1 : 0;
    quotes.push({
      carrier: t.carrier,
      service: t.service,
      tier: t.tier,
      cost: round2(cost),
      minDays: t.days[0],
      maxDays: t.days[1] + (t.tier === "ECONOMY" || t.tier === "STANDARD" ? extraDays : 0),
    });
  }
  return quotes;
}

// Maps an aggregator's service name onto our tiers.
export function tierForService(service: string, deliveryDays?: number | null): Tier {
  const s = service.toLowerCase();
  if (/overnight|next ?day|express ?1|first overnight/.test(s)) return "OVERNIGHT";
  if (/express|2nd ?day|2 ?day|priority express|worldwide/.test(s)) return "EXPRESS";
  if (/economy|saver|advantage|smartpost|ecommerce|parcel select/.test(s)) return "ECONOMY";
  if (deliveryDays != null) {
    if (deliveryDays <= 1) return "OVERNIGHT";
    if (deliveryDays <= 2) return "EXPRESS";
    if (deliveryDays >= 5) return "ECONOMY";
  }
  return "STANDARD";
}

export function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function carrierLabel(carrier: string) {
  return CARRIERS[carrier as Carrier]?.label ?? carrier;
}

export function parseList<T extends string>(value: string | null | undefined, allowed: readonly T[]): T[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toUpperCase())
    .filter((v): v is T => (allowed as readonly string[]).includes(v));
}
