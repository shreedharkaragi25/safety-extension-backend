// background.js
// Watches for Google search navigations, checks the query against a concern
// list, and (a) shows the searcher an immediate in-browser resource card,
// and (b) notifies the configured trusted contact via the backend.

const DEFAULT_SETTINGS = {
  backendUrl: "http://localhost:3000/alert",
  contactEmail: "",
  deviceOwnerLabel: "", // e.g. "Alex's laptop" - helps the parent know which device
  transparencyMode: true // if true, the extension tells the user an alert was sent
};

// Keep this list short and pattern-level, not an exhaustive script.
// Tune it based on false-positive testing; consider a small ML classifier later.
const CONCERN_PATTERNS = [
  /\bsuicide\b/i,
  /\bkill myself\b/i,
  /\bend my life\b/i,
  /\bwant to die\b/i,
  /\bpainless (way to )?die\b/i,
  /\bhow to die\b/i,
  /\bself[\s-]?harm\b/i,
  /\bno reason to live\b/i
];

// Simple in-memory de-dupe so we don't fire multiple alerts for the same
// query within a short window (e.g. autocomplete triggering multiple navs).
const recentAlerts = new Map();
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function extractQuery(url) {
  try {
    const u = new URL(url);
    if (!/google\./.test(u.hostname)) return null;
    if (u.pathname !== "/search") return null;
    return u.searchParams.get("q");
  } catch {
    return null;
  }
}

function matchesConcern(query) {
  if (!query) return false;
  return CONCERN_PATTERNS.some((re) => re.test(query));
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function sendAlert(query, settings) {
  if (!settings.contactEmail || !settings.backendUrl) {
    console.warn("Alert triggered but backend/contact not configured.");
    return;
  }
  try {
    await fetch(settings.backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contactEmail: settings.contactEmail,
        deviceOwnerLabel: settings.deviceOwnerLabel,
           timestamp: new Date().toISOString(),
      searchQuery: query
      })
    });
  } catch (err) {
    console.error("Failed to send alert:", err);
  }
}

function showSearcherResources() {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon48.png",
    title: "You're not alone",
    message:
      "If you're going through something hard, support is available 24/7. Click for resources.",
    priority: 2,
    requireInteraction: true
  });
}

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: "resources.html" });
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return; // top-level frame only
  const query = extractQuery(details.url);
  if (!query) return;
  if (!matchesConcern(query)) return;

  const key = query.trim().toLowerCase();
  const now = Date.now();
  const last = recentAlerts.get(key);
  if (last && now - last < DEDUPE_WINDOW_MS) return;
  recentAlerts.set(key, now);

  const settings = await getSettings();

  // Always show the searcher resources first - this is the highest-value action.
  showSearcherResources();

  // Then notify the trusted contact.
  await sendAlert(query, settings);

    // Disclosure is always shown — this is not optional, by design.
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon48.png",
    title: "Check-in sent",
    message:
      "This device is set up to let a trusted contact know when a search like this happens, so they were notified.",
    priority: 1
  });
});
