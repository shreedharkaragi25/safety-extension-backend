import express from "express";
import cors from "cors";
import { Resend } from "resend";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import Razorpay from "razorpay";
import twilio from "twilio";
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
const BASE_URL = "https://safety-extension-backend.onrender.com";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

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

// --- Wallet store (per family) ---
const WALLETS_PATH = path.join(__dirname, "wallets.json");
const CALL_COST_PAISE = 500; // ₹5 per wellbeing/escalation call, adjust as needed

function loadWallets() {
  try {
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf-8"));
  } catch {
    return {};
  }
}
function saveWallets(wallets) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(wallets, null, 2));
}
function getBalance(familyId) {
  const wallets = loadWallets();
  return wallets[familyId]?.balancePaise || 0;
}
function creditWallet(familyId, amountPaise) {
  const wallets = loadWallets();
  if (!wallets[familyId]) wallets[familyId] = { balancePaise: 0 };
  wallets[familyId].balancePaise += amountPaise;
  saveWallets(wallets);
  return wallets[familyId].balancePaise;
}
function debitWallet(familyId, amountPaise) {
  const wallets = loadWallets();
  const current = wallets[familyId]?.balancePaise || 0;
  if (current < amountPaise) return { ok: false, balancePaise: current };
  wallets[familyId].balancePaise = current - amountPaise;
  saveWallets(wallets);
  return { ok: true, balancePaise: wallets[familyId].balancePaise };
}

// --- Pending top-ups (maps a Razorpay Payment Link ID to the family/amount it's for) ---
const PENDING_TOPUPS_PATH = path.join(__dirname, "pending-topups.json");
function loadPendingTopups() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_TOPUPS_PATH, "utf-8"));
  } catch {
    return {};
  }
}
function savePendingTopups(pending) {
  fs.writeFileSync(PENDING_TOPUPS_PATH, JSON.stringify(pending, null, 2));
}

// --- Groq-based risk classification (confirms/refines the on-device regex match) ---
async function classifyRisk(searchQuery) {
  if (!searchQuery) return { confirmedSeverity: "unknown", reason: "no query provided" };
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        messages: [
          {
            role: "system",
            content:
              "You classify search queries for a family safety app. Given a search query, respond with ONLY a JSON object like " +
              '{"severity": "none|low|moderate|crisis", "reason": "short explanation"}. ' +
              "Classify 'crisis' only for genuine, specific expressions of suicidal intent or self-harm intent. " +
              "Classify as 'low' or 'none' for research, news, school projects, song lyrics, or unrelated context that merely contains a matched phrase. " +
              "Classify 'moderate' for expressions of distress, sadness, or anxiety without explicit self-harm intent.",
          },
          { role: "user", content: `Search query: "${searchQuery}"` },
        ],
        temperature: 0,
        max_tokens: 150,
      }),
    });

    if (!response.ok) {
      console.error("Groq API error:", response.status, await response.text());
      return { confirmedSeverity: "unknown", reason: "classification failed" };
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(raw);
    return {
      confirmedSeverity: parsed.severity || "unknown",
      reason: parsed.reason || "",
    };
  } catch (err) {
    console.error("classifyRisk failed:", err);
    return { confirmedSeverity: "unknown", reason: "classification error" };
  }
}

// --- Twilio WhatsApp alert (sandbox — trusted contact must have sent the join code) ---
async function sendWhatsAppAlert(trustedContactPhone, deviceOwnerLabel, searchQuery, mapLink, isCrisis) {
  if (!twilioClient) {
    console.log("Twilio not configured (missing TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN), skipping WhatsApp alert.");
    return { skipped: true, reason: "twilio not configured" };
  }
  if (!trustedContactPhone) {
    console.log("No trustedContactPhone provided, skipping WhatsApp alert.");
    return { skipped: true, reason: "no trusted contact phone number" };
  }
  if (!process.env.TWILIO_WHATSAPP_NUMBER) {
    console.log("TWILIO_WHATSAPP_NUMBER not set, skipping WhatsApp alert.");
    return { skipped: true, reason: "no sandbox number configured" };
  }

  const deviceLine = deviceOwnerLabel ? ` on "${deviceOwnerLabel}"` : "";
  const urgencyLine = isCrisis
    ? "This matched language associated with a possible safety risk. Please reach out soon."
    : "This matched language associated with stress or low mood. A gentle check-in may help.";
  const queryLine = searchQuery ? `\nSearch: "${searchQuery}"` : "";
  const locationLine = mapLink ? `\nLocation: ${mapLink}` : "";

  const body =
    `⚠️ Clot check-in alert\n\n` +
    `A concerning search was made${deviceLine}.` +
    queryLine +
    locationLine +
    `\n\n${urgencyLine}\n\n` +
    `This is automated, not a diagnosis. Support: https://findahelpline.com`;

  const toNumber = trustedContactPhone.startsWith("whatsapp:")
    ? trustedContactPhone
    : `whatsapp:${trustedContactPhone}`;

  try {
    const message = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: toNumber,
      body,
    });
    console.log("WhatsApp alert sent:", message.sid);
    return { skipped: false, sid: message.sid };
  } catch (err) {
    console.error("sendWhatsAppAlert failed:", err.message);
    return { skipped: false, error: err.message };
  }
}

