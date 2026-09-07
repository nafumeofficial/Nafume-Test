/* ============================================================================
   NAFUME — Product Reviews Service   (Upgrade 4)
   ----------------------------------------------------------------------------
   A LOCAL reviews foundation. Stores customer reviews in localStorage and
   computes per-product summaries. Designed to be swapped later for a real
   provider (Shopify product reviews, Judge.me, Loox, or a custom backend).

   ⚠️  LOCAL DEMO ONLY — not production-secure. Anyone on the device can edit
       localStorage. No spam protection, no real verified-purchase guarantee.
       See docs/product-reviews-system.md.

   Self-contained: depends on nothing hard. Uses window.CustomerService (if
   present) for verified-buyer detection and window.LAUNCH_PRODUCTS for product
   lookups. Never throws.

   Public API (window.ReviewService):
     getAllReviews()
     getReviewsByProductId(productId, includeAll)
     getReviewSummary(productId)
     addReview(reviewPayload)
     updateReviewStatus(reviewId, status)
     canCustomerReviewProduct(productId, customerId)
     getFeaturedReviews(limit)
     seedInitialReviewsIfEmpty()
   ========================================================================== */
(function (global) {
  "use strict";

  var CFG  = global.COMMERCE_CONFIG || {};
  var KEYS = (CFG.storageKeys || {});
  var REVIEWS_KEY = KEYS.reviews || "nafume_product_reviews";

  // Default status for NEW customer reviews.
  //   "pending"   → review is held until approved (use reviews-admin.html).
  //   "published" → review appears immediately (auto-publish).
  // DEV TIP: to auto-publish local reviews, change this to "published".
  var DEFAULT_REVIEW_STATUS = "pending";

  var VALID_STATUSES = ["published", "pending", "hidden"];

  // ── safe localStorage helpers ────────────────────────────────────────────
  function readJSON(key, fallback) {
    try { var v = global.localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { global.localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }
  function storageAvailable() {
    try { global.localStorage.setItem("__nf_r__", "1"); global.localStorage.removeItem("__nf_r__"); return true; }
    catch (e) { return false; }
  }

  function genReviewId() {
    return "REV-" + Date.now().toString(36).toUpperCase() + "-" + Math.floor(100 + Math.random() * 900);
  }
  function nowISO() { return new Date().toISOString(); }

  function productById(productId) {
    var list = global.LAUNCH_PRODUCTS || [];
    for (var i = 0; i < list.length; i++) { if (list[i].id === productId) return list[i]; }
    return null;
  }

  // ── store ────────────────────────────────────────────────────────────────
  function getAllReviews() { return readJSON(REVIEWS_KEY, []) || []; }
  function saveAllReviews(list) { return writeJSON(REVIEWS_KEY, list); }

  /* ── server-side reviews ───────────────────────────────────────────────────
     Real customer reviews are submitted through /pages/order/review and stored
     in the database, where they stay `pending` until a moderator publishes
     them. Without this, a published review would never appear on a product
     page — the storefront would still be showing only the locally seeded ones.

     Fetched reviews are held IN MEMORY for the page's lifetime and never
     written to localStorage: the database is the source of truth, and caching
     moderated content locally would let a hidden review linger.             */

  var serverCache = {};        // productId -> [normalized review]
  var serverPending = {};      // productId -> Promise (de-duplicates in-flight requests)

  function normalizeServerReview(r) {
    return {
      reviewId:      r.id,
      productId:     null,     // set by the caller — the API groups by product
      rating:        r.rating,
      title:         r.title || "",
      body:          r.body || "",
      photo:         r.photo || null,
      customerName:  r.author,
      verifiedBuyer: !!r.verified,
      status:        "published",
      createdAt:     r.createdAt,
      source:        "server"
    };
  }

  /* hydrateProduct(productId, onUpdate)
     Fetches published reviews for one product. Calls onUpdate() only when
     something actually changed, so callers can re-render without flicker.
     Never throws and never blocks rendering — the page shows what it has,
     then improves when the response arrives. */
  function hydrateProduct(productId, onUpdate) {
    if (!productId || !global.NafumeAPI) return;
    if (serverPending[productId]) return;

    serverPending[productId] = global.NafumeAPI.productReviews(productId)
      .then(function (res) {
        delete serverPending[productId];
        if (!res.ok || !Array.isArray(res.data.reviews)) return;

        serverCache[productId] = res.data.reviews.map(function (r) {
          var n = normalizeServerReview(r);
          n.productId = productId;
          return n;
        });
        if (typeof onUpdate === "function") { try { onUpdate(); } catch (e) {} }
      })
      .catch(function () { delete serverPending[productId]; });
  }

  function getServerReviews(productId) {
    return serverCache[productId] || [];
  }

  function getReviewsByProductId(productId, includeAll) {
    if (!productId) return [];

    var local = getAllReviews().filter(function (r) {
      if (r.productId !== productId) return false;
      return includeAll ? true : r.status === "published";
    });

    // Server reviews are always published (the API returns nothing else) and
    // are appended, de-duplicated by id in case a local copy also exists.
    var seen = {};
    local.forEach(function (r) { if (r.reviewId) seen[r.reviewId] = true; });
    var merged = local.concat(getServerReviews(productId).filter(function (r) {
      return !seen[r.reviewId];
    }));

    return merged.sort(function (a, b) {
      // verified first, then newest
      if (!!b.verifiedBuyer !== !!a.verifiedBuyer) return b.verifiedBuyer ? 1 : -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }

  function getReviewSummary(productId) {
    var published = getReviewsByProductId(productId, false);
    var dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    var sum = 0, verified = 0;
    published.forEach(function (r) {
      var rt = Math.max(1, Math.min(5, parseInt(r.rating, 10) || 0));
      dist[rt]++; sum += rt; if (r.verifiedBuyer) verified++;
    });
    if (published.length > 0) {
      return {
        productId: productId,
        hasReviews: true,
        average: Math.round((sum / published.length) * 10) / 10,
        count: published.length,
        verifiedCount: verified,
        distribution: dist,
        source: "dynamic"
      };
    }
    // Fallback to product-level numbers if provided (optional).
    var p = productById(productId);
    if (p && (p.fallbackRating || p.fallbackReviewCount)) {
      return {
        productId: productId, hasReviews: true,
        average: p.fallbackRating || 0,
        count: p.fallbackReviewCount || 0,
        verifiedCount: 0, distribution: dist, source: "fallback"
      };
    }
    return { productId: productId, hasReviews: false, average: 0, count: 0,
             verifiedCount: 0, distribution: dist, source: "none" };
  }

  // ── verified-buyer + eligibility ─────────────────────────────────────────
  /* Returns: { loggedIn, verifiedBuyer, alreadyReviewed, orderId } */
  function canCustomerReviewProduct(productId, customerId) {
    var cust = (global.CustomerService && global.CustomerService.getCurrentCustomer)
      ? global.CustomerService.getCurrentCustomer() : null;
    if (customerId && cust && cust.customerId !== customerId) {
      // A specific (non-current) customer was asked about — we can only verify
      // the currently logged-in one locally.
      cust = null;
    }
    if (!cust) {
      return { loggedIn: false, verifiedBuyer: false, alreadyReviewed: false, orderId: null };
    }
    var verified = false, orderId = null;
    if (global.CustomerService.getCustomerOrders) {
      var orders = global.CustomerService.getCustomerOrders() || [];
      for (var i = 0; i < orders.length; i++) {
        var items = orders[i].items || [];
        for (var j = 0; j < items.length; j++) {
          if ((items[j].productId || items[j].id) === productId) {
            verified = true; orderId = orders[i].orderId; break;
          }
        }
        if (verified) break;
      }
    }
    var already = getAllReviews().some(function (r) {
      return r.productId === productId && r.customerId && r.customerId === cust.customerId;
    });
    return { loggedIn: true, verifiedBuyer: verified, alreadyReviewed: already, orderId: orderId };
  }

  // ── add a review ─────────────────────────────────────────────────────────
  function addReview(reviewPayload) {
    reviewPayload = reviewPayload || {};
    if (!storageAvailable()) {
      return { success: false, error: "storage_unavailable",
        message: "Your browser is blocking local storage, so the review can't be saved." };
    }
    var productId = reviewPayload.productId;
    if (!productId) {
      return { success: false, error: "missing_product", message: "Missing product. Please try again." };
    }
    var rating = parseInt(reviewPayload.rating, 10);
    if (!(rating >= 1 && rating <= 5)) {
      return { success: false, error: "invalid_rating", message: "Please choose a rating between 1 and 5 stars." };
    }
    var body = String(reviewPayload.body || "").trim();
    if (body.length < 3) {
      return { success: false, error: "missing_body", message: "Please write a short review before submitting." };
    }

    var elig = canCustomerReviewProduct(productId);
    var cust = (global.CustomerService && global.CustomerService.getCurrentCustomer)
      ? global.CustomerService.getCurrentCustomer() : null;

    var customerName, customerId = null, location;
    if (cust) {
      customerId   = cust.customerId;
      customerName = (cust.name || reviewPayload.customerName || "").trim() || "NAFUME Customer";
      location     = (reviewPayload.customerLocation || (cust.defaultAddress && cust.defaultAddress.city) || "").trim();
      if (elig.alreadyReviewed) {
        return { success: false, error: "duplicate", message: "You have already reviewed this product." };
      }
    } else {
      customerName = String(reviewPayload.customerName || "").trim();
      if (!customerName) {
        return { success: false, error: "missing_name", message: "Please enter your name." };
      }
      location = String(reviewPayload.customerLocation || "").trim();
      // Guest duplicate guard: same name + product.
      var dupGuest = getAllReviews().some(function (r) {
        return r.productId === productId && !r.customerId &&
          (r.customerName || "").toLowerCase() === customerName.toLowerCase();
      });
      if (dupGuest) {
        return { success: false, error: "duplicate", message: "You have already reviewed this product." };
      }
    }

    var p = productById(productId);
    var review = {
      reviewId:         genReviewId(),
      productId:        productId,
      productSlug:      (p && p.slug) || (productId + ""),
      customerId:       customerId,
      customerName:     customerName,
      customerLocation: location || "",
      rating:           rating,
      title:            String(reviewPayload.title || "").trim(),
      body:             body,
      createdAt:        nowISO(),
      status:           DEFAULT_REVIEW_STATUS,
      verifiedBuyer:    !!elig.verifiedBuyer,
      source:           "local_review",
      orderId:          elig.orderId || null,
      media:            [],
      helpfulCount:     0
    };

    var all = getAllReviews();
    all.unshift(review);
    if (!saveAllReviews(all)) {
      return { success: false, error: "save_failed", message: "Could not save your review. Please try again." };
    }

    // Analytics (Upgrade 10) — safe + guarded.
    if (global.OperationsService) {
      try { global.OperationsService.recordAnalyticsEvent("review_submitted", { productId: review.productId, rating: review.rating }); } catch (e) {}
    }

    var msg = DEFAULT_REVIEW_STATUS === "published"
      ? "Thank you. Your review has been published."
      : "Thank you. Your review has been submitted and will appear after review.";
    return { success: true, review: review, message: msg };
  }

  // ── moderation (used by reviews-admin.html) ──────────────────────────────
  function updateReviewStatus(reviewId, status) {
    if (VALID_STATUSES.indexOf(status) === -1) {
      return { success: false, error: "invalid_status" };
    }
    var all = getAllReviews();
    var changed = false;
    for (var i = 0; i < all.length; i++) {
      if (all[i].reviewId === reviewId) { all[i].status = status; changed = true; break; }
    }
    if (changed) saveAllReviews(all);
    return { success: changed };
  }

  // ── featured (homepage social proof) ─────────────────────────────────────
  function getFeaturedReviews(limit) {
    limit = limit || 6;
    return getAllReviews()
      .filter(function (r) { return r.status === "published" && (parseInt(r.rating, 10) || 0) >= 4; })
      .sort(function (a, b) {
        if (!!b.verifiedBuyer !== !!a.verifiedBuyer) return b.verifiedBuyer ? 1 : -1;
        if (b.rating !== a.rating) return b.rating - a.rating;
        if ((b.helpfulCount || 0) !== (a.helpfulCount || 0)) return (b.helpfulCount || 0) - (a.helpfulCount || 0);
        return new Date(b.createdAt) - new Date(a.createdAt);
      })
      .slice(0, limit);
  }

  // ── starter seed (tasteful, realistic) ───────────────────────────────────
  // verifiedBuyer:true / source:"seed_review" / status:"published".
  function seedInitialReviewsIfEmpty() {
    if (getAllReviews().length > 0) return { seeded: false };
    if (!storageAvailable()) return { seeded: false };

    var seeds = [
      // Seduction
      ["seduction","Deeksha","Mumbai",5,"Just like the description","Smells exactly as described — premium and beautifully balanced. The packaging is well thought out and the spray quality is good."],
      ["seduction","Ananya","Pune",4,"Pleasant and warm","The rose comes through nicely. Not too loud, but noticeable. A good option for date nights and evenings."],
      ["seduction","Ritika","Jaipur",5,"Feels premium","Settles beautifully after a few minutes and lasts well through a dinner out. Packaging feels premium."],
      // Dark Oud
      ["dark-oud","Aarohi Aggarwal","Delhi",5,"Blends really well","The notes are mixed well and the fragrance settles nicely after a few minutes. Feels premium and long lasting."],
      ["dark-oud","Karan","Bengaluru",4,"Bold, better for evenings","Deep and smoky. A little goes a long way. Lasts well for office wear if you spray once."],
      ["dark-oud","Imran","Bhopal",5,"Good for gifting","Feels more expensive than the price. Strong enough for weddings and a good option for gifting."],
      // Red Spirit
      ["red-spirit","Rohit","Pune",4,"Spicy and warm","Nice spicy start that settles into a soft woody base. Noticeable but not overpowering."],
      ["red-spirit","Sneha","Delhi",5,"Got compliments","Picked up a couple of compliments at work. Lasts a good part of the day."],
      ["red-spirit","Vikram","Jaipur",4,"Comfortable daily wear","Good for daily use and not too loud for the office. Pleasant warmth."],
      // Aqua Manthan
      ["aqua-manthan","Naina","Mumbai",5,"Fresh and clean","Bought it recently and the branding looks premium. Fresh, smooth and elegant — great for daily wear."],
      ["aqua-manthan","Aditya","Bengaluru",4,"Office friendly","Clean aquatic scent that lasts well for office wear. Subtle and pleasant in the heat."],
      ["aqua-manthan","Meera","Pune",5,"Easy to wear","Light and refreshing. Works well for everyday wear and the humidity here."],
      // All Day
      ["all-day-misfit","Aditya R.","Delhi",5,"Lovely woody scent","In love with this one. Versatile and works well for both day and evening. Picks up compliments."],
      ["all-day-misfit","Tarun","Bhopal",4,"Unique coffee note","The coffee and tobacco mix is different and pleasant. Settles nicely after a while."],
      ["all-day-misfit","Pooja","Jaipur",5,"Cozy and warm","Sweet but not too much. Noticeable yet comfortable for daily wear. Good for gifting too."]
    ];

    var base = Date.now();
    var list = seeds.map(function (s, idx) {
      var p = productById(s[0]);
      return {
        reviewId:        genReviewId() + "-S" + idx,
        productId:       s[0],
        productSlug:     (p && p.slug) || (s[0] + ""),
        customerId:      null,
        customerName:    s[1],
        customerLocation: s[2],
        rating:          s[3],
        title:           s[4],
        body:            s[5],
        // stagger dates over the past few weeks for realism
        createdAt:       new Date(base - (idx + 1) * 36 * 3600 * 1000).toISOString(),
        status:          "published",
        verifiedBuyer:   true,
        source:          "seed_review",
        orderId:         null,
        media:           [],
        helpfulCount:    Math.floor(Math.random() * 6)
      };
    });
    saveAllReviews(list);
    return { seeded: true, count: list.length };
  }

  global.ReviewService = {
    getAllReviews:             getAllReviews,
    getReviewsByProductId:     getReviewsByProductId,
    getReviewSummary:          getReviewSummary,
    addReview:                 addReview,
    updateReviewStatus:        updateReviewStatus,
    canCustomerReviewProduct:  canCustomerReviewProduct,
    getFeaturedReviews:        getFeaturedReviews,
    seedInitialReviewsIfEmpty: seedInitialReviewsIfEmpty,
    // Server-backed reviews (the real ones)
    hydrateProduct:            hydrateProduct,
    getServerReviews:          getServerReviews,
    DEFAULT_REVIEW_STATUS:     DEFAULT_REVIEW_STATUS
  };

  /* ── Where reviews live now ───────────────────────────────────────────────
     Real customer reviews are captured at /pages/order/review, stored in the
     `reviews` table by POST /api/reviews/submit, moderated in
     admin/reviews-admin.html via /api/admin/reviews, and read back for the
     storefront by GET /api/reviews/list (published only). hydrateProduct()
     above pulls them onto product pages.

     The localStorage store that remains here serves the seeded starter reviews
     and keeps the older on-page "write a review" widget working offline. It is
     display-only: nothing in it can affect an order, a payment, or what is
     published, and the database is authoritative for everything real.       */
})(window);
