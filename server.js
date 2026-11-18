require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { RouterOSAPI } = require("routeros-client");

const app = express();
app.use(cors());
app.use(express.json());

// In-memory store for active orders (swap for PostgreSQL/MySQL when scaling)
const orders = new Map();

// Switch between sandbox and live Safaricom Daraja URLs automatically
const DARAJA_BASE_URL =
  process.env.DARAJA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

// Helper: Normalize Kenyan phone numbers to 2547XXXXXXXX or 2541XXXXXXXX
function formatPhone(phone) {
  let clean = String(phone).replace(/\D/g, "");
  if (clean.startsWith("0")) clean = "254" + clean.slice(1);
  if (clean.startsWith("+")) clean = clean.slice(1);
  return clean;
}

// Helper: Get Safaricom Daraja OAuth Token
async function getDarajaToken() {
  const auth = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString("base64");

  const res = await axios.get(
    `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

// Health check route (useful for Render uptime checks)
app.get("/", (req, res) => {
  res.send("Galaxy Cyber WiFi Billing API is running.");
});

// 1. Trigger M-Pesa STK Push
app.post("/api/stkpush", async (req, res) => {
  try {
    const { phone, amount, duration, devices, mac, ip } = req.body;
    const formattedPhone = formatPhone(phone);
    const deviceCount = Number(devices) === 2 ? 2 : 1;

    if (!formattedPhone || !amount || !duration) {
      return res.status(400).json({ error: "Missing phone, amount, or duration." });
    }

    const token = await getDarajaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const password = Buffer.from(
      `${process.env.DARAJA_SHORTCODE}${process.env.DARAJA_PASSKEY}${timestamp}`
    ).toString("base64");

    const stkRes = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: process.env.DARAJA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: Number(amount),
        PartyA: formattedPhone,
        PartyB: process.env.DARAJA_SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: `${process.env.PUBLIC_URL}/api/mpesa/callback`,
        AccountReference: "GalaxyCyberWiFi",
        TransactionDesc: `WiFi ${duration} (${deviceCount} Dev)`
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const checkoutRequestId = stkRes.data.CheckoutRequestID;

    orders.set(checkoutRequestId, {
      status: "PENDING",
      phone: formattedPhone,
      mac: mac || "",
      ip: ip || "",
      duration,
      devices: deviceCount,
      amount: Number(amount),
      createdAt: Date.now()
    });

    res.json({ checkoutRequestId });
  } catch (err) {
    console.error("STK Push Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to initiate M-Pesa STK Push" });
  }
});

// 2. M-Pesa Webhook Callback -> Create MikroTik User with Auto-Disconnect Timer
app.post("/api/mpesa/callback", async (req, res) => {
  const callback = req.body?.Body?.stkCallback;
  if (!callback) return res.sendStatus(400);

  const checkoutRequestId = callback.CheckoutRequestID;
  const order = orders.get(checkoutRequestId);

  // Acknowledge Safaricom immediately if order isn't in memory
  if (!order) {
    return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  // ResultCode 0 means payment succeeded
  if (callback.ResultCode === 0) {
    // 1-Device plans use cleaned MAC address; 2-Device plans get a 6-digit shared PIN
    const cleanMac = order.mac ? order.mac.replace(/:/g, "") : `USER${Date.now().toString().slice(-6)}`;
    const accessCode =
      order.devices === 2
        ? String(Math.floor(100000 + Math.random() * 900000))
        : cleanMac;

    const profileName = order.devices === 2 ? "galaxy-2-devices" : "default";

    const api = new RouterOSAPI({
      host: process.env.MIKROTIK_HOST,
      user: process.env.MIKROTIK_USER,
      password: process.env.MIKROTIK_PASS,
      port: Number(process.env.MIKROTIK_PORT) || 8728
    });

    try {
      await api.connect();

      // Ensure the "galaxy-2-devices" profile exists with shared-users=2
      if (order.devices === 2) {
        const profiles = await api
          .menu("/ip/hotspot/user/profile")
          .where("name", "galaxy-2-devices")
          .get();

        if (profiles.length === 0) {
          await api.menu("/ip/hotspot/user/profile").add({
            name: "galaxy-2-devices",
            "shared-users": "2"
          });
        }
      }

      // Remove any old/expired user with the same username before creating a fresh session
      const existingUsers = await api
        .menu("/ip/hotspot/user")
        .where("name", accessCode)
        .get();

      for (const u of existingUsers) {
        await api.menu("/ip/hotspot/user").remove(u[".id"]);
      }

      // Build Hotspot user payload with limit-uptime for automatic disconnection
      const userPayload = {
        name: accessCode,
        password: accessCode,
        profile: profileName,
        "limit-uptime": order.duration,
        comment: `Galaxy Cyber | ${order.devices} Dev | Ksh ${order.amount} | ${order.phone}`
      };

      // Lock to MAC address only when 1 Device is selected
      if (order.devices === 1 && order.mac && !order.mac.startsWith("$(")) {
        userPayload["mac-address"] = order.mac;
      }

      await api.menu("/ip/hotspot/user").add(userPayload);
      await api.close();

      order.status = "PAID";
      order.username = accessCode;
      order.password = accessCode;
      console.log(`Activated ${order.devices}-device user: ${accessCode} for ${order.duration}`);
    } catch (mkErr) {
      console.error("MikroTik API Error:", mkErr.message);
      order.status = "MIKROTIK_ERROR";
    }
  } else {
    order.status = "FAILED";
    console.log(`Payment failed/cancelled for ${checkoutRequestId}: ${callback.ResultDesc}`);
  }

  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// 3. Frontend Polling Endpoint
app.get("/api/status/:checkoutRequestId", (req, res) => {
  const order = orders.get(req.params.checkoutRequestId);
  if (!order) return res.status(404).json({ status: "NOT_FOUND" });

  res.json({
    status: order.status,
    devices: order.devices,
    username: order.username || null,
    password: order.password || null
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Galaxy Cyber WiFi Billing Server running on port ${PORT}`);
});