// --- Vapi: trusted-contact language -> assistant ID map ---
// One assistant per language, all using Vapi's built-in "Primary language" voice
// setting (same Elliot voice, different language) rather than a separate voice provider.
const TRUSTED_CONTACT_ASSISTANT_MAP = {
  en: "5c364c07-d35f-484c-b9f2-a948912bdea6",
  hi: "dd0b7a79-834e-425e-b6dc-1db21e7aa8d3",
  kn: "7ad544e8-89d8-4c29-a5d2-dc3856457b01",
  ta: "eb728c91-ee8f-484c-b6dc-1db21e7aa8d3",
  te: "84374d81-0394-41b5-9495-50504cf3ac3e",
};

// --- Vapi call trigger: device user's own wellbeing check-in + counselor handoff ---
// (only fires on confirmed crisis-level risk AND sufficient wallet balance)
async function triggerWellbeingCall(devicePhoneNumber, counselorPhone, trustedContactName, familyId) {
  if (!devicePhoneNumber) {
    console.log("No devicePhoneNumber provided, skipping Vapi wellbeing call trigger.");
    return { skipped: true, reason: "no device phone number" };
  }

  if (familyId) {
    const debit = debitWallet(familyId, CALL_COST_PAISE);
    if (!debit.ok) {
      console.log(`Insufficient wallet balance for family ${familyId}, skipping wellbeing call. Balance: ${debit.balancePaise} paise`);
      return { skipped: true, reason: "insufficient wallet balance", balancePaise: debit.balancePaise };
    }
  }

  try {
    const response = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.VAPI_API_KEY}`,
      },
      body: JSON.stringify({
        assistantId: process.env.VAPI_ASSISTANT_ID,
        customer: {
          number: devicePhoneNumber,
        },
        assistantOverrides: {
          variableValues: {
            counselorName: counselorPhone ? "your counselor" : "",
            counselorPhone: counselorPhone || "",
            trustedContactName: trustedContactName || "your trusted contact",
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Vapi wellbeing call trigger failed:", response.status, errText);
      if (familyId) creditWallet(familyId, CALL_COST_PAISE);
      return { skipped: false, error: errText };
    }

    const data = await response.json();
    console.log("Vapi wellbeing call triggered successfully:", data.id || data);
    return { skipped: false, callId: data.id };
  } catch (err) {
    console.error("triggerWellbeingCall failed:", err);
    if (familyId) creditWallet(familyId, CALL_COST_PAISE);
    return { skipped: false, error: err.message };
  }
}

// --- Vapi call trigger: trusted contact escalation call, in their preferred language ---
// (separate wallet debit from the device wellbeing call — each call the family pays for
// is charged independently, so one call succeeding/failing doesn't affect the other)
async function triggerTrustedContactCall(trustedContactPhone, preferredLanguage, deviceOwnerLabel, searchQuery, riskLevel, familyId) {
  if (!trustedContactPhone) {
    console.log("No trustedContactPhone provided, skipping Vapi trusted-contact call trigger.");
    return { skipped: true, reason: "no trusted contact phone number" };
  }

  const lang = (preferredLanguage || "en").toLowerCase();
  const assistantId = TRUSTED_CONTACT_ASSISTANT_MAP[lang] || TRUSTED_CONTACT_ASSISTANT_MAP.en;

  if (familyId) {
    const debit = debitWallet(familyId, CALL_COST_PAISE);
    if (!debit.ok) {
      console.log(`Insufficient wallet balance for family ${familyId}, skipping trusted-contact call. Balance: ${debit.balancePaise} paise`);
      return { skipped: true, reason: "insufficient wallet balance", balancePaise: debit.balancePaise };
    }
  }

  try {
    const response = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.VAPI_API_KEY}`,
      },
      body: JSON.stringify({
        assistantId,
        customer: {
          number: trustedContactPhone,
        },
        assistantOverrides: {
          variableValues: {
            deviceOwnerLabel: deviceOwnerLabel || "a family device",
            searchQuery: searchQuery || "",
            riskLevel: riskLevel || "crisis",
          },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Vapi trusted-contact call trigger failed:", response.status, errText);
      if (familyId) creditWallet(familyId, CALL_COST_PAISE);
      return { skipped: false, error: errText };
    }

    const data = await response.json();
    console.log(`Vapi trusted-contact call triggered successfully (lang=${lang}):`, data.id || data);
    return { skipped: false, callId: data.id, language: lang };
  } catch (err) {
    console.error("triggerTrustedContactCall failed:", err);
    if (familyId) creditWallet(familyId, CALL_COST_PAISE);
    return { skipped: false, error: err.message };
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
  const expiry = Date.now() + 1000 * 60 * 60 * 24 * 7;
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
    walletBalancePaise: getBalance(familyId),
    alerts,
  });
});

