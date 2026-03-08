# 🚒 Slide Timing Proxy

A Cloudflare Worker that dynamically adjusts Google Slides per-slide timing to fit within a defined display time window.

---

## Overview

Station display screens are configured with a fixed time slot for showing a Google Slides presentation — for example, 60 seconds. However, the number of slides in the presentation changes over time. Without intervention, timing is either set too long (wasting display time when there are few slides) or too short (slides fly by when there are many).

This Worker solves the problem by:

- Querying the Google Slides API on every request to get the current slide count
- Dividing the total allotted time equally across all slides
- Redirecting the display to the Google Slides embed URL with the correct `delayms` timing parameter already calculated

The display is configured with a single Worker URL and requires no further maintenance when slides are added or removed — timing adjusts automatically.

**Production URL:** `https://slide-timing-proxy.bwehner.workers.dev/`  
**Staging URL:** `https://slide-timing-proxy-staging.bwehner.workers.dev/`

---

## How It Works

```
Display Screen → Cloudflare Worker → Google Slides API → Redirect to Slides Embed URL
```

1. The display screen loads the Worker URL
2. The Worker authenticates with Google Slides API using a service account
3. The API returns the current number of slides in the configured presentation
4. Per-slide delay is calculated: `TOTAL_SECONDS ÷ slide count`, clamped to `MIN_SECONDS`
5. The Worker issues an HTTP 302 redirect to the Google Slides embed URL with the correct `delayms` value
6. The display follows the redirect and loads the presentation with correct timing

---

## Timing Logic

| Slide Count | Total Seconds | Per-Slide Delay | Notes |
|-------------|--------------|-----------------|-------|
| 0 | 60 | N/A | No-content screen shown, auto-refreshes every 60s |
| 1 | 60 | 60s | Single slide uses full allotted time |
| 2 | 60 | 30s | Normal equal division |
| 6 | 60 | 10s | Normal equal division |
| 12 | 60 | 5s | Hits minimum cap (`MIN_SECONDS = 5`) |
| API fails | 60 | 60s | Safe fallback: slide count defaults to 1 |

---

## Configuration

All configurable values are at the top of `src/index.js`. **No other part of the file should need editing for normal operation.**

```js
const PRESENTATION_ID = "YOUR_PRESENTATION_ID_HERE"; // Google Slides presentation ID
const TOTAL_SECONDS   = 60;  // Total seconds allotted to the slideshow
const MIN_SECONDS     = 5;   // Minimum seconds per slide
```

### Finding the Presentation ID

The `PRESENTATION_ID` is the long alphanumeric string in the Google Slides URL between `/d/` and `/edit`:

```
https://docs.google.com/presentation/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit
                                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                       This is the PRESENTATION_ID
```

> **Important:** The presentation must be set to **"Anyone with the link can view"** for the embed to work on the display screen.

---

## No-Content Screen

If the presentation has zero slides, the Worker returns a styled HTML page instead of redirecting. The screen displays:

- Dark navy background
- Clipboard icon
- **NO CONTENT AVAILABLE** message
- Subtitle explaining the system is working correctly but has no slides to show
- Auto-refreshes every 60 seconds — the display will recover automatically as soon as slides are added

This ensures anyone seeing the display understands it is a content issue, not a system failure.

---

## Authentication

The Google Slides API no longer accepts simple API keys — it requires OAuth2 authentication. This Worker uses a **Google Service Account** to authenticate server-to-server without any user login.

- Authentication is handled entirely using Cloudflare's built-in **Web Crypto API** — no external libraries required
- A short-lived OAuth2 access token is generated on each request using an RSA-signed JWT
- The service account has **read-only** access to the Slides API (`presentations.readonly`) only — no access to Drive, Gmail, or any other Google services

---

## Deployment

This Worker uses GitHub Actions to deploy automatically to Cloudflare on every push.

| Branch | Deploys To |
|--------|-----------|
| `staging` | `slide-timing-proxy-staging.bwehner.workers.dev` |
| `main` | `slide-timing-proxy.bwehner.workers.dev` |

**All changes must go through staging before merging to main.**

### Required GitHub Secrets

Set these under **Settings → Secrets and variables → Actions** in this repository:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers edit permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID (found on any zone page in the dashboard) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email from the Google Cloud JSON key file |
| `GOOGLE_PRIVATE_KEY` | Private key from the Google Cloud JSON key file — include all `\n` characters exactly as they appear |

> **Important:** After the first deployment of a new Worker environment, verify that secrets are also present in the Cloudflare dashboard under **Workers & Pages → [Worker Name] → Settings → Variables and Secrets**. If missing, they can be added manually without redeploying.

### Setting Up Google Service Account Credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and open the `slide-timing` project
2. Go to **IAM & Admin → Service Accounts**
3. Click on the `slide-timing-worker` service account
4. Go to the **Keys** tab → **Add Key → Create new key → JSON**
5. Open the downloaded JSON file and copy two values into GitHub Secrets:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY` (copy everything between the outer quotes, including all `\n` characters)

> **Security Note:** The private key is a sensitive credential. It is stored only in GitHub Secrets and Cloudflare Worker secrets — never in the code itself. If a key is ever suspected to be compromised, delete it immediately in Google Cloud Console under **IAM & Admin → Service Accounts → Keys** and generate a new one.

### Making a Change

1. Edit the relevant file(s) on the `staging` branch using the GitHub browser editor
2. Commit directly to `staging` — GitHub Actions will deploy to the staging Worker within ~30 seconds
3. Test the staging URL thoroughly
4. Merge `staging` into `main` — GitHub Actions will deploy to production automatically
5. Verify the production URL is working correctly

---

## Troubleshooting

| Symptom | Likely Cause | Resolution |
|---------|-------------|------------|
| Error: `PRESENTATION_ID has not been set` | Placeholder ID not replaced in `src/index.js` | Edit `src/index.js` on the staging branch and replace `YOUR_PRESENTATION_ID_HERE` with the correct ID |
| Slides cycling at 60s each regardless of count | API call failing silently — falling back to `slideCount = 1` | Check that Worker secrets are present in Cloudflare dashboard under **Workers & Pages → [Worker Name] → Settings → Variables and Secrets** |
| Slides not loading on display at all | Presentation not set to public | Set the Google Slides sharing to "Anyone with the link can view" |
| No-content screen showing unexpectedly | Presentation has zero slides | Add at least one slide to the presentation — the display will recover automatically within 60 seconds |
| GitHub Actions deployment fails | Invalid or expired API token or secret | Check the Actions log for details; re-create the failing secret and re-run the workflow |

---

## Network Requirements

Display screens must have outbound HTTPS access (port 443) to:

- `*.workers.dev` — Cloudflare Worker endpoint
- `docs.google.com` — Google Slides embed
- `slides.googleapis.com` — Google Slides API (accessed by the Worker, not the display)
- `oauth2.googleapis.com` — Google OAuth2 token exchange (accessed by the Worker, not the display)

---

## Service Limits

| Service | Free Tier Limit | Current Usage |
|---------|----------------|---------------|
| Cloudflare Workers | 100,000 requests/day | Well within limit |
| Google Slides API | 300 requests/minute | ~2 requests/minute at 8 stations — well within limit |

---

## Related

- [station-image-proxy](https://github.com/wehnerb/station-image-proxy) — Image resizing and caching Worker
- Full system documentation is maintained separately as `fire_station_display_documentation.docx`
