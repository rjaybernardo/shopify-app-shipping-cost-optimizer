import { randomBytes } from "node:crypto";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

type Admin = AdminApiContext;

interface UserError {
  field?: string[] | null;
  message: string;
}

export const CARRIER_SERVICE_NAME = "Shipping Cost Optimizer";

async function run<T>(admin: Admin, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await admin.graphql(query, { variables });
  const json = (await response.json()) as { data: T };
  return json.data;
}

function assertNoErrors(userErrors: UserError[] | undefined) {
  if (userErrors && userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join("; "));
  }
}

export async function getSettings(shop: string) {
  return (
    (await db.shopSettings.findUnique({ where: { shop } })) ??
    db.shopSettings.create({
      data: { shop, callbackToken: randomBytes(24).toString("hex") },
    })
  );
}

export function callbackUrl(token: string) {
  return `${process.env.SHOPIFY_APP_URL}/carrier/rates/${token}`;
}

interface ShopContext {
  shop: { name: string; currencyCode: string };
  locations: {
    nodes: {
      id: string;
      name: string;
      isActive: boolean;
      fulfillsOnlineOrders: boolean;
      address: { city: string | null; provinceCode: string | null; zip: string | null; countryCode: string };
    }[];
  };
  carrierServices: { nodes: { id: string; name: string; callbackUrl: string | null; active: boolean }[] };
}

export async function getShopContext(admin: Admin) {
  return run<ShopContext>(
    admin,
    `#graphql
    query ScoShopContext {
      shop { name currencyCode }
      locations(first: 50) {
        nodes {
          id
          name
          isActive
          fulfillsOnlineOrders
          address { city provinceCode zip countryCode }
        }
      }
      carrierServices(first: 20) {
        nodes { id name callbackUrl active }
      }
    }`,
  );
}

// Mirrors active, online-fulfilling locations into ShipOrigin, keeping each
// origin's enabled flag across syncs.
export async function syncOrigins(admin: Admin, shop: string) {
  const { locations } = await getShopContext(admin);
  const usable = locations.nodes.filter((l) => l.isActive && l.fulfillsOnlineOrders);

  await db.$transaction([
    db.shipOrigin.deleteMany({
      where: { shop, locationId: { notIn: usable.map((l) => l.id) } },
    }),
    ...usable.map((l) =>
      db.shipOrigin.upsert({
        where: { shop_locationId: { shop, locationId: l.id } },
        create: {
          shop,
          locationId: l.id,
          name: l.name,
          city: l.address.city,
          province: l.address.provinceCode,
          zip: l.address.zip,
          countryCode: l.address.countryCode,
        },
        update: {
          name: l.name,
          city: l.address.city,
          province: l.address.provinceCode,
          zip: l.address.zip,
          countryCode: l.address.countryCode,
          syncedAt: new Date(),
        },
      }),
    ),
  ]);
  return usable.length;
}

// Creates (or re-points and re-activates) the app's carrier service so the
// optimizer's rates appear at checkout.
export async function activateCarrierService(admin: Admin, shop: string) {
  const settings = await getSettings(shop);
  const url = callbackUrl(settings.callbackToken);
  const { carrierServices } = await getShopContext(admin);
  const existing = carrierServices.nodes.find(
    (c) => c.id === settings.carrierServiceId || c.name === CARRIER_SERVICE_NAME,
  );

  let id: string;
  if (existing) {
    const data = await run<{
      carrierServiceUpdate: { carrierService: { id: string } | null; userErrors: UserError[] };
    }>(
      admin,
      `#graphql
      mutation ScoCarrierServiceUpdate($input: DeliveryCarrierServiceUpdateInput!) {
        carrierServiceUpdate(input: $input) {
          carrierService { id active callbackUrl }
          userErrors { field message }
        }
      }`,
      { input: { id: existing.id, active: true, callbackUrl: url } },
    );
    assertNoErrors(data.carrierServiceUpdate.userErrors);
    id = existing.id;
  } else {
    const data = await run<{
      carrierServiceCreate: { carrierService: { id: string } | null; userErrors: UserError[] };
    }>(
      admin,
      `#graphql
      mutation ScoCarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
        carrierServiceCreate(input: $input) {
          carrierService { id name callbackUrl active }
          userErrors { field message }
        }
      }`,
      {
        input: {
          name: CARRIER_SERVICE_NAME,
          callbackUrl: url,
          active: true,
          supportsServiceDiscovery: true,
        },
      },
    );
    assertNoErrors(data.carrierServiceCreate.userErrors);
    id = data.carrierServiceCreate.carrierService!.id;
  }

  await db.shopSettings.update({
    where: { shop },
    data: { carrierServiceId: id, checkoutActive: true },
  });
}