// --- Wallet: Payment Link based top-up (no webhook needed) ---
app.post("/api/wallet/create-payment-link", async (req, res) => {
  const { familyId, amountRupees } = req.body || {};
  if (!familyId || !amountRupees || amountRupees <= 0) {
    return res.status(400).json({ error: "familyId and a positive amountRupees are required" });
  }
  try {
    const paymentLink = await razorpay.paymentLink.create({
      amount: Math.round(amountRupees * 100),
      currency: "INR",
      accept_partial: false,
      description: "Clot wallet top-up",
      notify: { sms: false, email: false },
      reminder_enable: false,
      callback_url: `${BASE_URL}/api/wallet/payment-callback`,
      callback_method: "get",
    });

    const pending = loadPendingTopups();
    pending[paymentLink.id] = { familyId, amountRupees, createdAt: new Date().toISOString() };
    savePendingTopups(pending);

    res.json({ shortUrl: paymentLink.short_url, paymentLinkId: paymentLink.id });
  } catch (err) {
    console.error("Payment link creation failed:", err);
    res.status(500).json({ error: "failed to create payment link" });
  }
});

app.get("/api/wallet/payment-callback", (req, res) => {
  const {
    razorpay_payment_id,
    razorpay_payment_link_id,
    razorpay_payment_link_reference_id,
    razorpay_payment_link_status,
    razorpay_signature,
  } = req.query;

  const sendPage = (message, ok) => {
    res.set("Content-Type", "text/html");
    res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:sans-serif;background:#1A1F33;color:white;text-align:center;padding-top:80px;">
<h2>${ok ? "✅ Payment received" : "⚠️ Something went wrong"}</h2>
<p>${message}</p>
<p style="opacity:0.7;">You can close this tab and return to the app.</p>
</body></html>`);
  };

  if (!razorpay_payment_id || !razorpay_payment_link_id || !razorpay_signature) {
    return sendPage("Missing payment details.", false);
  }

  const referenceId = razorpay_payment_link_reference_id || "";
  const payload = `${razorpay_payment_link_id}|${referenceId}|${razorpay_payment_link_status}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(payload)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return sendPage("Payment verification failed.", false);
  }

  if (razorpay_payment_link_status !== "paid") {
    return sendPage("Payment was not completed.", false);
  }

  const pending = loadPendingTopups();
  const entry = pending[razorpay_payment_link_id];

  if (!entry) {
    return sendPage("Your wallet has already been updated.", true);
  }

  creditWallet(entry.familyId, Math.round(entry.amountRupees * 100));
  delete pending[razorpay_payment_link_id];
  savePendingTopups(pending);

  sendPage(`₹${entry.amountRupees} added to your wallet.`, true);
});

app.get("/api/wallet/balance", (req, res) => {
  const familyId = (req.query.familyId || "").toString().trim().toUpperCase();
  if (!familyId) return res.status(400).json({ error: "familyId query param is required" });
  res.json({ familyId, balancePaise: getBalance(familyId), callCostPaise: CALL_COST_PAISE });
});

