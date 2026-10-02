import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  activateCarrierService,
  deactivateCarrierService,
  getSettings,
  syncOrigins,
} from "../lib/admin.server";
import { CARRIERS, CARRIER_KEYS, TIERS, TIER_KEYS, parseList } from "../lib/carriers";
import { clearRateCache } from "../lib/optimizer.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const origins = await db.shipOrigin.findMany({
    where: { shop: session.shop },
    orderBy: { name: "asc" },
  });
  return {
    settings: {
      ...settings,
      easypostApiKey: settings.easypostApiKey ? "••••••••" : "",
      carriers: parseList(settings.enabledCarriers, CARRIER_KEYS),
      tiers: parseList(settings.enabledTiers, TIER_KEYS),
    },
    origins,
  };
};

const num = (form: FormData, key: string, fallback: number) => {
  const n = Number(form.get(key));
  return Number.isFinite(n) && String(form.get(key) ?? "") !== "" ? n : fallback;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  try {
    switch (intent) {
      case "activate":
        await syncOrigins(admin, shop);
        await activateCarrierService(admin, shop);
        return { ok: "Optimized rates are live at checkout" };
      case "deactivate":
        await deactivateCarrierService(admin, shop);
        return { ok: "Removed from checkout" };
      case "sync": {
        const count = await syncOrigins(admin, shop);
        return { ok: `Synced ${count} location${count === 1 ? "" : "s"}` };
      }
      case "toggleOrigin":
        await db.shipOrigin.updateMany({
          where: { shop, id: String(form.get("id")) },
          data: { enabled: form.get("enabled") === "true" },
        });
        return { ok: "Location updated" };
      case "save": {
        const current = await getSettings(shop);
        const carriers = parseList(form.getAll("carriers").join(","), CARRIER_KEYS);
        const tiers = parseList(form.getAll("tiers").join(","), TIER_KEYS);
        if (carriers.length === 0) return { error: "Enable at least one carrier" };
        if (tiers.length === 0) return { error: "Offer at least one service level" };
        const key = String(form.get("easypostApiKey") ?? "");
        const provider = form.get("provider") === "EASYPOST" ? "EASYPOST" : "SIMULATED";
        if (provider === "EASYPOST" && !key && !current.easypostApiKey) {
          return { error: "Enter an EasyPost API key to use live rates" };
        }

        await db.shopSettings.update({
          where: { shop },
          data: {
            provider,
            // The masked placeholder means "keep the stored key".
            easypostApiKey: key && !key.startsWith("•") ? key : current.easypostApiKey,
            baselineCarrier: parseList(String(form.get("baselineCarrier")), CARRIER_KEYS)[0] ?? "UPS",
            enabledCarriers: carriers.join(","),
            enabledTiers: tiers.join(","),
            routingMode: form.get("routingMode") === "SHOPIFY_ORIGIN" ? "SHOPIFY_ORIGIN" : "CHEAPEST_LOCATION",
            stockAwareRouting: form.get("stockAwareRouting") === "true",
            showCarrierName: form.get("showCarrierName") === "true",
            markupPercent: num(form, "markupPercent", 0),
            handlingFee: Math.max(0, num(form, "handlingFee", 0)),
            boxLengthIn: Math.max(1, num(form, "boxLengthIn", current.boxLengthIn)),
            boxWidthIn: Math.max(1, num(form, "boxWidthIn", current.boxWidthIn)),
            boxHeightIn: Math.max(1, num(form, "boxHeightIn", current.boxHeightIn)),
            packagingGrams: Math.max(0, Math.round(num(form, "packagingGrams", current.packagingGrams))),
            cacheTtlSeconds: Math.min(86_400, Math.max(0, Math.round(num(form, "cacheTtlSeconds", 900)))),
          },
        });
        clearRateCache(shop);
        return { ok: "Settings saved" };
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Something went wrong" };
  }
  return { error: "Unknown action" };
};

export default function Settings() {
  const { settings, origins } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const busy = (intent: string) =>
    navigation.state === "submitting" && navigation.formData?.get("intent") === intent
      ? { loading: true }
      : {};

  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.ok) shopify.toast.show(actionData.ok);
  }, [actionData, shopify]);

  return (
    <s-page heading="Settings" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Dashboard
      </s-link>
      <s-stack gap="base">
        {actionData && "error" in actionData && (
          <s-banner tone="critical">{actionData.error}</s-banner>
        )}

        <s-section heading="Checkout">
          <s-stack gap="base">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-badge tone={settings.checkoutActive ? "success" : "neutral"}>
                {settings.checkoutActive ? "Live" : "Off"}
              </s-badge>
              <s-text>
                {settings.checkoutActive
                  ? "Shoppers see the cheapest carrier for each service level."
                  : "Register the optimizer as a carrier service to price shipping at checkout."}
              </s-text>
            </s-stack>
            <s-paragraph color="subdued">
              Carrier-calculated shipping is available on development stores,
              Advanced and Plus plans, or as a paid add-on. After activating, add
              “Shipping Cost Optimizer” rates to your shipping zones under
              Settings → Shipping and delivery.
            </s-paragraph>
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value={settings.checkoutActive ? "deactivate" : "activate"}
              />
              <s-button
                type="submit"
                variant={settings.checkoutActive ? "secondary" : "primary"}
                tone={settings.checkoutActive ? "critical" : undefined}
                {...busy(settings.checkoutActive ? "deactivate" : "activate")}
              >
                {settings.checkoutActive ? "Remove from checkout" : "Activate at checkout"}
              </s-button>
            </Form>
          </s-stack>
        </s-section>

        <s-section heading="Fulfillment locations">
          <s-stack gap="base">
            <s-paragraph color="subdued">
              With cheapest-location routing, every enabled location is quoted
              and the order ships from whichever is cheapest to the shopper.
            </s-paragraph>
            {origins.length === 0 ? (
              <s-text color="subdued">No locations synced yet.</s-text>
            ) : (
              <s-stack gap="small-200">
                {origins.map((o) => (
                  <Form method="post" key={o.id}>
                    <input type="hidden" name="intent" value="toggleOrigin" />
                    <input type="hidden" name="id" value={o.id} />
                    <input type="hidden" name="enabled" value={String(!o.enabled)} />
                    <s-stack direction="inline" justifyContent="space-between" alignItems="center">
                      <s-stack gap="none">
                        <s-text type="strong">{o.name}</s-text>
                        <s-text color="subdued">
                          {[o.city, o.province, o.zip, o.countryCode].filter(Boolean).join(", ")}
                        </s-text>
                      </s-stack>
                      <s-button type="submit" variant="tertiary">
                        {o.enabled ? "Disable" : "Enable"}
                      </s-button>
                    </s-stack>
                  </Form>
                ))}
              </s-stack>
            )}
            <Form method="post">
              <input type="hidden" name="intent" value="sync" />
              <s-button type="submit" {...busy("sync")}>
                Sync locations from Shopify
              </s-button>
            </Form>
          </s-stack>
        </s-section>

        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          <s-stack gap="base">
            <s-section heading="Rate source">
              <s-stack gap="base">
                <s-select label="Provider" name="provider" value={settings.provider}>
                  <s-option value="SIMULATED">Built-in list rates (no account needed)</s-option>
                  <s-option value="EASYPOST">EasyPost live rates</s-option>
                </s-select>
                <s-password-field
                  label="EasyPost API key"
                  name="easypostApiKey"
                  defaultValue={settings.easypostApiKey}
                  details="Rates come from the carrier accounts linked to this key. If EasyPost fails, list rates are used so checkout never breaks."
                />
                <s-number-field
                  label="Rate cache lifetime"
                  name="cacheTtlSeconds"
                  defaultValue={String(settings.cacheTtlSeconds)}
                  min={0}
                  max={86400}
                  suffix="seconds"
                  details="0 fetches fresh rates on every request"
                />
              </s-stack>
            </s-section>

            <s-section heading="Carriers and service levels">
              <s-stack gap="base">
                <s-choice-list label="Compare these carriers" name="carriers" multiple>
                  {CARRIER_KEYS.map((c) => (
                    <s-choice key={c} value={c} selected={settings.carriers.includes(c)}>
                      {CARRIERS[c].label}
                    </s-choice>
                  ))}
                </s-choice-list>
                <s-choice-list label="Offer at checkout" name="tiers" multiple>
                  {TIER_KEYS.map((t) => (
                    <s-choice key={t} value={t} selected={settings.tiers.includes(t)}>
                      {TIERS[t].label}
                    </s-choice>
                  ))}
                </s-choice-list>
                <s-select
                  label="Carrier you used before"
                  name="baselineCarrier"
                  value={settings.baselineCarrier}
                  details="Savings are measured against what this carrier would have charged"
                >
                  {CARRIER_KEYS.map((c) => (
                    <s-option key={c} value={c}>
                      {CARRIERS[c].label}
                    </s-option>
                  ))}
                </s-select>
              </s-stack>
            </s-section>

            <s-section heading="Routing">
              <s-stack gap="base">
                <s-select label="Ship from" name="routingMode" value={settings.routingMode}>
                  <s-option value="CHEAPEST_LOCATION">Cheapest enabled location</s-option>
                  <s-option value="SHOPIFY_ORIGIN">Location Shopify chooses</s-option>
                </s-select>
                <s-checkbox
                  label="Only route from locations with stock for every item"
                  name="stockAwareRouting"
                  value="true"
                  defaultChecked={settings.stockAwareRouting}
                />
              </s-stack>
            </s-section>

            <s-section heading="Pricing shown to shoppers">
              <s-stack gap="base">
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-number-field
                    label="Markup"
                    name="markupPercent"
                    defaultValue={String(settings.markupPercent)}
                    suffix="%"
                    details="Negative values subsidize shipping"
                  />
                  <s-number-field
                    label="Handling fee"
                    name="handlingFee"
                    defaultValue={String(settings.handlingFee)}
                    min={0}
                  />
                </s-grid>
                <s-checkbox
                  label="Show carrier and service name at checkout"
                  name="showCarrierName"
                  value="true"
                  defaultChecked={settings.showCarrierName}
                />
              </s-stack>
            </s-section>

            <s-section heading="Default package">
              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(120px, 1fr))" gap="base">
                <s-number-field label="Length" name="boxLengthIn" defaultValue={String(settings.boxLengthIn)} min={1} suffix="in" />
                <s-number-field label="Width" name="boxWidthIn" defaultValue={String(settings.boxWidthIn)} min={1} suffix="in" />
                <s-number-field label="Height" name="boxHeightIn" defaultValue={String(settings.boxHeightIn)} min={1} suffix="in" />
                <s-number-field label="Packaging weight" name="packagingGrams" defaultValue={String(settings.packagingGrams)} min={0} suffix="g" />
              </s-grid>
            </s-section>

            <s-stack direction="inline" justifyContent="end">
              <s-button variant="primary" type="submit" {...busy("save")}>
                Save settings
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
