/* ================================================================
   NAFUME — Collection Service (Upgrade 6)
   Provides collection data, product filtering, and SEO content.
   Depends on: window.LAUNCH_PRODUCTS (from launch.js)
   Usage:  window.CollectionService.getProductsByCollection('best-sellers')
   ================================================================ */

(function () {

  // ── 13 Named Collections ─────────────────────────────────────────
  var COLLECTIONS = [
    {
      slug:        "new-launches",
      title:       "New Launches",
      subtitle:    "Our latest Eau De Parfum collection",
      description: "The complete NAFUME debut range — 5 premium Eau De Parfum fragrances crafted for everyday confidence, special occasions, and everything in between.",
      badge:       "New",
      type:        "product",
      sortOrder:   1,
      icon:        "🌟",
      seoTitle:    "New Launch Perfumes — NAFUME Artisan Luxe",
      seoDescription: "Explore all 5 new launch perfumes from NAFUME. Premium Eau De Parfum blends crafted for Indian weather. Shop online, confirm on WhatsApp.",
      faqItems: [
        { q: "Are these perfumes really new?", a: "Yes. All 5 fragrances are from NAFUME's debut launch — crafted fresh with premium ingredients." },
        { q: "Do new launches have discounts?", a: "Yes. All new launch fragrances are available at ₹799 during our Summer Sale (MRP ₹1,299)." }
      ]
    },
    {
      slug:        "best-sellers",
      title:       "Best Sellers",
      subtitle:    "The fragrances people keep coming back to",
      description: "NAFUME's most loved fragrances — chosen by customers for their performance, staying power, and premium character.",
      badge:       "Popular",
      type:        "product",
      sortOrder:   2,
      icon:        "🏆",
      seoTitle:    "Best Selling Perfumes — NAFUME Artisan Luxe",
      seoDescription: "Shop NAFUME's best-selling fragrances. Premium Eau De Parfum perfumes loved by customers across India. Seduction, Dark Oud, Aqua Manthan.",
      faqItems: [
        { q: "What makes a NAFUME perfume a bestseller?", a: "Our bestsellers are chosen based on repeat customer orders, positive reviews, and consistent positive feedback on longevity and scent quality." },
        { q: "Are bestsellers available for gifting?", a: "Yes. All our bestsellers are beautifully packaged and ideal for gifting." }
      ]
    },
    {
      slug:        "him",
      title:       "For Him",
      subtitle:    "Bold, confident fragrances for men",
      description: "Fragrances crafted for men who make an impression. From the smoky intensity of Dark Oud to the fiery confidence of Red Spirit and the clean edge of Aqua Manthan.",
      badge:       "Men",
      type:        "gender",
      sortOrder:   3,
      icon:        "🕴️",
      seoTitle:    "Best Perfumes for Men — NAFUME Artisan Luxe",
      seoDescription: "Shop the best men's perfumes from NAFUME. Bold, long-lasting Eau De Parfum fragrances — Dark Oud, Red Spirit, Aqua Manthan, All Day.",
      faqItems: [
        { q: "Which NAFUME perfume is best for men?", a: "Dark Oud is our most intense masculine fragrance. Red Spirit for bold spicy confidence. Aqua Manthan for fresh everyday wear." },
        { q: "Are these men's fragrances suitable for office wear?", a: "Aqua Manthan is ideal for office. Red Spirit and All Day work well for casual daytime and evening." }
      ]
    },
    {
      slug:        "her",
      title:       "For Her",
      subtitle:    "Sensual, elegant fragrances for women",
      description: "Fragrances that celebrate femininity with depth. Seduction's floral-oriental warmth and Aqua Manthan's crisp freshness — for every woman's signature.",
      badge:       "Women",
      type:        "gender",
      sortOrder:   4,
      icon:        "💐",
      seoTitle:    "Best Perfumes for Women — NAFUME Artisan Luxe",
      seoDescription: "Shop the best women's perfumes from NAFUME. Floral, oriental, and fresh Eau De Parfum fragrances for every mood and occasion.",
      faqItems: [
        { q: "Which NAFUME perfume is best for women?", a: "Seduction is our most popular women's fragrance — warm floral-oriental with rose and amber. Aqua Manthan offers a fresh, clean alternative." },
        { q: "Are these fragrances long-lasting on women's skin?", a: "Yes. NAFUME EDP formulas are designed for longevity. Apply to warm pulse points for best results." }
      ]
    },
    {
      slug:        "unisex",
      title:       "Unisex Fragrances",
      subtitle:    "Versatile scents that work for everyone",
      description: "Modern, boundary-free fragrances that suit any personality. These scents are wearable, expressive, and work beautifully regardless of gender.",
      badge:       "Unisex",
      type:        "gender",
      sortOrder:   5,
      icon:        "♾️",
      seoTitle:    "Unisex Perfumes — NAFUME Artisan Luxe",
      seoDescription: "Explore NAFUME's unisex perfume collection. Versatile, gender-free fragrances that work beautifully for everyone.",
      faqItems: [
        { q: "What makes a perfume unisex?", a: "Unisex fragrances use scent profiles that feel balanced and expressive regardless of gender — think fresh, gourmand, and aromatic blends." },
        { q: "Which NAFUME fragrances are best for couples?", a: "Aqua Manthan and All Day are popular couple choices. Both are versatile and work for different skin types." }
      ]
    },
    {
      slug:        "office-wear",
      title:       "Office & Daily Wear",
      subtitle:    "Fresh, professional fragrances for everyday confidence",
      description: "Fragrances that feel polished and appropriate for professional settings without being overpowering. Light yet memorable — the ideal everyday companion.",
      badge:       "Office",
      type:        "occasion",
      sortOrder:   6,
      icon:        "💼",
      seoTitle:    "Best Office Perfumes — NAFUME Artisan Luxe",
      seoDescription: "Shop NAFUME's best perfumes for office and daily wear. Fresh, clean fragrances that are professional yet distinctive.",
      faqItems: [
        { q: "Which perfume should I wear to the office?", a: "Aqua Manthan is the top pick for office wear — fresh, clean, and non-intrusive. Red Spirit works well for power meetings." },
        { q: "Are these office perfumes too strong?", a: "NAFUME's office picks are formulated to be present without being overwhelming. 2 sprays is usually ideal." }
      ]
    },
    {
      slug:        "date-night",
      title:       "Date Night",
      subtitle:    "Captivating fragrances for unforgettable evenings",
      description: "Scents designed to make a lasting impression. Seductive, deep, and magnetic — perfect for special evenings, romantic dinners, and night-outs.",
      badge:       "Evening",
      type:        "occasion",
      sortOrder:   7,
      icon:        "🌙",
      seoTitle:    "Best Date Night Perfumes — NAFUME Artisan Luxe",
      seoDescription: "Shop the best date night and evening perfumes from NAFUME. Seductive, long-lasting fragrances for romantic and special occasions.",
      faqItems: [
        { q: "What is the best NAFUME perfume for a date?", a: "Seduction is designed specifically for date nights — warm floral oriental with rose, amber, and musky base. Dark Oud is for those who prefer bold, mysterious character." },
        { q: "How long do these fragrances last in the evening?", a: "NAFUME EDPs typically last 6–8+ hours depending on skin type. Apply to pulse points right after showering for best longevity." }
      ]
    },
    {
      slug:        "fresh-aquatic",
      title:       "Fresh & Aquatic",
      subtitle:    "Clean, ocean-inspired fragrances",
      description: "Crisp marine accords, fresh citrus, and clean white musks. These fragrances feel like the ocean at dawn — light, energising, and impossible to ignore.",
      badge:       "Fresh",
      type:        "scentFamily",
      sortOrder:   8,
      icon:        "🌊",
      seoTitle:    "Fresh Aquatic Perfumes — NAFUME Artisan Luxe",
      seoDescription: "Shop NAFUME's fresh and aquatic fragrances. Clean, marine-inspired Eau De Parfum for daily wear, office, and summer.",
      faqItems: [
        { q: "Are aquatic fragrances suitable for summer in India?", a: "Yes. Fresh aquatic fragrances perform beautifully in Indian summer — the marine accord blooms even more in warmth." },
        { q: "Are fresh fragrances long-lasting?", a: "Yes. NAFUME's fresh fragrances are formulated as EDP concentration for better longevity compared to EDT." }
      ]
    },
    {
      slug:        "oud-intense",
      title:       "Oud Intense",
      subtitle:    "Deep, rich oud fragrances for powerful presence",
      description: "The ancient art of oud in a modern bottle. Rich, dark, and deeply unforgettable — for those who believe presence should be felt before a word is spoken.",
      badge:       "Intense",
      type:        "scentFamily",
      sortOrder:   9,
      icon:        "🪵",
      seoTitle:    "Oud Perfumes for Men — NAFUME Artisan Luxe",
      seoDescription: "Shop NAFUME's intense oud fragrances. Premium Oud Eau De Parfum with saffron, leather, and frankincense.",
      faqItems: [
        { q: "Is oud too strong for everyday wear?", a: "Dark Oud is designed as a statement fragrance — 2–3 sprays is all you need. Best for evenings, formal events, and winter." },
        { q: "Does NAFUME oud contain real oud?", a: "Dark Oud uses aged oud accords crafted to replicate the character of premium agarwood." }
      ]
    },
    {
      slug:        "gifting",
      title:       "Gifting",
      subtitle:    "Premium fragrances, beautifully packaged",
      description: "All NAFUME fragrances come in elegant packaging, making them ideal gifts for birthdays, anniversaries, Diwali, weddings, and corporate gifting.",
      badge:       "Gift",
      type:        "gifting",
      sortOrder:   10,
      icon:        "🎁",
      seoTitle:    "Perfume Gifts Online India — NAFUME Artisan Luxe",
      seoDescription: "Shop premium perfume gifts from NAFUME. Beautiful packaging, authentic EDP fragrances — ideal for birthdays, weddings, and corporate gifting in India.",
      faqItems: [
        { q: "Is NAFUME packaging suitable for gifting?", a: "Yes. NAFUME fragrances come in premium packaging designed for gifting, with elegant presentation and careful packaging." },
        { q: "Can I order multiple fragrances as a gift bundle?", a: "Yes. You can add multiple fragrances to your cart and order together via WhatsApp. Use our Build Your Box option to create a custom set." }
      ]
    },
    {
      slug:        "bundles",
      title:       "Bundles",
      subtitle:    "Save more when you buy together",
      description: "Get more from NAFUME with our curated bundles. Pick a ready-made duo or trio, or build your own perfect fragrance box.",
      badge:       "Save",
      type:        "bundle",
      sortOrder:   12,
      icon:        "📦",
      linkTo:      "/pages/collections/build-your-own-box",
      seoTitle:    "Perfume Bundles — NAFUME Artisan Luxe",
      seoDescription: "Shop NAFUME perfume bundles and multi-packs. Save on premium EDP fragrances when you buy two or three together.",
      faqItems: [
        { q: "Is there a discount on bundles?", a: "Yes. Bundle pricing is available when you order 2 or more fragrances. Contact us on WhatsApp for current bundle offers." }
      ]
    },
    {
      slug:        "build-your-own-box",
      title:       "Build Your Box",
      subtitle:    "Choose up to 3 fragrances, make it yours",
      description: "Pick any combination of NAFUME fragrances — up to 3 — and we'll confirm your custom box on WhatsApp. Perfect for personal use or a one-of-a-kind gift.",
      badge:       "Custom",
      type:        "bundle",
      sortOrder:   13,
      icon:        "🎨",
      linkTo:      "/pages/collections/build-your-own-box",
      seoTitle:    "Build Your Own Perfume Box — NAFUME Artisan Luxe",
      seoDescription: "Build your own NAFUME fragrance box. Choose up to 3 EDP perfumes and get a custom bundle confirmed on WhatsApp.",
      faqItems: [
        { q: "How many fragrances can I include in my box?", a: "You can select up to 3 fragrances for a custom box. Mix and match from the full NAFUME range." }
      ]
    }
  ];

  // ── Bundle definitions (foundation, Upgrade 6) ───────────────────
  var BUNDLES = [
    {
      bundleId:         "duo-floral-oud",
      title:            "Floral & Oud Duo",
      includedProductIds: ["seduction", "dark-oud"],
      price:            1499,
      mrp:              2598,
      discountPercent:  42,
      description:      "The contrast that commands attention — sensual floral meets intense oud.",
      offerText:        "Save ₹1,099",
      isActive:         true,
      shopifyVariantId: null
    },
    {
      bundleId:         "trio-discovery",
      title:            "Discovery Trio",
      includedProductIds: ["seduction", "aqua-manthan", "all-day-misfit"],
      price:            2199,
      mrp:              3897,
      discountPercent:  43,
      description:      "Three distinct personalities — find your signature from our best variety trio.",
      offerText:        "Save ₹1,698",
      isActive:         true,
      shopifyVariantId: null
    },
    {
      bundleId:         "duo-him-essentials",
      title:            "His Essentials Duo",
      includedProductIds: ["dark-oud", "red-spirit"],
      price:            1499,
      mrp:              2598,
      discountPercent:  42,
      description:      "The bold man's essential pair — deep oud for evenings, fiery spice for the day.",
      offerText:        "Save ₹1,099",
      isActive:         true,
      shopifyVariantId: null
    },
    {
      bundleId:         "trio-all-rounder",
      title:            "All-Rounder Trio",
      includedProductIds: ["aqua-manthan", "red-spirit", "dark-oud"],
      price:            2199,
      mrp:              3897,
      discountPercent:  43,
      description:      "Fresh for the day, spicy for the meeting, intense for the night — the complete arsenal.",
      offerText:        "Save ₹1,698",
      isActive:         true,
      shopifyVariantId: null
    }
  ];

  // ── Helper — get products for a collection ───────────────────────
  function getProductsByCollection(slug) {
    if (!window.LAUNCH_PRODUCTS) return [];
    var col = getCollectionBySlug(slug);
    if (!col) return [];
    // Virtual types just return all eligible products
    if (col.type === "bundle") return window.LAUNCH_PRODUCTS.filter(function(p) { return p.isBundleEligible; });
    if (col.type === "gifting") return window.LAUNCH_PRODUCTS.filter(function(p) { return p.isGiftable; });
    return window.LAUNCH_PRODUCTS.filter(function(p) {
      return p.collections && p.collections.indexOf(slug) > -1;
    });
  }

  function getCollectionBySlug(slug) {
    return COLLECTIONS.find(function(c) { return c.slug === slug; }) || null;
  }

  function getAllCollections() {
    return COLLECTIONS.slice().sort(function(a, b) { return a.sortOrder - b.sortOrder; });
  }

  function getFeaturedCollections() {
    var featured = ["best-sellers", "him", "her", "date-night", "fresh-aquatic", "oud-intense", "gifting", "build-your-own-box"];
    return featured.map(getCollectionBySlug).filter(Boolean);
  }

  function getHomepageCollections() {
    return getFeaturedCollections().slice(0, 6);
  }

  function getGenderCollections() {
    return COLLECTIONS.filter(function(c) { return c.type === "gender"; });
  }

  function getOccasionCollections() {
    return COLLECTIONS.filter(function(c) { return c.type === "occasion"; });
  }

  function getScentFamilyCollections() {
    return COLLECTIONS.filter(function(c) { return c.type === "scentFamily"; });
  }

  function getBundleCollections() {
    return COLLECTIONS.filter(function(c) { return c.type === "bundle"; });
  }

  function getAllBundles() {
    return BUNDLES.filter(function(b) { return b.isActive; });
  }

  function getBundleById(bundleId) {
    return BUNDLES.find(function(b) { return b.bundleId === bundleId; }) || null;
  }

  /* ── SEO content depth per collection (Upgrade 8) ───────────────────
     seoContentTitle  — H2 shown above the buying-guide paragraph
     seoContentBody   — short, honest buying guidance (no keyword stuffing)
     relatedCollections — slugs to cross-link from the collection page      */
  var COLLECTION_SEO_CONTENT = {
    "new-launches": {
      seoContentTitle: "About NAFUME New Launches",
      seoContentBody: "Our new launch range is the complete NAFUME debut — five Eau De Parfum fragrances, each with its own personality. If you are new to the brand, this is the best place to start: explore a fresh aquatic, a deep oud, a warm floral, a spicy aromatic and a sweet gourmand, all crafted for Indian weather and everyday wear. Add your favourite to cart and confirm your order on WhatsApp.",
      relatedCollections: ["best-sellers", "gifting"]
    },
    "best-sellers": {
      seoContentTitle: "Why These Are Our Best Sellers",
      seoContentBody: "These are the NAFUME fragrances customers reach for again and again. They balance a premium scent profile with reliable, long-lasting performance — the kind of perfume that earns a compliment without being overpowering. If you want a safe, well-loved first choice, start here. Each is available at ₹799 during the Summer Sale and is beautifully packaged for gifting.",
      relatedCollections: ["new-launches", "him", "her"]
    },
    "him": {
      seoContentTitle: "Choosing a Perfume for Men",
      seoContentBody: "Men's fragrances at NAFUME range from clean and office-friendly to bold and intense. For daily and office wear, Aqua Manthan keeps things fresh; for evenings and special occasions, Dark Oud and Red Spirit make a statement. Think about where you will wear it most — daytime calls for lighter, fresher scents, while evenings suit deeper, warmer ones.",
      relatedCollections: ["oud-intense", "office-wear", "date-night"]
    },
    "her": {
      seoContentTitle: "Choosing a Perfume for Women",
      seoContentBody: "Women's fragrances at NAFUME move from crisp and fresh to warm and sensual. Seduction offers a rich floral-oriental character ideal for evenings and special moments, while Aqua Manthan brings a clean, everyday freshness. Pick based on the mood you want to carry through the day, and apply to warm pulse points for the best wear.",
      relatedCollections: ["date-night", "fresh-aquatic", "gifting"]
    },
    "unisex": {
      seoContentTitle: "Fragrances That Suit Everyone",
      seoContentBody: "Unisex fragrances are built around versatile scent profiles that feel balanced on any wearer. They are a smart choice if you like sharing, gifting without guessing preferences, or simply want a scent that adapts across moods and occasions. Aqua Manthan, Red Spirit and All Day are easy, expressive everyday options.",
      relatedCollections: ["office-wear", "fresh-aquatic", "best-sellers"]
    },
    "office-wear": {
      seoContentTitle: "Best Perfumes for Office & Daily Wear",
      seoContentBody: "Office fragrances should feel polished, not loud. The picks here stay close and pleasant so they work in shared spaces and through a full workday. Aqua Manthan is the cleanest, most versatile choice; Red Spirit adds quiet confidence for meetings. Two light sprays are usually enough for all-day wear.",
      relatedCollections: ["fresh-aquatic", "him", "best-sellers"]
    },
    "date-night": {
      seoContentTitle: "Perfumes for Evenings & Special Occasions",
      seoContentBody: "Evening fragrances are richer and more memorable than daytime scents. Seduction brings a warm, romantic floral character; Dark Oud is deep and mysterious; Red Spirit adds a spicy edge. Apply to pulse points after a shower for the best wear, and let the scent settle for a few minutes before you head out.",
      relatedCollections: ["oud-intense", "her", "gifting"]
    },
    "fresh-aquatic": {
      seoContentTitle: "About Fresh & Aquatic Perfumes",
      seoContentBody: "Fresh and aquatic fragrances are clean, cooling and energising — ideal for Indian summers, daily wear, the office and travel. Marine accords and citrus open bright and stay easy to wear, even in heat and humidity. If you prefer light, breathable scents over heavy ones, this is your family.",
      relatedCollections: ["office-wear", "unisex", "best-sellers"]
    },
    "oud-intense": {
      seoContentTitle: "About Oud & Intense Perfumes",
      seoContentBody: "Oud fragrances are deep, rich and made to be noticed. They suit evenings, weddings, formal events and cooler weather, where a warm, smoky character can truly bloom. A little goes a long way — two or three sprays are enough. If you love bold, statement scents, start with Dark Oud.",
      relatedCollections: ["date-night", "him", "gifting"]
    },
    "gifting": {
      seoContentTitle: "Perfume Gifting Made Simple",
      seoContentBody: "A fragrance is a thoughtful, personal gift. Every NAFUME perfume comes in premium packaging suitable for birthdays, anniversaries, Diwali, weddings and corporate gifting. If you are unsure of the recipient's taste, a best seller is a safe, well-loved choice — or build a custom box with up to three fragrances.",
      relatedCollections: ["best-sellers", "build-your-own-box"]
    },
    "bundles": {
      seoContentTitle: "Save More With Perfume Bundles",
      seoContentBody: "Bundles let you enjoy more NAFUME for less. Pair complementary scents — a fresh daytime perfume with a deeper evening one — for a complete wardrobe, or pick a ready-made duo or trio. You can also build your own box and confirm pricing on WhatsApp.",
      relatedCollections: ["build-your-own-box", "best-sellers", "gifting"]
    },
    "build-your-own-box": {
      seoContentTitle: "Build a Box That's Truly Yours",
      seoContentBody: "Choose up to three NAFUME fragrances and we'll confirm your custom box on WhatsApp. It's the easiest way to cover different moods and occasions in one order, or to create a one-of-a-kind gift. Mix fresh, oud, floral and gourmand scents however you like.",
      relatedCollections: ["gifting", "best-sellers"]
    }
  };

  // Backfill SEO content onto each collection (keeps all copy in one place).
  COLLECTIONS.forEach(function (c) {
    var sc = COLLECTION_SEO_CONTENT[c.slug];
    if (sc) {
      c.seoContentTitle    = sc.seoContentTitle;
      c.seoContentBody     = sc.seoContentBody;
      c.relatedCollections = sc.relatedCollections;
    }
  });

  function getCollectionSeoContent(slug) {
    var col = getCollectionBySlug(slug);
    if (!col) return null;
    return {
      title:           col.seoTitle || col.title + " — NAFUME Artisan Luxe",
      description:     col.seoDescription || col.description,
      seoContentTitle: col.seoContentTitle || null,
      seoContentBody:  col.seoContentBody || null,
      faqItems:        col.faqItems || [],
      relatedCollections: col.relatedCollections || []
    };
  }

  // ── Public API ───────────────────────────────────────────────────
  window.CollectionService = {
    getAllCollections:        getAllCollections,
    getCollectionBySlug:     getCollectionBySlug,
    getProductsByCollection: getProductsByCollection,
    getFeaturedCollections:  getFeaturedCollections,
    getHomepageCollections:  getHomepageCollections,
    getGenderCollections:    getGenderCollections,
    getOccasionCollections:  getOccasionCollections,
    getScentFamilyCollections: getScentFamilyCollections,
    getBundleCollections:    getBundleCollections,
    getAllBundles:            getAllBundles,
    getBundleById:           getBundleById,
    getCollectionSeoContent: getCollectionSeoContent
  };

})();
