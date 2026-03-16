// ============================================================
// CONFIGURATION — update these values as needed
//
// TOTAL_SECONDS        : Total seconds the display system allocates
//                        to the slideshow slot. Divided equally across
//                        all slides, clamped to MIN_SECONDS minimum.
//                        The delay occurs before the display system
//                        timer starts, so this value does not need
//                        to be adjusted to account for the delay.
//
// MIN_SECONDS          : Minimum seconds per slide (prevents slides
//                        from cycling too fast with many slides)
//
// DEFAULT_DELAY_SECONDS: Fallback delay used when the ?screens=
//                        parameter is missing from the URL or its
//                        value is not found in DELAY_BY_SCREENS.
//                        Set conservatively high to be safe.
//
// DELAY_BY_SCREENS     : Lookup table mapping the number of traffic
//                        camera screens at a station to the correct
//                        pre-fetch delay in seconds. The ?screens=
//                        URL parameter selects the entry to use.
//                        Determined through testing on actual display
//                        hardware — adjust individual values as needed.
//                        Add new entries if a station ever has more
//                        than 4 traffic camera screens.
// ============================================================
const TOTAL_SECONDS         = 60;
const MIN_SECONDS           = 5;
const DEFAULT_DELAY_SECONDS = 90;

// How long (seconds) the slide count is cached using the Workers Cache API.
// During this window, the Google Slides API is only called once regardless
// of how many display requests come in. Increment SLIDE_CACHE_VERSION by 1
// to immediately invalidate the cache and force a fresh API call on the next
// request — useful when the slide count changes and you need displays to
// pick up the new timing without waiting for the TTL to expire.
const SLIDE_CACHE_SECONDS = 3600; // 1 hour
const SLIDE_CACHE_VERSION = 1;

const DELAY_BY_SCREENS = {
  1: 60,   // 1 traffic camera screen
  2: 60,   // 2 traffic camera screens
  3: 60,   // 3 traffic camera screens
  4: 90,   // 4 traffic camera screens
  5: 90,   // 5 traffic camera screens
};


