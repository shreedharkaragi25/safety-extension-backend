import express from "express";
import cors from "cors";
import { Resend } from "resend";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json());
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));
app.use("/family-dashboard", express.static(path.join(__dirname, "family-dashboard")));
const resend = new Resend(process.env.RESEND_API_KEY);
const lastSent = new Map();
const MIN_INTERVAL_MS = 2 * 60 * 1000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me-in-render";

// --- Alert history store ---
const STORE_PATH = path.join(__dirname, "alerts.json");
function loadAlerts() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return [];
  }
}
function saveAlert(record) {
  const alerts = loadAlerts();
  alerts.unshift(record);
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(alerts, null, 2));
  } catch (err) {
    console.error("Failed to persist alert history:", err);
  }
}

// --- Family store ---
const FAMILIES_PATH = path.join(__dirname, "families.json");
function loadFamilies() {
  try {
    return JSON.parse(fs.readFileSync(FAMILIES_PATH, "utf-8"));
  } catch {
    return [];
  }
}
function saveFamilies(families) {
  fs.writeFileSync(FAMILIES_PATH, JSON.stringify(families, null, 2));
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function generateFamilyCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}
function signSession(familyId) {
  const expiry = Date.now() + 1000 * 60 * 60 * 24 * 7; // 7 days
  const payload = `${familyId}.${expiry}`;
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [familyId, expiry, sig] = parts;
  const payload = `${familyId}.${expiry}`;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expiry)) return null;
  return familyId;
}
function getSessionFamilyId(req) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || req.query.token;
  return verifySession(token);
}

// --- Family admin endpoints ---
app.post("/family/create", (req, res) => {
  const { familyName, adminEmail, password } = req.body || {};
  if (!familyName || !adminEmail || !password) {
    return res.status(400).json({ error: "familyName, adminEmail, and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "password must be at least 6 characters" });
  }
  const families = loadFamilies();
  let familyId;
  do {
    familyId = generateFamilyCode();
  } while (families.some((f) => f.familyId === familyId));
  families.push({
    familyId,
    familyName,
    adminEmail,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  });
  saveFamilies(families);
  res.json({ familyId, familyName });
});

app.post("/family/login", (req, res) => {
  const { familyId, password } = req.body || {};
  if (!familyId || !password) {
    return res.status(400).json({ error: "familyId and password are required" });
  }
  const families = loadFamilies();
  const family = families.find((f) => f.familyId === familyId.toUpperCase());
  if (!family || !verifyPassword(password, family.passwordHash)) {
    return res.status(401).json({ error: "invalid family code or password" });
  }
  res.json({ token: signSession(family.familyId), familyId: family.familyId, familyName: family.familyName });
});

app.get("/api/family/summary", (req, res) => {
  const familyId = getSessionFamilyId(req);
  if (!familyId) return res.status(401).json({ error: "invalid or expired session" });
  const families = loadFamilies();
  const family = families.find((f) => f.familyId === familyId);
  if (!family) return res.status(404).json({ error: "family not found" });
  const alerts = loadAlerts().filter((a) => a.familyId === familyId);
  const deviceMap = new Map();
  alerts.forEach((a) => {
    const key = a.deviceOwnerLabel || "(unlabeled device)";
    if (!deviceMap.has(key)) deviceMap.set(key, { deviceOwnerLabel: key, alertCount: 0, lastSeen: a.timestamp });
    deviceMap.get(key).alertCount += 1;
  });
  res.json({
    familyName: family.familyName,
    familyId: family.familyId,
    devices: Array.from(deviceMap.values()),
    alerts,
  });
});

// --- Alerts ---
app.post("/alert", async (req, res) => {
  const { contactEmail, deviceOwnerLabel, timestamp, searchQuery, location, mapLink, severity, familyId } = req.body || {};
  if (!contactEmail) {
    return res.status(400).json({ error: "contactEmail is required" });
  }
  const now = Date.now();
  const last = lastSent.get(contactEmail);
  if (last && now - last < MIN_INTERVAL_MS) {
    return res.status(200).json({ ok: true, note: "throttled" });
  }
  lastSent.set(contactEmail, now);
  const deviceLine = deviceOwnerLabel ? ` on "${deviceOwnerLabel}"` : "";
  const queryLine = searchQuery ? `\nSearch: "${searchQuery}"\n` : "";
  const locationLine = mapLink ? `\nApproximate location: ${mapLink}\n` : "";
  const isCrisis = severity === "crisis";
  const subjectLine = isCrisis
    ? "Check-in: a concerning search was detected"
    : "Check-in: a search suggesting possible stress was detected";
  const urgencyLine = isCrisis
    ? "This search matched language associated with a possible safety risk. Please reach out soon.\n"
    : "This search matched language associated with stress, low mood, or anxiety. A gentle check-in may help.\n";
  try {
    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: contactEmail,
      subject: subjectLine,
      text:
        `A search suggesting possible distress was made${deviceLine} at ${timestamp}.\n` +
        queryLine +
        urgencyLine +
        locationLine +
        `\nThis is an automated check-in prompt, not a diagnosis. Consider reaching out ` +
        `directly and gently to check how they're doing.\n\n` +
        `Support resources: https://findahelpline.com`,
    });
    saveAlert({
      contactEmail,
      deviceOwnerLabel: deviceOwnerLabel || "",
      timestamp: timestamp || new Date().toISOString(),
      searchQuery: searchQuery || "",
      location: location || null,
      mapLink: mapLink || "",
      severity: severity || "unknown",
      familyId: familyId || null,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Email send failed:", err);
    res.status(500).json({ error: "failed to send alert" });
  }
});

app.get("/api/alerts", (req, res) => {
  const email = (req.query.email || "").toString().trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email query param is required" });
  const alerts = loadAlerts().filter((a) => (a.contactEmail || "").toLowerCase() === email);
  res.json({ alerts });
});

app.get("/uninstall-alert", async (req, res) => {
  const email = (req.query.email || "").toString().trim();
  const email2 = (req.query.email2 || "").toString().trim();
  const device = (req.query.device || "").toString().trim();
  const familyId = (req.query.familyId || "").toString().trim() || null;
  const recipients = [email, email2].filter(Boolean);

  for (const to of recipients) {
    try {
      await resend.emails.send({
        from: "onboarding@resend.dev",
        to,
        subject: "Safety extension was removed",
        text:
          `The Family Search Safety Alert extension was just removed${device ? ` from "${device}"` : ""}.\n\n` +
          `This device will no longer send check-in alerts. Consider reaching out to check in.`,
      });
      saveAlert({
        contactEmail: to,
        deviceOwnerLabel: device,
        timestamp: new Date().toISOString(),
        searchQuery: "(extension removed)",
        location: null,
        mapLink: "",
        severity: "uninstall",
        familyId,
      });
    } catch (err) {
      console.error("Uninstall alert email failed:", err);
    }
  }
  res.send("OK");
});

app.get("/health", (_req, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Safety alert backend listening on :${PORT}`));
