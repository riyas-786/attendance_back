const express = require('express');
const { protect, adminOnly } = require('../middleware/auth');
const { getSettings, saveSettings } = require('../utils/settings');

const router = express.Router();
router.use(protect, adminOnly);

router.get('/', async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    res.status(500).json({ message: 'Could not load settings' });
  }
});

router.put('/', async (req, res) => {
  try {
    const { values, error } = await saveSettings(req.body);
    if (error) return res.status(400).json({ message: error });
    res.json(values);
  } catch (err) {
    res.status(500).json({ message: 'Could not save settings' });
  }
});

module.exports = router;
