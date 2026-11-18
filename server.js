// 1-device plans use clean MAC; 2-device plans get a 6-digit code both devices can use
const accessCode =
  order.devices === 2
    ? String(Math.floor(100000 + Math.random() * 900000))
    : order.mac.replace(/:/g, "");

const profileName = order.devices === 2 ? "galaxy-2-devices" : "default";

await api.connect();

// Ensure "galaxy-2-devices" profile exists with shared-users=2
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

// Remove old user entry if renewing
const existing = await api.menu("/ip/hotspot/user").where("name", accessCode).get();
for (const u of existing) {
  await api.menu("/ip/hotspot/user").remove(u[".id"]);
}

// Create user with limit-uptime -> MikroTik disconnects BOTH devices automatically when time expires
const userPayload = {
  name: accessCode,
  password: accessCode,
  profile: profileName,
  "limit-uptime": order.duration,
  comment: `Galaxy Cyber - ${order.devices} Device(s) - Ksh ${order.amount}`
};

// Lock to MAC only for 1-device plans
if (order.devices === 1 && order.mac) {
  userPayload["mac-address"] = order.mac;
}

await api.menu("/ip/hotspot/user").add(userPayload);
await api.close();

order.status = "PAID";
order.username = accessCode;
order.password = accessCode;
