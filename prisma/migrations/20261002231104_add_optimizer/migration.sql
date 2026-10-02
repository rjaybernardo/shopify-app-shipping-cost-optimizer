-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "callbackToken" TEXT NOT NULL,
    "carrierServiceId" TEXT,
    "checkoutActive" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'SIMULATED',
    "easypostApiKey" TEXT,
    "baselineCarrier" TEXT NOT NULL DEFAULT 'UPS',
    "enabledCarriers" TEXT NOT NULL DEFAULT 'USPS,UPS,FEDEX,DHL',
    "enabledTiers" TEXT NOT NULL DEFAULT 'ECONOMY,STANDARD,EXPRESS',
    "routingMode" TEXT NOT NULL DEFAULT 'CHEAPEST_LOCATION',
    "stockAwareRouting" BOOLEAN NOT NULL DEFAULT true,
    "showCarrierName" BOOLEAN NOT NULL DEFAULT true,
    "markupPercent" REAL NOT NULL DEFAULT 0,
    "handlingFee" REAL NOT NULL DEFAULT 0,
    "boxLengthIn" REAL NOT NULL DEFAULT 12,
    "boxWidthIn" REAL NOT NULL DEFAULT 9,
    "boxHeightIn" REAL NOT NULL DEFAULT 6,
    "packagingGrams" INTEGER NOT NULL DEFAULT 150,
    "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 900,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShipOrigin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "province" TEXT,
    "zip" TEXT,
    "countryCode" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ShippingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "countries" TEXT,
    "minWeightG" INTEGER,
    "maxWeightG" INTEGER,
    "minSubtotal" REAL,
    "maxSubtotal" REAL,
    "action" TEXT NOT NULL,
    "carrier" TEXT,
    "tier" TEXT,
    "value" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RateQuote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "destCountry" TEXT NOT NULL,
    "destZip" TEXT,
    "weightGrams" INTEGER NOT NULL,
    "originName" TEXT,
    "tier" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "cost" REAL NOT NULL,
    "baselineCost" REAL NOT NULL,
    "savings" REAL NOT NULL,
    "customerPrice" REAL NOT NULL,
    "quotesCompared" INTEGER NOT NULL,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_callbackToken_key" ON "ShopSettings"("callbackToken");

-- CreateIndex
CREATE UNIQUE INDEX "ShipOrigin_shop_locationId_key" ON "ShipOrigin"("shop", "locationId");

-- CreateIndex
CREATE INDEX "ShippingRule_shop_idx" ON "ShippingRule"("shop");

-- CreateIndex
CREATE INDEX "RateQuote_shop_createdAt_idx" ON "RateQuote"("shop", "createdAt");
