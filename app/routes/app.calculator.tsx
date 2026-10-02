import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSettings, getShopContext, searchVariants, type VariantOption } from "../lib/admin.server";
import { TIERS, carrierLabel, formatMoney } from "../lib/carriers";
import { logQuote, optimize } from "../lib/optimizer.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [context, originCount] = await Promise.all([
    getShopContext(admin),
    db.shipOrigin.count({ where: { shop: session.shop, enabled: true } }),
  ]);
  return { currency: context.shop.currencyCode, originCount };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();

  if (form.get("intent") === "search") {
    return { variants: await searchVariants(admin, String(form.get("query") ?? "")) };
  }

  const settings = await getSettings(session.shop);
  const { shop } = await getShopContext(admin);
  const destination = {
    countryCode: String(form.get("country") ?? "US").trim().toUpperCase().slice(0, 2),
    zip: String(form.get("zip") ?? "").trim() || null,
    province: String(form.get("province") ?? "").trim() || null,
  };
  const weightGrams = Math.max(1, Math.round(Number(form.get("weightGrams")) || 0));
  const subtotal = Math.max(0, Number(form.get("subtotal")) || 0);

  const result = await optimize({
    settings,
    destination,
    weightGrams,
    subtotal,
    bypassCache: form.get("fresh") === "true",
  });
  await logQuote(session.shop, "CALCULATOR", { destination, currency: shop.currencyCode }, result);

  return {
    result: {
      latencyMs: result.latencyMs,
      parcelGrams: result.parcel.weightGrams,
      bestOrigin: result.best?.origin.name ?? null,
      origins: result.origins.map((o) => ({
        name: o.origin.name,
        cacheHit: o.cacheHit,
        cheapest: o.quotes.length ? Math.min(...o.quotes.map((q) => q.cost)) : null,
        selections: o.selections.map((s) => ({
          tier: s.tier,
          carrier: s.chosen.carrier,
          service: s.chosen.service,
          cost: s.chosen.cost,
          baselineCost: s.baselineCost,
          customerPrice: s.customerPrice,
          appliedRules: s.appliedRules,
        })),
        quotes: [...o.quotes].sort((a, b) => a.cost - b.cost),
      })),
    },
  };
};

interface Line extends VariantOption {
  quantity: number;
}

