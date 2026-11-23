/* ============================================================================
   NAFUME — SEO Service   (Upgrade 8: SEO depth)
   ----------------------------------------------------------------------------
   A tiny, dependency-free helper for metadata + JSON-LD structured data.
   Lets dynamic pages (product pages, collection.html) update their <title>,
   meta description, canonical, Open Graph / Twitter tags, and inject schema.

   ⚠️  DOMAIN: uses the placeholder https://nafume.com everywhere.
       Replace nafume.com with the final live domain before launch
       (here, in sitemap.xml, robots.txt, and any hard-coded og:url).

   Public API (window.SEO):
     getSiteSeoDefaults()
     getPageSeo(pageKey)
     getProductSeo(product)
     getCollectionSeo(collection)
     updateDocumentSeo(seoData)
     injectJsonLd(schemaObject, id)
     createProductSchema(product, reviewsSummary)
     createBreadcrumbSchema(items)
     createOrganizationSchema()
     createWebsiteSchema()
     createFAQSchema(faqItems)
     createCollectionPageSchema(collection, products)
   ========================================================================== */
(function (global) {
  "use strict";

  var CFG = global.COMMERCE_CONFIG || {};

  // ── Site-wide defaults ────────────────────────────────────────────────────
  // Replace nafume.com with the final live domain before launch.
  var SITE = {
    domain:      "https://www.nafume.com",
    name:        "NAFUME",
    legalName:   "NAFUME Artisan Luxe",
    tagline:     "Premium Eau De Parfum, crafted for Indian wear",
    description: "NAFUME is a premium perfume brand in India offering long-lasting Eau De Parfum — oud, fresh, floral, woody and sweet scents for everyday wear, office, evenings and gifting.",
    // Replace with a dedicated 1200×630 social image before launch.
    defaultImage: "https://www.nafume.com/assets/images/products/seduction/01.jpg",
    instagram:   (CFG.instagramUrl || "https://www.instagram.com/nafume.official"),
    facebook:    (CFG.facebookUrl  || "https://www.facebook.com/profile.php?id=61590903942862"),
    whatsapp:    (CFG.whatsappNumber || "918595862227"),
    sellingPrice: CFG.sellingPrice || 799,
    mrp:          CFG.mrp || 1299,
    currency:     CFG.currency || "INR"
  };

  function getSiteSeoDefaults() { return SITE; }

  // ── URL helpers ───────────────────────────────────────────────────────────
  function absUrl(path) {
    if (!path) return SITE.domain + "/";
    if (/^https?:\/\//i.test(path)) return path;       // already absolute
    return SITE.domain + "/" + String(path).replace(/^\//, "");
  }

  // ── Per-page static SEO (titles + descriptions are unique, no duplicates) ──
  var PAGE_SEO = {
    home: {
      path: "/",
      title: "NAFUME — Premium Long-Lasting Perfumes in India | Eau De Parfum",
      description: "Shop NAFUME premium perfumes in India. Long-lasting Eau De Parfum in oud, fresh, floral, woody and sweet scents — for everyday wear, office, evenings and gifting."
    },
    shop: {
      path: "/pages/collections/shop",
      title: "Shop All Perfumes Online — NAFUME Artisan Luxe",
      description: "Browse all NAFUME Eau De Parfum fragrances by mood, scent family, gender and occasion. Fresh, oud, floral, spicy and gourmand perfumes at ₹799."
    },
    collections: {
      path: "/pages/collections/collections",
      title: "All Perfume Collections — NAFUME Artisan Luxe",
      description: "Explore NAFUME fragrance collections — best sellers, for him, for her, office wear, date night, fresh & aquatic, oud, and gifting."
    },
    gifting: {
      path: "/pages/collections/gifting",
      title: "Perfume Gifts Online in India — NAFUME Artisan Luxe",
      description: "Premium perfume gifts from NAFUME. Beautifully packaged Eau De Parfum, ideal for birthdays, anniversaries, Diwali, weddings and corporate gifting across India."
    },
    byob: {
      path: "/pages/collections/build-your-own-box",
      title: "Build Your Own Perfume Box — NAFUME Artisan Luxe",
      description: "Create a custom NAFUME fragrance box. Choose up to 3 Eau De Parfum perfumes and confirm your bundle on WhatsApp. Perfect for personal use or gifting."
    },
    fragranceFinder: {
      path: "/pages/collections/shop",
      title: "Fragrance Finder — Find Your Perfect Perfume | NAFUME",
      description: "Answer a few quick questions and discover the NAFUME perfume that matches your style, mood and occasion."
    },
    trackOrder: {
      path: "/pages/order/track-order",
      title: "Track Your Order — NAFUME Artisan Luxe",
      description: "Track your NAFUME order using your order ID, phone number or AWB number. Check your fragrance delivery status anytime."
    },
    account: {
      path: "/pages/account/account",
      title: "My Account — NAFUME Artisan Luxe",
      description: "Manage your NAFUME account, saved address and order history."
    }
  };

  function getPageSeo(pageKey) {
    var p = PAGE_SEO[pageKey];
    if (!p) {
      return {
        title: SITE.name + " — " + SITE.tagline,
        description: SITE.description,
        url: SITE.domain + "/",
        canonical: SITE.domain + "/",
        image: SITE.defaultImage
      };
    }
    return {
      title:     p.title,
      description: p.description,
      url:       absUrl(p.path),
      canonical: absUrl(p.path),
      image:     p.image ? absUrl(p.image) : SITE.defaultImage
    };
  }

  // ── Dynamic product / collection SEO ──────────────────────────────────────
  function clip(str, max) {
    str = String(str || "").replace(/\s+/g, " ").trim();
    if (str.length <= max) return str;
    return str.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  }

  function getProductSeo(product) {
    product = product || {};
    var name   = product.name || product.displayName || "Perfume";
    var family = product.family || product.scentFamily || "Eau De Parfum";
    var slug   = product.slug || ((product.id || "product") + "");
    var price  = product.price || SITE.sellingPrice;
    var desc   = product.description ||
      (name + " by NAFUME — a premium " + family + " Eau De Parfum 50ml.");
    return {
      title:     "NAFUME " + name + " — " + family + " Eau De Parfum 50ml",
      description: clip(desc, 155),
      url:       absUrl(slug),
      canonical: absUrl(slug),
      image:     product.image ? absUrl(product.image) : SITE.defaultImage,
      type:      "product",
      price:     price,
      currency:  SITE.currency
    };
  }

  function getCollectionSeo(collection) {
    collection = collection || {};
    var title = collection.seoTitle || ((collection.title || "Collection") + " — NAFUME Artisan Luxe");
    var desc  = collection.seoDescription || collection.description || SITE.description;
    var slug  = collection.slug ? ("/pages/collections/collection?collection=" + collection.slug) : "/pages/collections/collections";
    return {
      title:     title,
      description: clip(desc, 158),
      url:       absUrl(slug),
      canonical: absUrl(slug),
      image:     SITE.defaultImage,
      type:      "website"
    };
  }

  // ── Apply metadata to <head> (creates tags if missing) ────────────────────
  function setMeta(selector, attr, attrVal, content) {
    if (content == null) return;
    var el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(attr, attrVal);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content);
  }
  function setLink(rel, href) {
    if (!href) return;
    var el = document.head.querySelector('link[rel="' + rel + '"]');
    if (!el) {
      el = document.createElement("link");
      el.setAttribute("rel", rel);
      document.head.appendChild(el);
    }
    el.setAttribute("href", href);
  }

  function updateDocumentSeo(seoData) {
    seoData = seoData || {};
    try {
      if (seoData.title) document.title = seoData.title;
      setMeta('meta[name="description"]', "name", "description", seoData.description);
      if (seoData.canonical) setLink("canonical", seoData.canonical);

      // Open Graph
      setMeta('meta[property="og:site_name"]', "property", "og:site_name", SITE.legalName);
      setMeta('meta[property="og:type"]',  "property", "og:type",  seoData.type || "website");
      setMeta('meta[property="og:title"]', "property", "og:title", seoData.title);
      setMeta('meta[property="og:description"]', "property", "og:description", seoData.description);
      setMeta('meta[property="og:url"]',   "property", "og:url",   seoData.url || seoData.canonical);
      setMeta('meta[property="og:image"]', "property", "og:image", seoData.image || SITE.defaultImage);

      // Twitter
      setMeta('meta[name="twitter:card"]',  "name", "twitter:card",  "summary_large_image");
      setMeta('meta[name="twitter:title"]', "name", "twitter:title", seoData.title);
      setMeta('meta[name="twitter:description"]', "name", "twitter:description", seoData.description);
      setMeta('meta[name="twitter:image"]', "name", "twitter:image", seoData.image || SITE.defaultImage);
    } catch (e) { /* never break the page for SEO */ }
  }

  // ── JSON-LD injection (id-guarded — no duplicate scripts) ──────────────────
  function injectJsonLd(schemaObject, id) {
    if (!schemaObject) return null;
    try {
      id = id || ("ld-" + Math.random().toString(36).slice(2));
      var existing = document.getElementById(id);
      if (existing) existing.parentNode.removeChild(existing);   // replace, never stack
      var s = document.createElement("script");
      s.type = "application/ld+json";
      s.id = id;
      s.textContent = JSON.stringify(schemaObject);
      document.head.appendChild(s);
      return s;
    } catch (e) { return null; }
  }

  // ── Schema builders ───────────────────────────────────────────────────────
  function createProductSchema(product, reviewsSummary) {
    product = product || {};
    var name   = product.name || product.displayName || "Perfume";
    var price  = product.price || SITE.sellingPrice;
    var slug   = product.slug || ((product.id || "product") + "");
    var inStock = (product.stockStatus ? product.stockStatus === "in_stock" : true);

    var schema = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "name": "NAFUME " + name,
      "description": clip(product.description || (name + " Eau De Parfum by NAFUME."), 300),
      "brand": { "@type": "Brand", "name": "NAFUME" },
      "category": "Perfume",
      "image": product.image ? absUrl(product.image) : SITE.defaultImage,
      "url": absUrl(slug),
      "offers": {
        "@type": "Offer",
        "priceCurrency": SITE.currency,
        "price": String(price),
        "url": absUrl(slug),
        // Only claim availability we actually have from product data.
        "availability": inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        "seller": { "@type": "Organization", "name": SITE.legalName }
      }
    };
    if (product.id) schema.sku = String(product.id);

    // AggregateRating ONLY when real reviews exist — never fake counts.
    if (reviewsSummary && reviewsSummary.hasReviews && reviewsSummary.count > 0) {
      schema.aggregateRating = {
        "@type": "AggregateRating",
        "ratingValue": String(reviewsSummary.average),
        "reviewCount": String(reviewsSummary.count),
        "bestRating": "5",
        "worstRating": "1"
      };
    }
    return schema;
  }

  function createBreadcrumbSchema(items) {
    items = (items || []).filter(function (i) { return i && i.name; });
    if (!items.length) return null;
    return {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": items.map(function (it, i) {
        var entry = {
          "@type": "ListItem",
          "position": i + 1,
          "name": it.name
        };
        if (it.url) entry.item = absUrl(it.url);
        return entry;
      })
    };
  }

  function createOrganizationSchema() {
    return {
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": SITE.legalName,
      "alternateName": SITE.name,
      "url": SITE.domain + "/",
      "logo": SITE.defaultImage,
      "description": SITE.description,
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Ashok Vihar, Delhi",
        "addressCountry": "IN"
      },
      "sameAs": [SITE.instagram, SITE.facebook],
      "contactPoint": [{
        "@type": "ContactPoint",
        "contactType": "customer support",
        "telephone": "+" + String(SITE.whatsapp),
        "areaServed": "IN",
        "availableLanguage": ["en", "hi"]
      }]
    };
  }

  function createWebsiteSchema() {
    return {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": SITE.legalName,
      "url": SITE.domain + "/",
      "description": SITE.description
    };
  }

  function createFAQSchema(faqItems) {
    // Accept {q,a} or {question,answer}. Skip malformed entries.
    var clean = (faqItems || []).map(function (f) {
      if (!f) return null;
      var q = f.q || f.question;
      var a = f.a || f.answer;
      if (!q || !a) return null;
      return {
        "@type": "Question",
        "name": String(q),
        "acceptedAnswer": { "@type": "Answer", "text": String(a) }
      };
    }).filter(Boolean);
    if (!clean.length) return null;   // FAQ schema only when FAQs exist
    return {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": clean
    };
  }

  function createCollectionPageSchema(collection, products) {
    collection = collection || {};
    products = products || [];
    var slug = collection.slug ? ("/pages/collections/collection?collection=" + collection.slug) : "/pages/collections/collections";
    var schema = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "name": collection.seoTitle || collection.title || "Collection",
      "description": collection.seoDescription || collection.description || SITE.description,
      "url": absUrl(slug)
    };
    if (products.length) {
      schema.mainEntity = {
        "@type": "ItemList",
        "numberOfItems": products.length,
        "itemListElement": products.map(function (p, i) {
          return {
            "@type": "ListItem",
            "position": i + 1,
            "url": absUrl(p.slug || ((p.id || "product") + "")),
            "name": "NAFUME " + (p.name || p.displayName || "Perfume")
          };
        })
      };
    }
    return schema;
  }

  // ── Expose ────────────────────────────────────────────────────────────────
  global.SEO = {
    SITE:                      SITE,
    getSiteSeoDefaults:        getSiteSeoDefaults,
    getPageSeo:                getPageSeo,
    getProductSeo:             getProductSeo,
    getCollectionSeo:          getCollectionSeo,
    updateDocumentSeo:         updateDocumentSeo,
    injectJsonLd:              injectJsonLd,
    createProductSchema:       createProductSchema,
    createBreadcrumbSchema:    createBreadcrumbSchema,
    createOrganizationSchema:  createOrganizationSchema,
    createWebsiteSchema:       createWebsiteSchema,
    createFAQSchema:           createFAQSchema,
    createCollectionPageSchema: createCollectionPageSchema,
    absUrl:                    absUrl
  };
})(window);

