require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// CORS_ORIGIN can hold several web addresses separated by commas, e.g. https://my-app.vercel.app,http://localhost:4200
const origins = (process.env.CORS_ORIGIN || 'http://localhost:4200').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
app.use(cors({ origin: origins.length === 1 ? origins[0] : origins }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Connect to MongoDB once and reuse the connection. This also works on serverless hosts (Vercel),
// where the server starts fresh for many requests instead of running all the time.
let connecting = null;
function connectDb() {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!process.env.MONGO_URI) return Promise.reject(new Error('MONGO_URI is not set'));
  if (!connecting) {
    connecting = mongoose
      .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
      .catch((err) => { connecting = null; throw err; });
  }
  return connecting;
}
app.use('/api', async (req, res, next) => {
  try {
    await connectDb();
    next();
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    res.status(503).json({ message: 'Cannot reach the database. Check MONGO_URI and the database network access settings.' });
  }
});
app.use('/api/auth', require('./routes/auth'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/leaves', require('./routes/leaves'));
app.use('/api/qr', require('./routes/qr'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/adjustments', require('./routes/adjustments'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/locations', require('./routes/locations'));
app.use('/api/shifts', require('./routes/shifts'));

app.use((req, res) => res.status(404).json({ message: 'Not found' }));

module.exports = app;

// Running with `npm start` / `node server.js`: start listening. On Vercel the app is exported (see api/index.js).
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  connectDb()
    .then(() => {
      console.log('MongoDB connected');
      app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error('MongoDB connection failed:', err.message);
      process.exit(1);
    });
}