export default function Calculator() {
  const { currency, originCount } = useLoaderData<typeof loader>();
  const search = useFetcher<typeof action>();
  const calc = useFetcher<typeof action>();
  const [lines, setLines] = useState<Line[]>([]);
  const [manualWeight, setManualWeight] = useState("500");
  const [manualSubtotal, setManualSubtotal] = useState("50");

  const variants = (search.data && "variants" in search.data && search.data.variants) || [];
  const result = calc.data && "result" in calc.data ? calc.data.result : null;
  const fromCart = lines.length > 0;
  const weightGrams = fromCart ? lines.reduce((s, l) => s + l.grams * l.quantity, 0) : Number(manualWeight);
  const subtotal = fromCart ? lines.reduce((s, l) => s + Number(l.price) * l.quantity, 0) : Number(manualSubtotal);
  const best = result?.origins.find((o) => o.name === result.bestOrigin);

  const addLine = (v: VariantOption) =>
    setLines((ls) =>
      ls.some((l) => l.id === v.id)
        ? ls.map((l) => (l.id === v.id ? { ...l, quantity: l.quantity + 1 } : l))
        : [...ls, { ...v, quantity: 1 }],
    );

  return (
    <s-page heading="Rate calculator">
      <s-link slot="breadcrumb-actions" href="/app">
        Dashboard
      </s-link>
      <s-stack gap="base">
        {originCount === 0 && (
          <s-banner tone="warning" heading="No ship-from locations">
            Sync your locations in <s-link href="/app/settings">Settings</s-link> so
            rates are quoted from real origins.
          </s-banner>
        )}

        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(320px, 1fr))" gap="base">
          <s-section heading="Package">
            <s-stack gap="base">
              <search.Form method="post">
                <input type="hidden" name="intent" value="search" />
                <s-stack direction="inline" gap="small-200" alignItems="end">
                  <s-search-field label="Add products from your catalog" name="query" placeholder="Search variants" />
                  <s-button type="submit" {...(search.state !== "idle" ? { loading: true } : {})}>
                    Search
                  </s-button>
                </s-stack>
              </search.Form>
              {variants.length > 0 && (
                <s-stack gap="small-100">
                  {variants.map((v) => (
                    <s-stack key={v.id} direction="inline" justifyContent="space-between" alignItems="center">
                      <s-text>
                        {v.displayName}{" "}
                        <s-text color="subdued">· {v.grams ? `${v.grams} g` : "no weight set"}</s-text>
                      </s-text>
                      <s-button variant="tertiary" onClick={() => addLine(v)}>
                        Add
                      </s-button>
                    </s-stack>
                  ))}
                </s-stack>
              )}
              {fromCart ? (
                <s-stack gap="small-100">
                  <s-heading>Cart</s-heading>
                  {lines.map((l) => (
                    <s-stack key={l.id} direction="inline" justifyContent="space-between" alignItems="center">
                      <s-text>
                        {l.quantity} × {l.displayName}
                      </s-text>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        onClick={() => setLines((ls) => ls.filter((x) => x.id !== l.id))}
                      >
                        Remove
                      </s-button>
                    </s-stack>
                  ))}
                  <s-text color="subdued">
                    {weightGrams} g · {formatMoney(subtotal, currency)}
                  </s-text>
                </s-stack>
              ) : (
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-number-field
                    label="Product weight"
                    value={manualWeight}
                    min={1}
                    suffix="g"
                    onInput={(e) => setManualWeight(e.currentTarget.value)}
                  />
                  <s-number-field
                    label="Cart subtotal"
                    value={manualSubtotal}
                    min={0}
                    onInput={(e) => setManualSubtotal(e.currentTarget.value)}
                  />
                </s-grid>
              )}
            </s-stack>
          </s-section>

          <s-section heading="Destination">
            <calc.Form method="post">
              <input type="hidden" name="weightGrams" value={String(weightGrams || 1)} />
              <input type="hidden" name="subtotal" value={String(subtotal || 0)} />
              <s-stack gap="base">
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-text-field label="Country code" name="country" defaultValue="US" maxLength={2} />
                  <s-text-field label="Postal code" name="zip" defaultValue="94103" />
                </s-grid>
                <s-text-field label="State / province code" name="province" defaultValue="CA" />
                <s-checkbox label="Bypass rate cache (fetch fresh rates)" name="fresh" value="true" />
                <s-button variant="primary" type="submit" {...(calc.state !== "idle" ? { loading: true } : {})}>
                  Compare rates
                </s-button>
              </s-stack>
            </calc.Form>
          </s-section>
        </s-grid>

        {result && !best && (
          <s-banner tone="warning">
            No carrier can ship this package with the current settings and rules.
          </s-banner>
        )}

        {result && best && (
          <>
            <s-section heading={`What the shopper sees · ships from ${best.name}`}>
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(200px, 1fr))" gap="base">
                {best.selections.map((s) => {
                  const saved = s.baselineCost - s.cost;
                  return (
                    <s-box key={s.tier} padding="base" border="base" borderRadius="base">
                      <s-stack gap="small-200">
                        <s-text color="subdued">{TIERS[s.tier].label}</s-text>
                        <s-heading>{formatMoney(s.customerPrice, currency)}</s-heading>
                        <s-text>
                          {carrierLabel(s.carrier)} {s.service} · cost {formatMoney(s.cost, currency)}
                        </s-text>
                        {saved > 0 ? (
                          <s-badge tone="success">Saves {formatMoney(saved, currency)}</s-badge>
                        ) : (
                          <s-badge tone="neutral">Same as baseline</s-badge>
                        )}
                        {s.appliedRules.map((r) => (
                          <s-text key={r} color="subdued">
                            {r}
                          </s-text>
                        ))}
                      </s-stack>
                    </s-box>
                  );
                })}
              </s-grid>
              <s-text color="subdued">
                {result.parcelGrams} g billed with packaging · {result.latencyMs} ms
                {best.cacheHit ? " · served from cache" : ""}
              </s-text>
            </s-section>

            {result.origins.length > 1 && (
              <s-section heading="Location routing">
                <s-stack gap="small-100">
                  {result.origins.map((o) => (
                    <s-stack key={o.name} direction="inline" justifyContent="space-between">
                      <s-text type={o.name === result.bestOrigin ? "strong" : undefined}>{o.name}</s-text>
                      <s-text>
                        {o.cheapest != null ? `from ${formatMoney(o.cheapest, currency)}` : "No service"}
                        {o.name === result.bestOrigin ? " · selected" : ""}
                      </s-text>
                    </s-stack>
                  ))}
                </s-stack>
              </s-section>
            )}

            <s-section heading={`All ${best.quotes.length} carrier quotes`} padding="none">
              <s-table>
                <s-table-header-row>
                  <s-table-header listSlot="primary">Service</s-table-header>
                  <s-table-header>Level</s-table-header>
                  <s-table-header>Transit</s-table-header>
                  <s-table-header format="currency">Cost</s-table-header>
                </s-table-header-row>
                <s-table-body>
                  {best.quotes.map((q) => {
                    const picked = best.selections.some(
                      (s) => s.carrier === q.carrier && s.service === q.service,
                    );
                    return (
                      <s-table-row key={`${q.carrier}-${q.service}`}>
                        <s-table-cell>
                          <s-stack direction="inline" gap="small-200" alignItems="center">
                            <s-text type={picked ? "strong" : undefined}>
                              {carrierLabel(q.carrier)} {q.service}
                            </s-text>
                            {picked && <s-badge tone="success">Selected</s-badge>}
                          </s-stack>
                        </s-table-cell>
                        <s-table-cell>{TIERS[q.tier].label}</s-table-cell>
                        <s-table-cell>
                          {q.minDays === q.maxDays ? q.minDays : `${q.minDays}–${q.maxDays}`} days
                        </s-table-cell>
                        <s-table-cell>{formatMoney(q.cost, currency)}</s-table-cell>
                      </s-table-row>
                    );
                  })}
                </s-table-body>
              </s-table>
            </s-section>
          </>
        )}
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
