import express from "express";
import cors from "cors";
import { Resend } from "resend";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json());
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));
const resend = new Resend(process.env.RESEND_API_KEY);
const lastSent = new Map();
const MIN_INTERVAL_MS = 2 * 60 * 1000;
// --- Simple JSON-file alert history store ---
// Demo-grade persistence (a real product would use a proper database).
const STORE_PATH = path.join(__dirname, "alerts.json");
function loadAlerts() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
function saveAlert(record) {
  const alerts = loadAlerts();
  alerts.unshift(record); // newest first
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(alerts, null, 2));
  } catch (err) {
    console.error("Failed to persist alert history:", err);
  }
}
app.post("/alert", async (req, res) => {
  const { contactEmail, deviceOwnerLabel, timestamp, searchQuery, location, mapLink, severity } = req.body || {};
  console.log("Received location:", location, "mapLink:", mapLink, "severity:", severity);
  if (!contactEmail) {
    return res.status(400).json({ error: "contactEmail is required" });
  }
  const now = Date.now();
  const last = lastSent.get(contactEmail);
  if (last && now - last < MIN_INTERVAL_MS) {
    console.log(`Throttled alert for ${contactEmail} (too soon after last one)`);
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