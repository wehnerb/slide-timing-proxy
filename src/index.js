import { fetchWithTimeout } from './shared/fetch-helpers.js';
import { escapeHtml, sanitizeParam } from './shared/html.js';

// ============================================================
// CONFIGURATION — update these values as needed
//
// TOTAL_SECONDS        : Total seconds the display system allocates
//                        to the slideshow slot. Divided equally across
//                        all slides, clamped to MIN_SECONDS minimum.
//
// MIN_SECONDS          : Minimum seconds per slide (prevents slides
//                        from cycling too fast with many slides)
//
// SLIDE_CACHE_SECONDS  : How long (seconds) the slide count is cached
//                        using the Workers Cache API. During this window
//                        the Google Slides API is called at most once
//                        regardless of request volume. Default is 3600
//                        (1 hour), suitable when slide count changes
//                        infrequently.
//
// SLIDE_CACHE_VERSION  : Integer cache-buster. Increment by 1 to
//                        immediately invalidate the cached slide count
//                        and force a fresh Google API call on the next
//                        request. Use this when the slide count changes
//                        and displays need to pick up new timing without
//                        waiting for SLIDE_CACHE_SECONDS to expire.
// ============================================================

const TOTAL_SECONDS = 60;
const MIN_SECONDS   = 5;

// How long (seconds) the slide count is cached using the Workers Cache API.
// During this window, the Google Slides API is only called once regardless
// of how many display requests come in. Increment SLIDE_CACHE_VERSION by 1
// to immediately invalidate the cache and force a fresh API call on the next
// request — useful when the slide count changes and you need displays to
// pick up the new timing without waiting for the TTL to expire.
const SLIDE_CACHE_SECONDS = 3600; // 1 hour
const SLIDE_CACHE_VERSION = 1;

// Background color applied when ?bg=dark is set — used for testing against a
// solid background to verify layout and error states without a display background.
const DARK_BG_COLOR = '#111111';


