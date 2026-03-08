// ============================================================
// CONFIGURATION — update these values for each display board
// PRESENTATION_ID      : Google Slides presentation ID (from URL)
// TOTAL_SECONDS        : Total seconds the display system allocates
//                        to the slideshow slot. The timing calculation
//                        uses this value directly — the splash delay
//                        occurs before the display system timer starts
//                        so no adjustment to this value is needed.
// MIN_SECONDS          : Minimum seconds per slide (prevents slides
//                        from cycling too fast with many slides)
// INITIAL_DELAY_SECONDS: Seconds to show the splash screen while
//                        Google Slides loads silently in the background.
//                        Increase this value if the first slide still
//                        appears mid-presentation on the display system.
// ============================================================
const PRESENTATION_ID       = "10JVNXp6ucL41ICkwqksODqIc2Att5ICA8Y7oG3TcdZo";
const TOTAL_SECONDS         = 60;
const MIN_SECONDS           = 5;
const INITIAL_DELAY_SECONDS = 5;


// ============================================================
// MAIN WORKER ENTRY POINT
// ============================================================
export default {
  async fetch(request, env) {

    // Guard: catch placeholder ID before making any API calls
    if (!PRESENTATION_ID || PRESENTATION_ID === "YOUR_PRESENTATION_ID_HERE") {
      return new Response("PRESENTATION_ID has not been set in index.js", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // --------------------------------------------------------
    // FETCH SLIDE COUNT FROM GOOGLE SLIDES API
    // Falls back to slideCount = 1 (max delay) if call fails
    // --------------------------------------------------------
    let slideCount = 1;

    try {
      const token = await getAccessToken(
        env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        env.GOOGLE_PRIVATE_KEY
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const apiUrl =
        `https://slides.googleapis.com/v1/presentations/${PRESENTATION_ID}` +
        `?fields=slides.objectId`;

      const apiResponse = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { "Authorization": `Bearer ${token}` },
      });
      clearTimeout(timeoutId);

      if (!apiResponse.ok) {
        throw new Error(`Google API returned status ${apiResponse.status}`);
      }

      const data = await apiResponse.json();
      slideCount = (data.slides || []).length;

    } catch (e) {
      // API failed or timed out — fall through with slideCount = 1 (max delay)
    }

    // --------------------------------------------------------
    // NO SLIDES — return friendly info screen instead of redirect
    // --------------------------------------------------------
    if (slideCount === 0) {
      return new Response(buildNoContentPage(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // --------------------------------------------------------
    // CALCULATE PER-SLIDE DELAY and build the embed URL.
    // TOTAL_SECONDS is used directly here — the splash delay
    // occurs before the display system timer starts, so slide
    // timing does not need to be adjusted to account for it.
    // --------------------------------------------------------
    const secondsPerSlide = Math.min(
      TOTAL_SECONDS,
      Math.max(MIN_SECONDS, Math.floor(TOTAL_SECONDS / slideCount))
    );
    const delayMs = secondsPerSlide * 1000;

    const embedUrl =
      `https://docs.google.com/presentation/d/${PRESENTATION_ID}` +
      `/embed?start=true&loop=true&delayms=${delayMs}`;

    // --------------------------------------------------------
    // SPLASH PAGE — shown for INITIAL_DELAY_SECONDS before the
    // browser navigates to the Google Slides embed URL. Keeping
    // the embed URL out of the page until the delay completes
    // ensures Google Slides always starts cleanly from slide 1.
    // Cache-Control: no-store ensures the display always
    // re-checks slide count rather than serving stale timing.
    // --------------------------------------------------------
    return new Response(buildSplashPage(embedUrl), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
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
// SPLASH PAGE
// Shown for INITIAL_DELAY_SECONDS before navigating to the
// Google Slides embed URL. The delay ensures the display system
// is fully ready before the presentation starts, so Google Slides
// always receives a clean start from slide 1.
//
// The navigation is triggered by a JavaScript setTimeout rather
// than a CSS animation or iframe preload — this guarantees the
// presentation has not begun cycling in the background before
// it becomes visible on screen.
// ============================================================
function buildSplashPage(embedUrl) {
  const delayMs = INITIAL_DELAY_SECONDS * 1000;

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
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
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
      font-family: Arial, Helvetica, sans-serif;
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: 0.05em;
      color: #e8f0fe;
    }

    .divider {
      width: 60px;
      height: 3px;
      background: #2e6da4;
      border-radius: 2px;
    }
  </style>

  <script>
    // After INITIAL_DELAY_SECONDS, navigate to the Google Slides embed.
    // The presentation has not started loading during the delay, so it
    // will always begin cleanly from slide 1 when navigation occurs.
    setTimeout(function() {
      window.location.href = "${embedUrl}";
    }, ${delayMs});
  </script>
</head>
<body>
  <div class="badge">&#128202;</div>
  <div class="divider"></div>
  <h1>LOADING PRESENTATION</h1>
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
