const express = require('express');
const QRCode = require('qrcode');
const { protect, adminOnly } = require('../middleware/auth');
const { currentQrToken } = require('../utils/presence');
const { getSettings } = require('../utils/settings');

const router = express.Router();
router.use(protect, adminOnly);

// Current office QR code (admin shows this on a screen at the entrance)
router.get('/current', async (req, res) => {
  try {
    const cfg = await getSettings();
    const token = currentQrToken(cfg);
    const url = `${cfg.frontendUrl}/scan?t=${token}`;
    const image = await QRCode.toDataURL(url, { width: 360, margin: 2 });
    const windowSec = Math.max(Number(cfg.qrWindowMinutes) || 5, 1) * 60;
    const secondsLeft = windowSec - (Math.floor(Date.now() / 1000) % windowSec);
    res.json({ image, url, secondsLeft });
  } catch (err) {
    res.status(500).json({ message: 'Could not generate QR code' });
  }
});

module.exports = router;