// ============================================================
// MAIN WORKER ENTRY POINT
// ============================================================
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const darkBg = url.searchParams.get('bg') === 'dark';

    const PRESENTATION_ID = env.PRESENTATION_ID;
    const PUBLISHED_ID    = env.PUBLISHED_ID;

    // Only GET requests are valid for this Worker.
    // All other HTTP methods are rejected immediately before any processing occurs.
    if (request.method !== "GET") {
      return buildErrorPage("METHOD NOT ALLOWED", "Only GET requests are accepted", 405, darkBg);
    }

    // Guard: catch missing secrets before making any API calls
    if (!PRESENTATION_ID || PRESENTATION_ID === "YOUR_PRESENTATION_ID_HERE") {
      return buildErrorPage("CONFIGURATION ERROR", "PRESENTATION_ID secret is not set", 500, darkBg);
    }

    if (!PUBLISHED_ID || PUBLISHED_ID === "YOUR_PUBLISHED_ID_HERE") {
      return buildErrorPage("CONFIGURATION ERROR", "PUBLISHED_ID secret is not set", 500, darkBg);
    }

    if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      return buildErrorPage(
        'CONFIGURATION ERROR',
        'GOOGLE_SERVICE_ACCOUNT_EMAIL secret is not set',
        500,
        darkBg
      );
    }

    if (!env.GOOGLE_PRIVATE_KEY) {
      return buildErrorPage(
        'CONFIGURATION ERROR',
        'GOOGLE_PRIVATE_KEY secret is not set',
        500,
        darkBg
      );
    }

    // --------------------------------------------------------
    // FETCH SLIDE COUNT — WITH CACHE
    // Checks the Workers Cache API before calling Google.
    // The cache key includes SLIDE_CACHE_VERSION so incrementing
    // that constant immediately busts the cache and forces a fresh
    // API call on the next request, without waiting for the TTL.
    // Falls back to slideCount = 1 if both cache and API fail.
    // --------------------------------------------------------
    let slideCount = 1;

    // Build a fully-qualified cache key URL. The Workers Cache API
    // requires a valid URL string as the key — it is never fetched.
    const cacheKey = new Request(
      "https://slide-timing-cache.internal/slide-count" +
      "?pid=" + PRESENTATION_ID +
      "&v="   + SLIDE_CACHE_VERSION
    );
    const cache = caches.default;

    // Check the cache first
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      // Cache hit — read the stored slide count directly
      const cachedText = await cachedResponse.text();
      const parsed = parseInt(cachedText, 10);
      if (!isNaN(parsed)) {
        slideCount = parsed;
      }
    } else {
      // Cache miss — call the Google Slides API
      try {
        const token = await getAccessToken(
          env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
          env.GOOGLE_PRIVATE_KEY
        );

        const apiUrl =
          "https://slides.googleapis.com/v1/presentations/" + PRESENTATION_ID +
          "?fields=slides.objectId";

        const apiResponse = await fetchWithTimeout(apiUrl, {
          headers: { "Authorization": "Bearer " + token },
        }, 8000);

        if (!apiResponse.ok) {
          throw new Error("Google API returned status " + apiResponse.status);
        }

        const data = await apiResponse.json();
        slideCount = (data.slides || []).length;

        // Store the slide count in the cache for SLIDE_CACHE_SECONDS.
        // Only cache a valid positive count — do not cache zero, as the
        // no-content page handles that case with its own 60s auto-refresh.
        if (slideCount > 0) {
          const responseToCache = new Response(String(slideCount), {
            headers: {
              "Cache-Control": "public, max-age=" + SLIDE_CACHE_SECONDS,
              "Content-Type":  "text/plain",
            },
          });
          await cache.put(cacheKey, responseToCache);
        }

      } catch (e) {
        console.error(
          'slide-timing-proxy: Google Slides API call failed, ' +
          'falling back to slideCount = 1. Error: ' +
          (e && e.message ? e.message : String(e))
        );
      }
    }

    // --------------------------------------------------------
    // NO SLIDES — return friendly info screen instead of redirect
    // --------------------------------------------------------
    if (slideCount === 0) {
      return new Response(buildNoContentPage(darkBg), {
        headers: {
          "Content-Type":           "text/html; charset=utf-8",
          "Cache-Control":          "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy":        "no-referrer",
        },
      });
    }

    // --------------------------------------------------------
    // CALCULATE PER-SLIDE DURATION and build the embed URL.
    //
    // Uses the pubembed URL format with PUBLISHED_ID, which
    // starts the presentation from slide 1 on every fresh load.
    // A cache-busting timestamp (cb) is appended to prevent
    // the display system's browser from serving a cached copy
    // of the embed page between rotation cycles.
    // --------------------------------------------------------
    const secondsPerSlide = Math.min(
      TOTAL_SECONDS,
      Math.max(MIN_SECONDS, Math.floor(TOTAL_SECONDS / slideCount))
    );
    const delayMs = secondsPerSlide * 1000;

    const embedUrl =
  "https://docs.google.com/presentation/d/e/" + PUBLISHED_ID +
  "/pubembed?start=true&loop=true&delayms=" + delayMs + "&rm=minimal&cb=" + Date.now();

    // --------------------------------------------------------
    // REDIRECT — send the display directly to the embed URL.
    // The slideshow slot is first in the rotation, so the
    // presentation is already visible when the page loads and
    // no pre-fetch delay is needed. Cache-Control: no-store
    // ensures the display always re-checks slide count on the
    // next cycle rather than serving a stale redirect.
    // --------------------------------------------------------
    return Response.redirect(embedUrl, 302);
  },
};