export async function deactivateCarrierService(admin: Admin, shop: string) {
  const settings = await getSettings(shop);
  if (settings.carrierServiceId) {
    const data = await run<{
      carrierServiceDelete: { deletedId: string | null; userErrors: UserError[] };
    }>(
      admin,
      `#graphql
      mutation ScoCarrierServiceDelete($id: ID!) {
        carrierServiceDelete(id: $id) {
          deletedId
          userErrors { field message }
        }
      }`,
      { id: settings.carrierServiceId },
    );
    assertNoErrors(data.carrierServiceDelete.userErrors);
  }
  await db.shopSettings.update({
    where: { shop },
    data: { carrierServiceId: null, checkoutActive: false },
  });
}

interface VariantStock {
  nodes: ({
    id: string;
    inventoryItem: {
      tracked: boolean;
      inventoryLevels: {
        nodes: { location: { id: string }; quantities: { name: string; quantity: number }[] }[];
      };
    };
  } | null)[];
}

// Location IDs that hold enough available stock for every line, or null when
// any line is untracked (meaning stock should not constrain routing).
export async function locationsWithStock(
  admin: Admin,
  lines: { variantId: number | string; quantity: number }[],
): Promise<Set<string> | null> {
  if (lines.length === 0) return null;
  const ids = lines.map((l) => `gid://shopify/ProductVariant/${l.variantId}`);
  const data = await run<VariantStock>(
    admin,
    `#graphql
    query ScoVariantStock($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          inventoryItem {
            tracked
            inventoryLevels(first: 50) {
              nodes {
                location { id }
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }`,
    { ids },
  );

  let result = null as Set<string> | null;
  for (const [index, node] of data.nodes.entries()) {
    if (!node || !node.inventoryItem.tracked) return null;
    const needed = lines[index].quantity;
    const stocked = new Set(
      node.inventoryItem.inventoryLevels.nodes
        .filter((l) => (l.quantities[0]?.quantity ?? 0) >= needed)
        .map((l) => l.location.id),
    );
    result = result ? new Set([...result].filter((id) => stocked.has(id))) : stocked;
  }
  return result;
}

export interface VariantOption {
  id: string;
  displayName: string;
  price: string;
  grams: number;
}

const TO_GRAMS: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.3495, POUNDS: 453.592 };

export async function searchVariants(admin: Admin, query: string): Promise<VariantOption[]> {
  const data = await run<{
    productVariants: {
      nodes: {
        id: string;
        displayName: string;
        price: string;
        inventoryItem: { measurement: { weight: { value: number; unit: string } | null } | null };
      }[];
    };
  }>(
    admin,
    `#graphql
    query ScoVariantSearch($query: String) {
      productVariants(first: 15, query: $query) {
        nodes {
          id
          displayName
          price
          inventoryItem {
            measurement { weight { value unit } }
          }
        }
      }
    }`,
    { query: query || null },
  );
  return data.productVariants.nodes.map((v) => {
    const w = v.inventoryItem.measurement?.weight;
    return {
      id: v.id,
      displayName: v.displayName,
      price: v.price,
      grams: w ? Math.round(w.value * (TO_GRAMS[w.unit] ?? 1)) : 0,
    };
  });
}
