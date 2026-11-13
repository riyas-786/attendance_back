const User = require('../models/User');

// Each staff account is tied to ONE phone/browser. The frontend sends a random id (X-Device-Id)
// that it creates once and keeps. The first device that signs in is registered; after that:
//  - the same account on a different device is refused,
//  - a device that is registered to someone else cannot be used by another account.
// Admins are exempt, and the lock can be switched off per person (e.g. a shared tablet).

const ID_RE = /^[A-Za-z0-9-]{16,64}$/;

// Returns { ok: true } or { ok: false, status, message }. `user` must be a full User document.
async function checkDevice(user, rawId) {
  if (user.role !== 'staff' || user.deviceLock === false) return { ok: true };

  const id = String(rawId || '');
  if (!ID_RE.test(id)) {
    return { ok: false, status: 400, message: 'This phone or browser could not be identified. Reload the page and try again.' };
  }
  if (user.deviceId === id) return { ok: true };
  if (user.deviceId) {
    return {
      ok: false, status: 403,
      message: 'This account is registered to a different phone or browser. Use your own phone, or ask your admin to reset your device.',
    };
  }

  // Not registered yet: it must not already belong to another person
  const other = await User.findOne({ deviceId: id, _id: { $ne: user._id } });
  if (other) {
    return {
      ok: false, status: 403,
      message: 'This phone or browser is registered to another staff member. Please use your own phone.',
    };
  }
  try {
    await User.updateOne({ _id: user._id }, { $set: { deviceId: id } });
    user.deviceId = id;
  } catch (err) {
    // unique index: someone registered this device a moment ago
    return { ok: false, status: 403, message: 'This phone or browser is registered to another staff member. Please use your own phone.' };
  }
  return { ok: true };
}

module.exports = { checkDevice, DEVICE_ID_RE: ID_RE };
