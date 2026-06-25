const mysql = require("mysql2");
require('dotenv').config();

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lipistry_db',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true, // ✅ FIX: DATE/DATETIME columns string tarike aave, JS Date object nahi (timezone shift band)
});

// Test connection
db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Database connection failed:", err);
  } else {
    console.log("✅ Connected to MySQL database");
    connection.release();
  }
});

// Keep database alive every 5 minutes
setInterval(() => {
  db.query("SELECT 1", (err) => {
    if (err) {
      console.error("Keep alive query failed:", err);
    } else {
      console.log("⏱️ Database keep-alive ping sent");
    }
  });
}, 5 * 60 * 1000);

const pool = db.promise();
module.exports = pool;
