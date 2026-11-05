require("dotenv").config();
const mongoose = require("mongoose");
const CatalogProduct = require("../models/CatalogProduct");
const { DEMO_MERCHANT } = require("../config/demoStore");

const products = [
  {
    sku: "USB-C-HUB-7P",
    name: "7-Port USB-C Workshop Hub",
    description: "Demo inventory USB-C hub with HDMI, USB-A, and power pass-through.",
    category: "connectivity",
    unitPriceMinor: 2499,
    stock: 50,
    attributes: [{ name: "ports", value: "HDMI, USB-A, USB-C power" }],
    compatibilityTags: ["usb-c-host", "hdmi-output"],
  },
  {
    sku: "USB-C-CABLE-2M",
    name: "2m USB-C Cable",
    description: "Demo inventory USB-C charging and data cable.",
    category: "connectivity",
    unitPriceMinor: 899,
    stock: 100,
    attributes: [{ name: "length", value: "2m" }],
    compatibilityTags: ["usb-c"],
  },
  {
    sku: "MICROCONTROLLER-KIT",
    name: "Beginner Microcontroller Kit",
    description: "Demo inventory starter kit with a microcontroller board and basic components.",
    category: "electronics",
    unitPriceMinor: 2499,
    stock: 40,
    attributes: [{ name: "level", value: "beginner" }],
    compatibilityTags: ["usb-c", "coding-workshop", "electronics"],
  },
  {
    sku: "BREADBOARD-SET",
    name: "Breadboard and Jumper Set",
    description: "Demo inventory solderless breadboard and jumper-wire set.",
    category: "electronics",
    unitPriceMinor: 1299,
    stock: 45,
    attributes: [{ name: "level", value: "beginner" }],
    compatibilityTags: ["electronics", "microcontroller-kit"],
  },
  {
    sku: "NOTEBOOK-A5",
    name: "A5 Workshop Notebook",
    description: "Demo inventory ruled notebook for workshop notes.",
    category: "stationery",
    unitPriceMinor: 399,
    stock: 120,
    attributes: [{ name: "size", value: "A5" }],
    compatibilityTags: ["workshop", "stationery"],
  },
  {
    sku: "MARKER-SET-4",
    name: "Four-Color Whiteboard Marker Set",
    description: "Demo inventory dry-erase markers in four colors.",
    category: "stationery",
    unitPriceMinor: 799,
    stock: 35,
    attributes: [{ name: "colors", value: "black, blue, green, red" }],
    compatibilityTags: ["whiteboard", "workshop"],
  },
  {
    sku: "POWER-STRIP-6",
    name: "Six-Outlet Power Strip",
    description: "Demo inventory grounded power strip with six outlets.",
    category: "power",
    unitPriceMinor: 1999,
    stock: 20,
    attributes: [{ name: "outlets", value: "6" }],
    compatibilityTags: ["power", "shared-equipment"],
  },
  {
    sku: "PORTABLE-PROJECTOR",
    name: "Portable Workshop Projector",
    description: "Demo inventory portable projector with HDMI input.",
    category: "presentation",
    unitPriceMinor: 18999,
    stock: 4,
    attributes: [{ name: "input", value: "HDMI" }],
    compatibilityTags: ["hdmi-output", "presentation", "shared-equipment"],
  },
];

async function seedCatalog() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required to seed the demo catalog.");
  }

  await mongoose.connect(process.env.MONGODB_URI);
  for (const product of products) {
    await CatalogProduct.updateOne(
      { sku: product.sku },
      {
        $setOnInsert: {
          ...product,
          currency: DEMO_MERCHANT.currency,
          catalogVersion: DEMO_MERCHANT.catalogVersion,
          merchantId: DEMO_MERCHANT.id,
          merchantName: DEMO_MERCHANT.name,
          reservedQuantity: 0,
          active: true,
          imagePath: "",
        },
      },
      { upsert: true, runValidators: true }
    );
  }
  console.log(`Demo catalog seeded or already present: ${products.length} curated SKUs.`);
}

seedCatalog()
  .catch((err) => {
    console.error("Could not seed the demo catalog:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