// ============================================================
// MAIN WORKER ENTRY POINT
// ============================================================
export default {
async fetch(request, env) {
    const PRESENTATION_ID = env.PRESENTATION_ID;
    const PUBLISHED_ID    = env.PUBLISHED_ID;

    // Only GET requests are valid for this Worker.
    // All other HTTP methods are rejected immediately before any processing occurs.
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: { 'Allow': 'GET' } });
    }

    // Guard: catch placeholder IDs before making any API calls
    if (!PRESENTATION_ID || PRESENTATION_ID === "YOUR_PRESENTATION_ID_HERE") {
      return new Response("PRESENTATION_ID has not been set in index.js", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (!PUBLISHED_ID || PUBLISHED_ID === "YOUR_PUBLISHED_ID_HERE") {
      return new Response("PUBLISHED_ID has not been set in index.js", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // --------------------------------------------------------
    // RESOLVE DELAY FROM ?screens= URL PARAMETER
    // Parse the screens parameter and look up the correct delay.
    // Falls back to DEFAULT_DELAY_SECONDS if the parameter is
    // missing, not a number, or not found in DELAY_BY_SCREENS.
    // --------------------------------------------------------
    const url = new URL(request.url);
    const screensParam = url.searchParams.get("screens");
    const screensCount = parseInt(screensParam, 10);
    const initialDelaySeconds =
      (!isNaN(screensCount) && screensCount in DELAY_BY_SCREENS)
        ? DELAY_BY_SCREENS[screensCount]
        : DEFAULT_DELAY_SECONDS;

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

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const apiUrl =
          "https://slides.googleapis.com/v1/presentations/" + PRESENTATION_ID +
          "?fields=slides.objectId";

        const apiResponse = await fetch(apiUrl, {
          signal: controller.signal,
          headers: { "Authorization": "Bearer " + token },
        });
        clearTimeout(timeoutId);

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
        // API failed or timed out — fall through with slideCount = 1 (max delay)
      }
    }

    // --------------------------------------------------------
    // NO SLIDES — return friendly info screen instead of redirect
    // --------------------------------------------------------
    if (slideCount === 0) {
      return new Response(buildNoContentPage(), {
        headers: {
          "Content-Type":          "text/html; charset=utf-8",
          "Cache-Control":         "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy":        "no-referrer",
        },
      });
    }

    // --------------------------------------------------------
    // CALCULATE PER-SLIDE DELAY and build the embed URL.
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
      `https://docs.google.com/presentation/d/e/${PUBLISHED_ID}` +
      `/pubembed?start=true&loop=true&delayms=${delayMs}&cb=${Date.now()}`;

    // --------------------------------------------------------
    // DELAY PAGE — returned instead of an immediate redirect.
    // The display system pre-fetches this page before the
    // slideshow slot becomes visible on screen. This page waits
    // initialDelaySeconds (resolved from the ?screens= parameter)
    // before navigating, ensuring the presentation always starts
    // from slide 1 when it becomes visible.
    // Cache-Control: no-store ensures the display always
    // re-checks slide count rather than serving stale timing.
    // --------------------------------------------------------
    return new Response(buildDelayPage(embedUrl, initialDelaySeconds), {
      headers: {
        "Content-Type":          "text/html; charset=utf-8",
        "Cache-Control":         "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy":        "no-referrer",
      },
    });
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

  const signingInput = `${header}.${payload}`;

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

  const jwt = `${signingInput}.${arrayBufferToBase64url(signatureBuf)}`;

  // --------------------------------------------------------
  // STEP 4 — Exchange the signed JWT for an access token
  // --------------------------------------------------------
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text();
    throw new Error(`Token exchange failed (${tokenResponse.status}): ${errText}`);
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
// DELAY PAGE
// Returned to the display instead of an immediate redirect.
// Shows a plain dark screen for the resolved delay duration
// before navigating to the Google Slides embed URL. This
// prevents the presentation from cycling in the background
// during the display system's pre-fetch window before the
// slideshow slot becomes visible on screen.
// ============================================================
function buildDelayPage(embedUrl, delaySeconds) {
  const delayMs = delaySeconds * 1000;

  // SECURITY NOTE: embedUrl is injected directly into a <script> block as a string literal.
  // This is safe ONLY because embedUrl is constructed entirely from hardcoded constants
  // (PUBLISHED_ID) and Date.now(). It must NEVER be extended to include any user-supplied
  // input (e.g. URL parameters), any external API response value, or any other untrusted
  // data. Injecting untrusted content here without proper escaping would create a
  // cross-site scripting (XSS) vulnerability allowing arbitrary script execution in the
  // display browser.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Loading...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0d1b2a;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
    }
  </style>
  <script>
    // Wait for the resolved delay before navigating to the embed URL.
    // Google Slides does not begin loading during this delay, so the
    // presentation always starts cleanly from slide 1 when navigation
    // fires, regardless of when the display system pre-fetched this page.
    setTimeout(function() {
      window.location.href = "${embedUrl}";
    }, ${delayMs});
  </script>
</head>
<body>
  <!-- Intentionally blank dark screen shown during the delay period. -->
</body>
</html>`;
}


// ============================================================
// NO CONTENT PAGE
// Displayed when the presentation exists but has zero slides.
// Auto-refreshes every 60 seconds to check for new content.
// ============================================================
function buildNoContentPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>No Content</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0d1b2a;
      color: #ffffff;
      font-family: Arial, Helvetica, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      text-align: center;
      gap: 20px;
    }
    .badge {
      width: 100px;
      height: 100px;
      border-radius: 50%;
      background: #1e3a5f;
      border: 4px solid #2e6da4;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 48px;
    }
    h1 {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      color: #e8f0fe;
    }
    .subtitle {
      font-size: 1.1rem;
      color: #8ab4d8;
      max-width: 420px;
      line-height: 1.6;
    }
    .note {
      font-size: 0.85rem;
      color: #4a6a8a;
      margin-top: 10px;
    }
    .divider {
      width: 60px;
      height: 3px;
      background: #2e6da4;
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <div class="badge">&#128203;</div>
  <div class="divider"></div>
  <h1>NO CONTENT AVAILABLE</h1>
  <p class="subtitle">There are currently no slides to display. This screen will refresh automatically when content is added.</p>
  <p class="note">This page auto-refreshes every 60 seconds &mdash; no action needed.</p>
</body>
</html>`;
}
