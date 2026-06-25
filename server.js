const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const repRoutes = require('./routes/rep');
const stripeWebhookRoutes = require('./routes/webhook');

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure local uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Enable CORS for frontend integration
app.use(cors({
  origin: '*', // For development, allow any origin. In production, lock this down.
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Serve static uploads
app.use('/uploads', express.static(uploadsDir));

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rep', repRoutes);
app.use('/api/stripe', stripeWebhookRoutes);

// Database auto-migration helper
const pool = require('./config/db');
(async () => {
  try {
    const [columns] = await pool.query("SHOW COLUMNS FROM products LIKE 'images'");
    if (columns.length === 0) {
      await pool.query("ALTER TABLE products ADD COLUMN images TEXT DEFAULT NULL");
      console.log("✔ Added 'images' column to products table.");
    }
  } catch (err) {
    console.error("Warning: DB migration failed:", err.message);
  }
})();

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// Root path handler
app.get('/', (req, res) => {
  res.send('Welcome to Lipistry Wholesale ERP API Server');
});

// Start listening
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
