/**
 * Seed the default AniMate product and lifetime plan.
 */

import { eq } from "drizzle-orm";
import type { Database } from "./index";
import { plans, products, providerMappings } from "./schema";

export const DEFAULT_PRODUCT_ID = "animate";
export const DEFAULT_PLAN_ID = "animate-companion-lifetime-basic-v1";

export async function seedDefaultProduct(db: Database): Promise<void> {
  const existingProduct = await db
    .select()
    .from(products)
    .where(eq(products.productId, DEFAULT_PRODUCT_ID))
    .get();

  if (!existingProduct) {
    await db.insert(products).values({
      productId: DEFAULT_PRODUCT_ID,
      name: "AniMate",
      status: "active",
      sortOrder: 0,
    });
  }

  const existingPlan = await db
    .select()
    .from(plans)
    .where(eq(plans.planId, DEFAULT_PLAN_ID))
    .get();

  if (!existingPlan) {
    await db.insert(plans).values({
      planId: DEFAULT_PLAN_ID,
      productId: DEFAULT_PRODUCT_ID,
      name: "AniMate Companion Lifetime Basic",
      edition: "companion",
      tier: "basic",
      billingModel: "lifetime",
      licenseModel: "single_machine",
      maxActivations: 1,
      maxAppMajor: 1,
      featuresJson: JSON.stringify([
        "companion",
        "import_vrm",
        "import_dance",
        "import_stage",
      ]),
      isActive: true,
      sortOrder: 0,
    });
  }

  const creemDefaultMapping = await db
    .select()
    .from(providerMappings)
    .where(eq(providerMappings.provider, "creem"))
    .get();

  if (!creemDefaultMapping) {
    await db.insert(providerMappings).values({
      provider: "creem",
      externalProductId: null,
      externalVariantId: null,
      localPlanId: DEFAULT_PLAN_ID,
      isActive: true,
      metadataJson: JSON.stringify({ fallback: true }),
    });
  }
}
