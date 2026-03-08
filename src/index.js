const PRESENTATION_ID = "10JVNXp6ucL41ICkwqksODqIc2Att5ICA8Y7oG3TcdZo";
const TOTAL_SECONDS = 60;
const MIN_SECONDS = 10;
const MAX_SECONDS = 60;

export default {
  async fetch(request, env) {

    // Guard: catch placeholder ID before making any API calls
    if (!PRESENTATION_ID || PRESENTATION_ID === "YOUR_PRESENTATION_ID_HERE") {
      return new Response("PRESENTATION_ID has not been set in index.js", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      });
    }

    let slideCount = 1; // safe default if API call fails

    try {
      // Abort the API call if Google doesn't respond within 5 seconds
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const apiUrl =
        `https://slides.googleapis.com/v1/presentations/${PRESENTATION_ID}` +
        `?fields=slides.objectId&key=${env.GOOGLE_API_KEY}`;

      const apiResponse = await fetch(apiUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!apiResponse.ok) {
        throw new Error(`Google API returned status ${apiResponse.status}`);
      }

      const data = await apiResponse.json();
      slideCount = (data.slides || []).length;

    } catch (e) {
      // API failed or timed out — fall through with slideCount = 1 (max delay, safe default)
    }

    // No slides — return a friendly info screen instead of a broken redirect
    if (slideCount === 0) {
      return new Response(buildNoContentPage(), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // Calculate per-slide delay, respecting min/max bounds
    const secondsPerSlide = Math.min(
      MAX_SECONDS,
      Math.max(MIN_SECONDS, Math.floor(TOTAL_SECONDS / slideCount))
    );
    const delayMs = secondsPerSlide * 1000;

    const redirectUrl =
      `https://docs.google.com/presentation/d/${PRESENTATION_ID}` +
      `/embed?start=true&loop=true&delayms=${delayMs}`;

    // no-store ensures the display always re-checks slide count rather than
    // caching the redirect and using stale timing forever
    return Response.redirect(redirectUrl, 302, {
      headers: { "Cache-Control": "no-store" },
    });
  },
};

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