// ============================================================
// SERVICE ACCOUNT AUTHENTICATION
// Generates a short-lived OAuth2 access token from the
// service account credentials stored as Worker secrets.
// Uses the Web Crypto API built into Cloudflare Workers —
// no external libraries or dependencies required.
// ============================================================
async function getAccessToken(email, rawPrivateKey) {

  // --------------------------------------------------------
  // STEP 1 — Build the JWT header and payload
  // Google requires RS256-signed JWTs for service accounts
  // --------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);

  const header  = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss:   email,
    scope: "https://www.googleapis.com/auth/presentations.readonly",
    aud:   "https://oauth2.googleapis.com/token",
    iat:   now,
    exp:   now + 3600,
  }));

  const signingInput = header + "." + payload;

  // --------------------------------------------------------
  // STEP 2 — Import the private key using Web Crypto API
  // The raw key arrives with literal \n sequences from the
  // GitHub secret — convert those to real newlines first,
  // then strip the PEM header/footer and decode to binary.
  // --------------------------------------------------------
  const pemString = rawPrivateKey.replace(/\\n/g, "\n");

  const pemBody = pemString
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\n/g, "")
    .trim();

  const binaryKey = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // --------------------------------------------------------
  // STEP 3 — Sign the JWT with the private key
  // Uses a safe byte-by-byte loop to avoid stack overflow
  // on large buffers that spread operator can cause
  // --------------------------------------------------------
  const encoder = new TextEncoder();
  const signatureBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    encoder.encode(signingInput)
  );

  const jwt = signingInput + "." + arrayBufferToBase64url(signatureBuf);

  // --------------------------------------------------------
  // STEP 4 — Exchange the signed JWT for an access token
  // --------------------------------------------------------
  const tokenResponse = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt,
  }, 10000);

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    throw new Error("Token exchange failed (" + tokenResponse.status + "): " + errText);
  }

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}


// ============================================================
// UTILITY FUNCTIONS
// ============================================================

// Encodes a string to base64url format (used in JWT building)
function base64url(str) {
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// Safely converts an ArrayBuffer to base64url without using
// spread operator, which can overflow the stack on large buffers
function arrayBufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}


// ============================================================
// BUILD ERROR PAGE
// Returns a full-page styled HTML error response.
// Used for configuration errors and rejected HTTP methods.
// Accepts custom title and subtitle text so each error scenario
// displays a specific, actionable message on screen.
// The ?bg=dark parameter applies a solid dark background for
// testing; production displays use a transparent background.
// ============================================================
function buildErrorPage(title, subtitle, status, darkBg = false) {
  const html =
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<style>' +
    '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body {' +
    '  width: 100vw; height: 100vh;' +
    '  overflow: hidden;' +
    '  background: ' + (darkBg ? DARK_BG_COLOR : 'transparent') + ';' +
    '  font-family: "Segoe UI", Arial, Helvetica, sans-serif;' +
    '  display: flex; align-items: center; justify-content: center;' +
    '}' +
    '.err-wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; padding: 0 5vw; }' +
    '.err-title { font-size: 1.8rem; font-weight: 700; color: #C8102E; letter-spacing: 0.06em; }' +
    '.err-sub   { font-size: 1.1rem; color: rgba(255,255,255,0.92); }' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<div class="err-wrap">' +
    '<div class="err-title">' + title + '</div>' +
    '<div class="err-sub">' + subtitle + '</div>' +
    '</div>' +
    '</body>' +
    '</html>';

  return new Response(html, {
    status,
    headers: {
      'Content-Type':           'text/html; charset=UTF-8',
      'Cache-Control':          'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}


// ============================================================
// NO CONTENT PAGE
// Displayed when the presentation exists but has zero slides.
// Auto-refreshes every 60 seconds to check for new content.
// Follows system design language — transparent background in
// production, solid dark background when ?bg=dark is set.
// ============================================================
function buildNoContentPage(darkBg = false) {
  return '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<meta http-equiv="refresh" content="60">' +
    '<style>' +
    '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body {' +
    '  width: 100vw; height: 100vh;' +
    '  overflow: hidden;' +
    '  background: ' + (darkBg ? DARK_BG_COLOR : 'transparent') + ';' +
    '  font-family: "Segoe UI", Arial, Helvetica, sans-serif;' +
    '  display: flex; align-items: center; justify-content: center;' +
    '}' +
    '.wrap { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; padding: 0 5vw; }' +
    '.title { font-size: 1.8rem; font-weight: 700; color: #C8102E; letter-spacing: 0.06em; }' +
    '.sub   { font-size: 1.1rem; color: rgba(255,255,255,0.92); max-width: 480px; line-height: 1.6; }' +
    '.note  { font-size: 0.85rem; color: rgba(255,255,255,0.38); margin-top: 4px; }' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<div class="wrap">' +
    '<div class="title">NO CONTENT AVAILABLE</div>' +
    '<div class="sub">There are currently no slides to display. This screen will refresh automatically when content is added.</div>' +
    '<div class="note">Auto-refreshes every 60 seconds &mdash; no action needed.</div>' +
    '</div>' +
    '</body>' +
    '</html>';
}
