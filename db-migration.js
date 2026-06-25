const pool = require('./config/db');

async function addColumnIfNotExists(tableName, columnName, columnDef) {
  const [cols] = await pool.query(`SHOW COLUMNS FROM ${tableName} LIKE ?`, [columnName]);
  if (cols.length === 0) {
    console.log(`  Adding ${columnName} to ${tableName}...`);
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
    console.log(`  ✓ ${columnName} added.`);
  } else {
    console.log(`  ✓ ${columnName} already exists.`);
  }
}

async function migrate() {
  console.log('\n🚀 Starting Lipistry DB Migration...\n');
  try {
    // ── PRODUCTS TABLE ─────────────────────────────────────────────
    console.log('[ Products Table ]');
    await addColumnIfNotExists('products', 'stock_cases', 'INT NOT NULL DEFAULT 0');

    // Initialize stock for existing zero-stock products
    const [updated] = await pool.query('UPDATE products SET stock_cases = 100 WHERE stock_cases = 0');
    console.log(`  ✓ Initialized stock for ${updated.affectedRows} products.`);

    // ── INVENTORY TRANSACTIONS TABLE ──────────────────────────────
    console.log('\n[ Inventory Transactions Table ]');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id VARCHAR(255) NOT NULL,
        quantity_change INT NOT NULL,
        transaction_type VARCHAR(50) NOT NULL,
        reference_id VARCHAR(255) NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✓ inventory_transactions table ready.');

    // ── ORDERS TABLE ──────────────────────────────────────────────
    console.log('\n[ Orders Table ]');

    // Convert ENUM status to VARCHAR if needed
    const [statusCol] = await pool.query('SHOW COLUMNS FROM orders LIKE "status"');
    if (statusCol.length > 0 && statusCol[0].Type.includes('enum')) {
      console.log('  Converting status ENUM to VARCHAR...');
      await pool.query("ALTER TABLE orders MODIFY COLUMN status VARCHAR(50) NOT NULL DEFAULT 'submitted_warehouse'");
      console.log('  ✓ Status column converted to VARCHAR.');
    } else {
      console.log('  ✓ Status column is already VARCHAR-compatible.');
    }

    await addColumnIfNotExists('orders', 'shipped_at',           'TIMESTAMP NULL');
    await addColumnIfNotExists('orders', 'delivered_at',         'TIMESTAMP NULL');
    await addColumnIfNotExists('orders', 'tracking_number',      'VARCHAR(255) NULL');
    await addColumnIfNotExists('orders', 'shipping_carrier',     'VARCHAR(255) NULL');
    await addColumnIfNotExists('orders', 'tracking_notes',       'TEXT NULL');
    await addColumnIfNotExists('orders', 'return_reason',        'VARCHAR(255) NULL');
    await addColumnIfNotExists('orders', 'return_description',   'TEXT NULL');
    await addColumnIfNotExists('orders', 'return_proof_image',   'TEXT NULL');
    await addColumnIfNotExists('orders', 'return_requested_at',  'TIMESTAMP NULL');
    await addColumnIfNotExists('orders', 'return_processed_at',  'TIMESTAMP NULL');

    // ── PAYMENTS TABLE ─────────────────────────────────────────────
    console.log('\n[ Payments Table ]');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id CHAR(36) NOT NULL,
        order_id CHAR(36) NOT NULL,
        stripe_payment_intent_id VARCHAR(255) DEFAULT NULL,
        stripe_charge_id VARCHAR(255) DEFAULT NULL,
        amount_cents INT NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'usd',
        status VARCHAR(50) NOT NULL,
        brand VARCHAR(50) DEFAULT NULL,
        last4 VARCHAR(4) DEFAULT NULL,
        error_message TEXT DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  ✓ payments table ready.');

    console.log('\n✅ Database migration completed successfully!');
  } catch (err) {
    console.error('\n❌ Migration failed:', err);
  } finally {
    process.exit(0);
  }
}

migrate();
