import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopContext } from "../lib/admin.server";
import { CARRIERS, CARRIER_KEYS, TIERS, TIER_KEYS, parseList } from "../lib/carriers";
import { RULE_ACTIONS, describeConditions, describeRule, type RuleAction } from "../lib/rules";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [rules, context] = await Promise.all([
    db.shippingRule.findMany({
      where: { shop: session.shop },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    }),
    getShopContext(admin),
  ]);
  const currency = context.shop.currencyCode;
  return {
    rules: rules.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      enabled: r.enabled,
      summary: describeRule(r),
      conditions: describeConditions(r, currency),
    })),
  };
};

const optionalNumber = (value: FormDataEntryValue | null) => {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const id = String(form.get("id") ?? "");

  if (intent === "delete") {
    await db.shippingRule.deleteMany({ where: { id, shop } });
    return { ok: "Rule deleted" };
  }
  if (intent === "toggle") {
    await db.shippingRule.updateMany({
      where: { id, shop },
      data: { enabled: form.get("enabled") === "true" },
    });
    return { ok: "Rule updated" };
  }

  const errors: Record<string, string> = {};
  const name = String(form.get("name") ?? "").trim();
  const action = String(form.get("action")) as RuleAction;
  const spec = RULE_ACTIONS[action];
  if (!name) errors.name = "Give the rule a name";
  if (!spec) errors.action = "Choose an action";

  const carrier = parseList(String(form.get("carrier") ?? ""), CARRIER_KEYS)[0] ?? null;
  const tier = parseList(String(form.get("tier") ?? ""), TIER_KEYS)[0] ?? null;
  if (spec?.needsCarrier && !carrier) errors.carrier = "Choose a carrier";
  if (action === "HIDE_TIER" && !tier) errors.tier = "Choose a service level";

  const numbers = {
    priority: optionalNumber(form.get("priority")),
    value: optionalNumber(form.get("value")),
    minWeightG: optionalNumber(form.get("minWeightG")),
    maxWeightG: optionalNumber(form.get("maxWeightG")),
    minSubtotal: optionalNumber(form.get("minSubtotal")),
    maxSubtotal: optionalNumber(form.get("maxSubtotal")),
  };
  for (const [key, n] of Object.entries(numbers)) {
    if (Number.isNaN(n)) errors[key] = "Enter a number";
  }
  if (spec?.valueLabel && numbers.value == null) errors.value = "Required for this action";
  if (Object.keys(errors).length) return { errors };

  const countries = String(form.get("countries") ?? "")
    .split(/[,\s]+/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));

  await db.shippingRule.create({
    data: {
      shop,
      name,
      action,
      priority: numbers.priority ?? 100,
      carrier: spec.needsCarrier ? carrier : null,
      tier: spec.needsTier ? tier : null,
      value: spec.valueLabel ? numbers.value : null,
      countries: countries.length ? countries.join(",") : null,
      minWeightG: numbers.minWeightG,
      maxWeightG: numbers.maxWeightG,
      minSubtotal: numbers.minSubtotal,
      maxSubtotal: numbers.maxSubtotal,
    },
  });
  return { ok: "Rule created", created: true };
};