// --- Alerts ---
app.post("/alert", async (req, res) => {
  const {
    contactEmail,
    deviceOwnerLabel,
    timestamp,
    searchQuery,
    location,
    mapLink,
    severity,
    familyId,
    devicePhoneNumber,
    counselorPhone,
    trustedContactPhone,
    preferredLanguage,
  } = req.body || {};
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
  const classification = await classifyRisk(searchQuery);
  console.log(`Groq classification for "${searchQuery}": ${classification.confirmedSeverity} (${classification.reason})`);

  const isCrisis = classification.confirmedSeverity === "crisis";

  if (isCrisis) {
    triggerWellbeingCall(devicePhoneNumber, counselorPhone, "your trusted contact", familyId)
      .then((result) => console.log("Wellbeing call trigger result:", result))
      .catch((err) => console.error("Wellbeing call trigger threw:", err));

    triggerTrustedContactCall(trustedContactPhone, preferredLanguage, deviceOwnerLabel, searchQuery, classification.confirmedSeverity, familyId)
      .then((result) => console.log("Trusted-contact call trigger result:", result))
      .catch((err) => console.error("Trusted-contact call trigger threw:", err));
  }

  sendWhatsAppAlert(trustedContactPhone, deviceOwnerLabel, searchQuery, mapLink, isCrisis)
    .then((result) => console.log("WhatsApp alert result:", result))
    .catch((err) => console.error("WhatsApp alert threw:", err));

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
      confirmedSeverity: classification.confirmedSeverity,
      confirmationReason: classification.reason,
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

// --- Concern phrase patterns (remotely updatable) ---
const PATTERNS_PATH = path.join(__dirname, "patterns.json");
const DEFAULT_PATTERNS = [
  { phrase: "suicide", severity: "crisis", lang: "en" },
  { phrase: "kill myself", severity: "crisis", lang: "en" },
  { phrase: "end my life", severity: "crisis", lang: "en" },
  { phrase: "want to die", severity: "crisis", lang: "en" },
  { phrase: "painless way to die", severity: "crisis", lang: "en" },
  { phrase: "how to die", severity: "crisis", lang: "en" },
  { phrase: "self harm", severity: "crisis", lang: "en" },
  { phrase: "no reason to live", severity: "crisis", lang: "en" },
  { phrase: "better off dead", severity: "crisis", lang: "en" },
  { phrase: "wish i was dead", severity: "crisis", lang: "en" },
  { phrase: "i have depression", severity: "moderate", lang: "en" },
  { phrase: "feeling depressed", severity: "moderate", lang: "en" },
  { phrase: "nothing matters anymore", severity: "moderate", lang: "en" },
  { phrase: "hopeless", severity: "moderate", lang: "en" },
  { phrase: "panic attack", severity: "moderate", lang: "en" },
  { phrase: "आत्महत्या", severity: "crisis", lang: "hi" },
  { phrase: "खुदकुशी", severity: "crisis", lang: "hi" },
  { phrase: "मरना चाहता हूं", severity: "crisis", lang: "hi" },
  { phrase: "aatmahatya", severity: "crisis", lang: "hi-en" },
  { phrase: "marna chahta hoon", severity: "crisis", lang: "hi-en" },
  { phrase: "bahut udaas", severity: "moderate", lang: "hi-en" },
  { phrase: "ಆತ್ಮಹತ್ಯೆ", severity: "crisis", lang: "kn" },
  { phrase: "aatmahatye", severity: "crisis", lang: "kn-en" },
  { phrase: "தற்கொலை", severity: "crisis", lang: "ta" },
  { phrase: "tharkolai", severity: "crisis", lang: "ta-en" }
];
function loadPatterns() {
  try {
    return JSON.parse(fs.readFileSync(PATTERNS_PATH, "utf-8"));
  } catch {
    fs.writeFileSync(PATTERNS_PATH, JSON.stringify(DEFAULT_PATTERNS, null, 2));
    return DEFAULT_PATTERNS;
  }
}

app.get("/api/patterns", (_req, res) => {
  res.json({ patterns: loadPatterns(), updatedAt: new Date().toISOString() });
});

app.post("/api/patterns", (req, res) => {
  const { phrase, severity, lang } = req.body || {};
  if (!phrase || typeof phrase !== "string" || !phrase.trim()) {
    return res.status(400).json({ error: "phrase is required" });
  }
  const validSeverities = ["crisis", "moderate"];
  const finalSeverity = validSeverities.includes(severity) ? severity : "moderate";
  const patterns = loadPatterns();
  patterns.push({
    phrase: phrase.trim(),
    severity: finalSeverity,
    lang: lang || "en",
  });
  fs.writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2));
  res.json({ ok: true, patterns });
});

// --- Family devices ---
app.get("/api/devices", (req, res) => {
  const familyId = (req.query.familyId || "").toString().trim().toUpperCase();
  if (!familyId) return res.status(400).json({ error: "familyId query param is required" });
  const alerts = loadAlerts().filter((a) => (a.familyId || "").toUpperCase() === familyId);
  const deviceMap = new Map();
  alerts.forEach((a) => {
    const key = a.deviceOwnerLabel || "(unlabeled device)";
    if (!deviceMap.has(key)) deviceMap.set(key, { deviceOwnerLabel: key, alertCount: 0, lastSeen: a.timestamp });
    const entry = deviceMap.get(key);
    entry.alertCount += 1;
    if (a.timestamp > entry.lastSeen) entry.lastSeen = a.timestamp;
  });
  res.json({ familyId, devices: Array.from(deviceMap.values()) });
});

app.get("/health", (_req, res) => res.json({ ok: true }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Safety alert backend listening on :${PORT}`));