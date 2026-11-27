const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config();
// All days, duty times and "late" checks use the company's time zone, whatever time zone the server itself is in.
process.env.TZ = process.env.TIMEZONE || 'Asia/Dubai';
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:4200' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/leaves', require('./routes/leaves'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/adjustments', require('./routes/adjustments'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/shifts', require('./routes/shifts'));

app.use((req, res) => res.status(404).json({ message: 'Not found' }));

const PORT = process.env.PORT || 3000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('MongoDB connected');
    // the admin may have chosen a different company time zone on the Settings page
    try {
      const { getSettings, applyTimezone } = require('./utils/settings');
      applyTimezone((await getSettings()).timezone);
    } catch (e) { console.error('Could not load the saved time zone:', e.message); }
    console.log('Company time zone:', process.env.TZ);

    // forgotten check-outs are closed automatically (Settings -> Forgotten check-outs); checked every 10 minutes
    const { sweep } = require('./utils/autoCheckout');
    const runSweep = () => sweep().then((n) => { if (n) console.log(`Auto check-out: closed ${n} forgotten check-in(s)`); }).catch((e) => console.error('Auto check-out failed:', e.message));
    runSweep();
    setInterval(runSweep, 10 * 60 * 1000);

    // people marked "Auto attendance" (no smartphone) are recorded present for their shift; checked every 10 minutes
    const autoAtt = require('./utils/autoAttendance');
    const runAuto = () => autoAtt.sweep().then((n) => { if (n) console.log(`Auto attendance: updated ${n} record(s)`); }).catch((e) => console.error('Auto attendance failed:', e.message));
    runAuto();
    setInterval(runAuto, 10 * 60 * 1000);
    app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });
