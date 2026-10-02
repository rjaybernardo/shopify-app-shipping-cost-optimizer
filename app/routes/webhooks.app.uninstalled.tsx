import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Shopify removes the carrier service itself on uninstall; drop our shop data too.
  await db.$transaction([
    db.shopSettings.deleteMany({ where: { shop } }),
    db.shipOrigin.deleteMany({ where: { shop } }),
    db.shippingRule.deleteMany({ where: { shop } }),
    db.rateQuote.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
