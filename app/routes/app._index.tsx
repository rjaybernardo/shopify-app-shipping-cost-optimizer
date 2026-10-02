import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSettings, getShopContext } from "../lib/admin.server";
import { TIERS, carrierLabel, formatMoney, type Tier } from "../lib/carriers";
import { clearRateCache } from "../lib/optimizer.server";

const RANGE_DAYS = 30;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const includeCalculator = new URL(request.url).searchParams.get("source") === "all";
  const since = new Date(Date.now() - RANGE_DAYS * 86_400_000);

  const [settings, context, originCount, ruleCount, quotes] = await Promise.all([
    getSettings(shop),
    getShopContext(admin),
    db.shipOrigin.count({ where: { shop, enabled: true } }),
    db.shippingRule.count({ where: { shop, enabled: true } }),
    db.rateQuote.findMany({
      where: { shop, createdAt: { gte: since }, ...(includeCalculator ? {} : { source: "CHECKOUT" }) },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const totalSavings = quotes.reduce((s, q) => s + q.savings, 0);
  const totalBaseline = quotes.reduce((s, q) => s + q.baselineCost, 0);
  const totalCost = quotes.reduce((s, q) => s + q.cost, 0);

  // Daily savings, oldest first, with empty days kept so gaps read as zero.
  const daily = Array.from({ length: RANGE_DAYS }, (_, i) => {
    const d = new Date(Date.now() - (RANGE_DAYS - 1 - i) * 86_400_000);
    return { date: d.toISOString().slice(0, 10), savings: 0, quotes: 0 };
  });
  const byDate = new Map(daily.map((d) => [d.date, d]));
  for (const q of quotes) {
    const day = byDate.get(q.createdAt.toISOString().slice(0, 10));
    if (day) {
      day.savings += q.savings;
      day.quotes += 1;
    }
  }

  const mix = new Map<string, { count: number; cost: number; savings: number }>();
  for (const q of quotes) {
    const m = mix.get(q.carrier) ?? { count: 0, cost: 0, savings: 0 };
    m.count += 1;
    m.cost += q.cost;
    m.savings += q.savings;
    mix.set(q.carrier, m);
  }

  return {
    currency: context.shop.currencyCode,
    includeCalculator,
    setup: {
      checkoutActive: settings.checkoutActive,
      originCount,
      ruleCount,
      provider: settings.provider,
      baselineCarrier: settings.baselineCarrier,
    },
    kpis: {
      totalSavings,
      savingsRate: totalBaseline ? totalSavings / totalBaseline : 0,
      quotes: quotes.length,
      avgCost: quotes.length ? totalCost / quotes.length : 0,
      cacheHitRate: quotes.length ? quotes.filter((q) => q.cacheHit).length / quotes.length : 0,
      avgLatency: quotes.length ? quotes.reduce((s, q) => s + q.latencyMs, 0) / quotes.length : 0,
    },
    daily: daily.map((d) => ({ ...d, savings: Math.round(d.savings * 100) / 100 })),
    mix: [...mix.entries()]
      .map(([carrier, m]) => ({ carrier, ...m, share: m.count / quotes.length }))
      .sort((a, b) => b.count - a.count),
    recent: quotes.slice(0, 10).map((q) => ({
      id: q.id,
      createdAt: q.createdAt.toISOString(),
      source: q.source,
      destination: [q.destZip, q.destCountry].filter(Boolean).join(", "),
      weightGrams: q.weightGrams,
      originName: q.originName,
      tier: q.tier,
      carrier: q.carrier,
      service: q.service,
      cost: q.cost,
      savings: q.savings,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  clearRateCache(session.shop);
  return { cleared: true };
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function Dashboard() {
  const { currency, includeCalculator, setup, kpis, daily, mix, recent } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();

  useEffect(() => {
    if (fetcher.data?.cleared) shopify.toast.show("Rate cache cleared");
  }, [fetcher.data, shopify]);

  const needsSetup = !setup.checkoutActive || setup.originCount === 0;

  return (
    <s-page heading="Shipping Cost Optimizer">
      <s-button slot="primary-action" variant="primary" href="/app/calculator">
        Compare rates
      </s-button>
      <s-button
        slot="secondary-actions"
        onClick={() => fetcher.submit({}, { method: "POST" })}
        {...(fetcher.state !== "idle" ? { loading: true } : {})}
      >
        Clear rate cache
      </s-button>

      {needsSetup && (
        <s-banner tone="info" heading="Finish setup to optimize checkout rates">
          <s-stack gap="small-100">
            <s-text>
              {setup.originCount > 0 ? "✓" : "1."} Sync your ship-from locations
            </s-text>
            <s-text>
              {setup.checkoutActive ? "✓" : "2."} Activate the optimizer at checkout
            </s-text>
            <s-link href="/app/settings">Open settings</s-link>
          </s-stack>
        </s-banner>
      )}

      <s-section padding="base">
        <s-stack gap="base">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center">
            <s-text color="subdued">
              Last {RANGE_DAYS} days · savings vs {carrierLabel(setup.baselineCarrier)} ·{" "}
              {setup.provider === "EASYPOST" ? "EasyPost live rates" : "built-in list rates"}
            </s-text>
            <s-select
              label="Data source"
              labelAccessibilityVisibility="exclusive"
              value={includeCalculator ? "all" : "checkout"}
              onChange={(e) => setSearchParams(e.currentTarget.value === "all" ? { source: "all" } : {})}
            >
              <s-option value="checkout">Checkout only</s-option>
              <s-option value="all">Checkout + calculator</s-option>
            </s-select>
          </s-stack>
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
            <Metric label="Estimated savings" value={formatMoney(kpis.totalSavings, currency)}>
              {pct(kpis.savingsRate)} below baseline
            </Metric>
            <Metric label="Rate requests" value={kpis.quotes.toLocaleString()}>
              Optimized quotes served
            </Metric>
            <Metric label="Avg. shipping cost" value={formatMoney(kpis.avgCost, currency)}>
              Selected carrier, per request
            </Metric>
            <Metric label="Cache hit rate" value={pct(kpis.cacheHitRate)}>
              {Math.round(kpis.avgLatency)} ms avg. response
            </Metric>
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="Daily savings">
        <SavingsChart daily={daily} currency={currency} />
      </s-section>

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(320px, 1fr))" gap="base">
        <s-section heading="Carrier mix" padding="none">
          {mix.length === 0 ? (
            <s-box padding="base">
              <s-text color="subdued">No quotes yet.</s-text>
            </s-box>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Carrier</s-table-header>
                <s-table-header format="numeric">Share</s-table-header>
                <s-table-header format="currency">Savings</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {mix.map((m) => (
                  <s-table-row key={m.carrier}>
                    <s-table-cell>{carrierLabel(m.carrier)}</s-table-cell>
                    <s-table-cell>
                      {pct(m.share)} ({m.count})
                    </s-table-cell>
                    <s-table-cell>{formatMoney(m.savings, currency)}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>

        <s-section heading="Optimizer status">
          <s-stack gap="small-200">
            <StatusRow label="Checkout carrier service" ok={setup.checkoutActive}>
              {setup.checkoutActive ? "Live" : "Not active"}
            </StatusRow>
            <StatusRow label="Ship-from locations" ok={setup.originCount > 0}>
              {setup.originCount} enabled
            </StatusRow>
            <StatusRow label="Carrier rules" ok>
              {setup.ruleCount} active · <s-link href="/app/rules">Manage</s-link>
            </StatusRow>
          </s-stack>
        </s-section>
      </s-grid>

      <s-section heading="Recent rate requests" padding="none">
        {recent.length === 0 ? (
          <s-box padding="base">
            <s-text color="subdued">
              Requests appear here as shoppers reach checkout. Try the{" "}
              <s-link href="/app/calculator">rate calculator</s-link> and switch the
              data source to include calculator runs.
            </s-text>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Selected service</s-table-header>
              <s-table-header>Destination</s-table-header>
              <s-table-header>From</s-table-header>
              <s-table-header format="numeric">Weight</s-table-header>
              <s-table-header format="currency">Cost</s-table-header>
              <s-table-header listSlot="labeled" format="currency">Saved</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recent.map((q) => (
                <s-table-row key={q.id}>
                  <s-table-cell>
                    <s-stack gap="none">
                      <s-text>
                        {carrierLabel(q.carrier)} {q.service}
                      </s-text>
                      <s-text color="subdued">
                        {TIERS[q.tier as Tier]?.label ?? q.tier}
                        {q.source === "CALCULATOR" ? " · calculator" : ""}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{q.destination}</s-table-cell>
                  <s-table-cell>{q.originName ?? "—"}</s-table-cell>
                  <s-table-cell>{(q.weightGrams / 1000).toFixed(2)} kg</s-table-cell>
                  <s-table-cell>{formatMoney(q.cost, currency)}</s-table-cell>
                  <s-table-cell>{formatMoney(q.savings, currency)}</s-table-cell>
                  <s-table-cell>{new Date(q.createdAt).toLocaleString()}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

// Single-series bar chart: one hue, no legend (the section heading names it),
// 4px rounded tops, per-bar hover tooltip and a text summary for screen readers.
function SavingsChart({
  daily,
  currency,
}: {
  daily: { date: string; savings: number; quotes: number }[];
  currency: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 180;
  const pad = { top: 12, right: 8, bottom: 22, left: 8 };
  const max = Math.max(...daily.map((d) => d.savings), 1);
  const slot = (width - pad.left - pad.right) / daily.length;
  const barW = Math.max(2, slot - 2); // 2px surface gap between bars
  const plotH = height - pad.top - pad.bottom;
  const total = daily.reduce((s, d) => s + d.savings, 0);
  const active = hover != null ? daily[hover] : null;

  if (total === 0) {
    return <s-text color="subdued">Savings will chart here once rates are served.</s-text>;
  }

  return (
    <s-stack gap="small-200">
      <s-text color="subdued">
        {active
          ? `${new Date(active.date + "T00:00:00").toLocaleDateString()}: ${formatMoney(active.savings, currency)} saved across ${active.quotes} request${active.quotes === 1 ? "" : "s"}`
          : `Peak day ${formatMoney(max, currency)} · hover a bar for details`}
      </s-text>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={`Daily estimated savings over the last ${daily.length} days, totaling ${formatMoney(total, currency)}`}
        style={{ display: "block", maxHeight: 220 }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} stroke="#d4d4d4" strokeWidth={1} />
        {daily.map((d, i) => {
          const h = d.savings > 0 ? Math.max(2, (d.savings / max) * plotH) : 0;
          const x = pad.left + i * slot + 1;
          const y = pad.top + plotH - h;
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              {/* Full-height hit target, wider than the mark */}
              <rect x={pad.left + i * slot} y={pad.top} width={slot} height={plotH} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z`}
                  fill="#2a7d5b"
                  opacity={hover == null || hover === i ? 1 : 0.45}
                />
              )}
            </g>
          );
        })}
        {[0, Math.floor(daily.length / 2), daily.length - 1].map((i) => (
          <text
            key={i}
            x={pad.left + i * slot + slot / 2}
            y={height - 6}
            fontSize={11}
            fill="#6b6b6b"
            textAnchor={i === 0 ? "start" : i === daily.length - 1 ? "end" : "middle"}
          >
            {new Date(daily[i].date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </text>
        ))}
      </svg>
    </s-stack>
  );
}

function Metric({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        <s-text color="subdued">{children}</s-text>
      </s-stack>
    </s-box>
  );
}

function StatusRow({ label, ok, children }: { label: string; ok: boolean; children: React.ReactNode }) {
  return (
    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
      <s-text>{label}</s-text>
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-badge tone={ok ? "success" : "warning"} icon={ok ? "check-circle" : "alert-circle"}>
          {ok ? "OK" : "Action needed"}
        </s-badge>
        <s-text color="subdued">{children}</s-text>
      </s-stack>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