export default function Rules() {
  const { rules } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: Record<string, string | undefined> =
    (actionData && "errors" in actionData && actionData.errors) || {};
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [ruleAction, setRuleAction] = useState<RuleAction>("PREFER_CARRIER");
  const [formKey, setFormKey] = useState(0);
  const spec = RULE_ACTIONS[ruleAction];
  const saving = navigation.state === "submitting" && navigation.formData?.get("intent") === "create";

  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.ok) {
      shopify.toast.show(actionData.ok);
      if ("created" in actionData) setFormKey((k) => k + 1);
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Carrier rules" inlineSize="base">
      <s-link slot="breadcrumb-actions" href="/app">
        Dashboard
      </s-link>
      <s-stack gap="base">
        <s-section heading="Active rules">
          {rules.length === 0 ? (
            <s-paragraph color="subdued">
              No rules yet: the cheapest carrier wins every service level. Add
              rules to steer volume to a carrier, block one for certain lanes, or
              offer free shipping above a threshold.
            </s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Rule</s-table-header>
                <s-table-header>When</s-table-header>
                <s-table-header format="numeric">Priority</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rules.map((r) => (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      <s-stack gap="none">
                        <s-text type="strong">{r.name}</s-text>
                        <s-text color="subdued">{r.summary}</s-text>
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{r.conditions}</s-table-cell>
                    <s-table-cell>{r.priority}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={r.enabled ? "success" : "neutral"}>
                        {r.enabled ? "On" : "Paused"}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200">
                        <Form method="post">
                          <input type="hidden" name="intent" value="toggle" />
                          <input type="hidden" name="id" value={r.id} />
                          <input type="hidden" name="enabled" value={String(!r.enabled)} />
                          <s-button type="submit" variant="tertiary">
                            {r.enabled ? "Pause" : "Resume"}
                          </s-button>
                        </Form>
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="id" value={r.id} />
                          <s-button type="submit" variant="tertiary" tone="critical">
                            Delete
                          </s-button>
                        </Form>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>

        <Form method="post" key={formKey}>
          <input type="hidden" name="intent" value="create" />
          <s-section heading="Add a rule">
            <s-stack gap="base">
              <s-grid gridTemplateColumns="2fr 1fr" gap="base">
                <s-text-field label="Name" name="name" placeholder="Prefer UPS for heavy parcels" error={errors.name} />
                <s-number-field label="Priority" name="priority" defaultValue="100" step={1} details="Lower runs first" error={errors.priority} />
              </s-grid>

              <s-select
                label="Action"
                name="action"
                value={ruleAction}
                error={errors.action}
                onChange={(e) => setRuleAction(e.currentTarget.value as RuleAction)}
              >
                {Object.entries(RULE_ACTIONS).map(([key, a]) => (
                  <s-option key={key} value={key}>
                    {a.label}
                  </s-option>
                ))}
              </s-select>

              <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
                {spec.needsCarrier && (
                  <s-select label="Carrier" name="carrier" error={errors.carrier}>
                    {CARRIER_KEYS.map((c) => (
                      <s-option key={c} value={c}>
                        {CARRIERS[c].label}
                      </s-option>
                    ))}
                  </s-select>
                )}
                {spec.needsTier && (
                  <s-select label="Service level" name="tier" error={errors.tier}>
                    {ruleAction === "FREE_SHIPPING" && <s-option value="">All service levels</s-option>}
                    {TIER_KEYS.map((t) => (
                      <s-option key={t} value={t}>
                        {TIERS[t].label}
                      </s-option>
                    ))}
                  </s-select>
                )}
                {spec.valueLabel && (
                  <s-number-field
                    label={spec.valueLabel}
                    name="value"
                    suffix="%"
                    defaultValue={ruleAction === "PREFER_CARRIER" ? "10" : ""}
                    error={errors.value}
                  />
                )}
              </s-grid>

              <s-heading>Conditions (optional)</s-heading>
              <s-text-field
                label="Destination countries"
                name="countries"
                placeholder="US, CA"
                details="Two-letter codes. Leave empty for all destinations."
              />
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-number-field label="Min package weight" name="minWeightG" suffix="g" min={0} error={errors.minWeightG} />
                <s-number-field label="Max package weight" name="maxWeightG" suffix="g" min={0} error={errors.maxWeightG} />
                <s-number-field label="Min cart subtotal" name="minSubtotal" min={0} error={errors.minSubtotal} />
                <s-number-field label="Max cart subtotal" name="maxSubtotal" min={0} error={errors.maxSubtotal} />
              </s-grid>

              <s-stack direction="inline" justifyContent="end">
                <s-button variant="primary" type="submit" {...(saving ? { loading: true } : {})}>
                  Add rule
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        </Form>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
