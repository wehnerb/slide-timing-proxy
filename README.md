# Slide Timing Proxy

A Cloudflare Worker that queries the Google Slides API for the current slide count, divides a fixed time window equally across all slides, and redirects the display to the Slides embed URL with the correct timing — automatically adjusting whenever slides are added or removed.

## 📄 System Documentation
Full documentation (architecture, setup, account transfer, IT reference): https://github.com/wehnerb/ffd-display-system-documentation

---

## Live URLs

| Environment | URL |
|---|---|
| Production | `https://slide-timing-proxy.bwehner.workers.dev/` |
| Staging | `https://slide-timing-proxy-staging.bwehner.workers.dev/` |

---

## Configuration (`src/index.js`)

| Constant | Default | Description |
|---|---|---|
| `TOTAL_SECONDS` | `60` | Total seconds allotted to the slideshow |
| `MIN_SECONDS` | `5` | Minimum seconds per slide |
| `SLIDE_CACHE_SECONDS` | `3600` | How long to cache the slide count (1 hour) |
| `SLIDE_CACHE_VERSION` | *(current)* | Increment to immediately invalidate the slide count cache |

---

## Secrets

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token — Workers edit permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email — shared with `daily-message-display` |
| `GOOGLE_PRIVATE_KEY` | RSA private key from Google Cloud JSON key file — shared with `daily-message-display` |
| `PRESENTATION_ID` | Slides presentation ID — found in the URL between `/d/` and `/edit` |
| `PUBLISHED_ID` | Slides embed ID — found in the publish-to-web URL between `/d/e/` and `/pubembed` |

---

## Deployment

| Branch | Deploys To | Purpose |
|---|---|---|
| `staging` | `slide-timing-proxy-staging.bwehner.workers.dev` | Testing |
| `main` | `slide-timing-proxy.bwehner.workers.dev` | Production |

Push to either branch — GitHub Actions deploys automatically (~30–45 sec).  
**Always stage and test before merging to main.**  
To roll back: use the Cloudflare dashboard **Deployments** tab, then revert the commit on `main`.
