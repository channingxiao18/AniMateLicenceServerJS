/**
 * Seed the default lifetime product SKU on first run.
 * Equivalent to Python database.init_db() default product.
 */

import { eq } from "drizzle-orm";
import { products } from "./schema";
import type { Database } from "./index";

export const DEFAULT_PRODUCT_ID = "animate-companion-lifetime-basic-v1";

export async function seedDefaultProduct(db: Database): Promise<void> {
  const existing = await db
    .select()
    .from(products)
    .where(eq(products.productId, DEFAULT_PRODUCT_ID))
    .get();

  if (!existing) {
    await db.insert(products).values({
      productId: DEFAULT_PRODUCT_ID,
      name: "AniMate Companion Lifetime Basic",
      edition: "companion",
      tier: "basic",
      type: "lifetime",
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
}
