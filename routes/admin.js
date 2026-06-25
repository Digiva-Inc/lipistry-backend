const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const stripe = require('../config/stripe');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('../config/cloudinary');

// Configure memory storage for multer uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Helper to upload buffer to Cloudinary
const uploadFromBuffer = (fileBuffer, folder) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: folder },
      (error, result) => {
        if (result) {
          resolve(result);
        } else {
          reject(error);
        }
      }
    );
    stream.end(fileBuffer);
  });
};

// Apply auth and admin check to all routes here
router.use(authenticateToken);
router.use(authorizeRoles('admin'));

// 6.1 GET Admin Dashboard Stats & Recent Orders
router.get('/stats', async (req, res) => {
  try {
    // 1. Total Reps
    const [[{ total_reps }]] = await pool.query("SELECT COUNT(*) AS total_reps FROM users WHERE role = 'rep'");
    
    // 2. Total Doctors
    const [[{ total_doctors }]] = await pool.query("SELECT COUNT(*) AS total_doctors FROM doctors");
    
    // 3. Orders Today
    const [[{ orders_today }]] = await pool.query("SELECT COUNT(*) AS orders_today FROM orders WHERE DATE(created_at) = CURDATE()");
    
    // 4. Orders This Month
    const [[{ orders_month }]] = await pool.query(
      "SELECT COUNT(*) AS orders_month FROM orders WHERE MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())"
    );
    
    // 5. Revenue This Month (in cents, coalesced to 0)
    const [[{ revenue_month }]] = await pool.query(
      `SELECT COALESCE(SUM(total_cents), 0) AS revenue_month FROM orders 
       WHERE MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE()) 
       AND status IN ('paid', 'submitted_warehouse', 'confirmed', 'shipped', 'out_for_delivery', 'delivered', 'returned')`
    );

    // 6. Recent Orders (last 10)
    const [recentOrders] = await pool.query(
      `SELECT o.id, o.order_number, o.total_cents, o.status, o.created_at, 
              r.name AS rep_name, d.practice_name AS doctor_practice,
              d.doctor_first_name, d.doctor_last_name
       FROM orders o
       JOIN users r ON o.rep_id = r.id
       JOIN doctors d ON o.doctor_id = d.id
       ORDER BY o.created_at DESC
       LIMIT 10`
    );

    return res.status(200).json({
      stats: {
        totalReps: total_reps,
        totalDoctors: total_doctors,
        ordersToday: orders_today,
        ordersThisMonth: orders_month,
        revenueThisMonthCents: revenue_month
      },
      recentOrders
    });

  } catch (error) {
    console.error('Error fetching admin dashboard stats:', error);
    return res.status(500).json({ error: 'Failed to retrieve stats.' });
  }
});

// 6.2 GET List of all Reps
router.get('/reps', async (req, res) => {
  try {
    const [reps] = await pool.query(
      `SELECT u.id, u.email, u.name, u.rep_number, u.phone, u.active, u.created_at,
              (SELECT COUNT(*) FROM doctors WHERE rep_id = u.id) AS doctor_count,
              (SELECT COUNT(*) FROM orders WHERE rep_id = u.id) AS order_count
       FROM users u
       WHERE u.role = 'rep'
       ORDER BY u.name ASC`
    );
    return res.status(200).json(reps);
  } catch (error) {
    console.error('Error fetching reps:', error);
    return res.status(500).json({ error: 'Failed to retrieve reps.' });
  }
});

// 6.3 POST Add New Rep
router.post('/reps', async (req, res) => {
  const { name, email, rep_number, phone, password } = req.body;

  if (!name || !email || !rep_number || !password) {
    return res.status(400).json({ error: 'Name, email, representative number, and password are required.' });
  }

  try {
    // Check if email already exists
    const [existingEmail] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingEmail.length > 0) {
      return res.status(400).json({ error: 'A user with this email address already exists.' });
    }

    // Check if rep number already exists
    const [existingRepNum] = await pool.query('SELECT id FROM users WHERE rep_number = ?', [rep_number]);
    if (existingRepNum.length > 0) {
      return res.status(400).json({ error: 'Representative ID number already in use.' });
    }

    const passwordHash = password;
    const newId = uuidv4();

    await pool.query(
      `INSERT INTO users (id, email, password_hash, name, role, rep_number, phone, active) 
       VALUES (?, ?, ?, ?, 'rep', ?, ?, 1)`,
      [newId, email, passwordHash, name, rep_number, phone || null]
    );

    // Mock sending welcome email by logging it in the console
    console.log(`
======================================================
[MOCK WELCOME EMAIL SENT]
To: ${email}
Subject: Welcome to Lipistry Rep Portal!
Content:
Hi ${name},
You have been registered as a Lipistry Sales Representative.
Your Rep ID: ${rep_number}
Password: ${password}
Login URL: http://localhost:3000/login
======================================================
    `);

    return res.status(201).json({
      message: 'Representative created successfully.',
      user: {
        id: newId,
        name,
        email,
        rep_number,
        phone,
        active: 1
      },
      note: 'Welcome email was mocked. Check terminal logs for credentials.'
    });

  } catch (error) {
    console.error('Error creating rep:', error);
    return res.status(500).json({ error: 'Failed to create representative.' });
  }
});

// 6.3 PUT Edit Rep
router.put('/reps/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, rep_number, phone, active } = req.body;

  if (!name || !email || !rep_number) {
    return res.status(400).json({ error: 'Name, email, and representative number are required.' });
  }

  try {
    // Verify rep exists
    const [rep] = await pool.query('SELECT id FROM users WHERE id = ? AND role = "rep"', [id]);
    if (rep.length === 0) {
      return res.status(404).json({ error: 'Representative not found.' });
    }

    // Check unique constraints (excluding self)
    const [emailDup] = await pool.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, id]);
    if (emailDup.length > 0) {
      return res.status(400).json({ error: 'Email already used by another user.' });
    }

    const [repNumDup] = await pool.query('SELECT id FROM users WHERE rep_number = ? AND id != ?', [rep_number, id]);
    if (repNumDup.length > 0) {
      return res.status(400).json({ error: 'Rep number already used by another rep.' });
    }

    // Update details
    await pool.query(
      `UPDATE users 
       SET name = ?, email = ?, rep_number = ?, phone = ?, active = ? 
       WHERE id = ?`,
      [name, email, rep_number, phone || null, active ? 1 : 0, id]
    );

    return res.status(200).json({ message: 'Representative updated successfully.' });

  } catch (error) {
    console.error('Error updating rep:', error);
    return res.status(500).json({ error: 'Failed to update representative.' });
  }
});

// 6.3 POST Reset Rep Password
router.post('/reps/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password || password.trim().length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  try {
    const [rep] = await pool.query('SELECT id FROM users WHERE id = ? AND role = "rep"', [id]);
    if (rep.length === 0) {
      return res.status(404).json({ error: 'Representative not found.' });
    }

    const passwordHash = password; // plain text
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);

    return res.status(200).json({ message: "Representative's password reset successfully." });
  } catch (error) {
    console.error('Error resetting rep password:', error);
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// 6.4 GET List of all Products
router.get('/products', async (req, res) => {
  try {
    const [products] = await pool.query('SELECT * FROM products ORDER BY name ASC');
    return res.status(200).json(products);
  } catch (error) {
    console.error('Error fetching products:', error);
    return res.status(500).json({ error: 'Failed to retrieve products.' });
  }
});

// 6.5 POST Add Product
router.post('/products', async (req, res) => {
  const { name, sku, case_price, units_per_case, description, shopify_product_id, shopify_variant_id, active, images } = req.body;

  if (!name || !sku || case_price === undefined || !units_per_case) {
    return res.status(400).json({ error: 'Name, SKU, Case Price, and Units/Case are required.' });
  }

  try {
    // Check if SKU is unique
    const [dupSku] = await pool.query('SELECT id FROM products WHERE sku = ?', [sku]);
    if (dupSku.length > 0) {
      return res.status(400).json({ error: 'A product with this SKU already exists.' });
    }

    const imagesStr = Array.isArray(images) ? JSON.stringify(images) : (images || '[]');
    const newId = uuidv4();
    await pool.query(
      `INSERT INTO products (id, shopify_product_id, shopify_variant_id, name, sku, description, case_price, units_per_case, active, images)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId, 
        shopify_product_id || null, 
        shopify_variant_id || null, 
        name, 
        sku, 
        description || null, 
        parseInt(case_price), 
        parseInt(units_per_case), 
        active ? 1 : 0,
        imagesStr
      ]
    );

    return res.status(201).json({ message: 'Product added successfully.', id: newId });
  } catch (error) {
    console.error('Error creating product:', error);
    return res.status(500).json({ error: 'Failed to create product.' });
  }
});

// 6.5 PUT Edit Product
router.put('/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, sku, case_price, units_per_case, description, shopify_product_id, shopify_variant_id, active, images } = req.body;

  if (!name || !sku || case_price === undefined || !units_per_case) {
    return res.status(400).json({ error: 'Name, SKU, Case Price, and Units/Case are required.' });
  }

  try {
    // Check product exists
    const [prod] = await pool.query('SELECT id FROM products WHERE id = ?', [id]);
    if (prod.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    // Check SKU dup
    const [dupSku] = await pool.query('SELECT id FROM products WHERE sku = ? AND id != ?', [sku, id]);
    if (dupSku.length > 0) {
      return res.status(400).json({ error: 'SKU is already assigned to another product.' });
    }

    const imagesStr = Array.isArray(images) ? JSON.stringify(images) : (images || '[]');
    await pool.query(
      `UPDATE products 
       SET name = ?, sku = ?, case_price = ?, units_per_case = ?, description = ?, shopify_product_id = ?, shopify_variant_id = ?, active = ?, images = ?
       WHERE id = ?`,
      [
        name, 
        sku, 
        parseInt(case_price), 
        parseInt(units_per_case), 
        description || null, 
        shopify_product_id || null, 
        shopify_variant_id || null, 
        active ? 1 : 0, 
        imagesStr,
        id
      ]
    );

    return res.status(200).json({ message: 'Product updated successfully.' });
  } catch (error) {
    console.error('Error updating product:', error);
    return res.status(500).json({ error: 'Failed to update product.' });
  }
});

// POST Upload Product Images
router.post('/products/upload', upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files were uploaded.' });
    }
    
    const urls = [];
    for (const file of req.files) {
      try {
        // Upload memory buffer to Cloudinary
        const result = await uploadFromBuffer(file.buffer, 'Lipistry/products');
        urls.push(result.secure_url);
      } catch (cloudinaryError) {
        console.error('Cloudinary product upload failed:', cloudinaryError);
        return res.status(500).json({ error: `Cloudinary product upload failed: ${cloudinaryError.message}` });
      }
    }
    
    return res.status(200).json({ urls });
  } catch (error) {
    console.error('Error in product uploads route:', error);
    return res.status(500).json({ error: `Failed to upload images: ${error.message}` });
  }
});

// POST Adjust Product Stock (Admin)
router.post('/products/:id/adjust-stock', async (req, res) => {
  const { id } = req.params;
  const { quantity_change, notes } = req.body;
  const adminId = req.user?.id || 'admin';

  const change = parseInt(quantity_change);
  if (isNaN(change)) {
    return res.status(400).json({ error: 'Quantity change must be a valid integer.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Verify product exists
    const [prod] = await connection.query('SELECT id, name, stock_cases FROM products WHERE id = ?', [id]);
    if (prod.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Product not found.' });
    }

    const currentStock = prod[0].stock_cases;
    if (currentStock + change < 0) {
      await connection.rollback();
      return res.status(400).json({ error: `Cannot adjust stock below 0. Current stock is ${currentStock} cases.` });
    }

    // Update stock
    await connection.query('UPDATE products SET stock_cases = stock_cases + ? WHERE id = ?', [change, id]);

    // Insert log entry
    await connection.query(
      `INSERT INTO inventory_transactions (product_id, quantity_change, transaction_type, reference_id, notes)
       VALUES (?, ?, 'manual_adjustment', ?, ?)`,
      [id, change, adminId, notes || 'Manual adjustment by administrator']
    );

    await connection.commit();
    return res.status(200).json({ message: 'Product stock adjusted successfully.' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Error adjusting product stock:', error);
    return res.status(500).json({ error: 'Failed to adjust stock.' });
  } finally {
    if (connection) connection.release();
  }
});

// GET Product Inventory logs (Admin)
router.get('/products/:id/inventory-logs', async (req, res) => {
  const { id } = req.params;
  try {
    // Verify product exists
    const [prod] = await pool.query('SELECT id, name, sku, stock_cases FROM products WHERE id = ?', [id]);
    if (prod.length === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const [logs] = await pool.query(
      `SELECT it.*, u.name AS admin_name
       FROM inventory_transactions it
       LEFT JOIN users u ON it.reference_id = u.id AND it.transaction_type = 'manual_adjustment'
       WHERE it.product_id = ?
       ORDER BY it.created_at DESC`,
      [id]
    );

    // Return structured object with product info + logs array
    return res.status(200).json({ product: prod[0], logs });
  } catch (error) {
    console.error('Error fetching inventory logs:', error);
    return res.status(500).json({ error: 'Failed to retrieve inventory logs.' });
  }
});

// GET All Inventory Overview (dedicated inventory management page endpoint)
router.get('/inventory', async (req, res) => {
  try {
    const [products] = await pool.query(
      `SELECT id, name, sku, stock_cases, units_per_case, case_price, active, images,
              (SELECT COUNT(*) FROM inventory_transactions WHERE product_id = products.id) AS transaction_count,
              (SELECT created_at FROM inventory_transactions WHERE product_id = products.id ORDER BY created_at DESC LIMIT 1) AS last_transaction_at
       FROM products 
       ORDER BY name ASC`
    );
    return res.status(200).json(products);
  } catch (error) {
    console.error('Error fetching inventory overview:', error);
    return res.status(500).json({ error: 'Failed to retrieve inventory data.' });
  }
});

// GET All Inventory Transaction Logs (global audit log)
router.get('/inventory/logs', async (req, res) => {
  const { product_id, transaction_type } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  try {
    let query = `
      SELECT it.*, 
             p.name AS product_name, p.sku AS product_sku,
             u.name AS admin_name
      FROM inventory_transactions it
      LEFT JOIN products p ON it.product_id = p.id
      LEFT JOIN users u ON it.reference_id = u.id AND it.transaction_type = 'manual_adjustment'
      WHERE 1=1
    `;
    const params = [];
    if (product_id) { query += ' AND it.product_id = ?'; params.push(product_id); }
    if (transaction_type) { query += ' AND it.transaction_type = ?'; params.push(transaction_type); }
    query += ' ORDER BY it.created_at DESC LIMIT ?';
    params.push(limit);
    const [logs] = await pool.query(query, params);
    return res.status(200).json(logs);
  } catch (error) {
    console.error('Error fetching global inventory logs:', error);
    return res.status(500).json({ error: 'Failed to retrieve inventory logs.' });
  }
});

// 6.6 GET List of all Orders (with filters)
router.get('/orders', async (req, res) => {
  const { rep_id, doctor_id, status, start_date, end_date } = req.query;

  try {
    let query = `
      SELECT o.*, 
             (SELECT COALESCE(SUM(quantity_cases), 0) FROM order_items WHERE order_id = o.id) AS total_quantity,
             r.name AS rep_name, d.practice_name AS doctor_practice,
             d.doctor_first_name, d.doctor_last_name, d.stripe_customer_id AS stripe_customer_id
      FROM orders o
      JOIN users r ON o.rep_id = r.id
      JOIN doctors d ON o.doctor_id = d.id
      WHERE 1=1
    `;
    const params = [];

    if (rep_id) {
      query += ` AND o.rep_id = ?`;
      params.push(rep_id);
    }
    if (doctor_id) {
      query += ` AND o.doctor_id = ?`;
      params.push(doctor_id);
    }
    if (status) {
      query += ` AND o.status = ?`;
      params.push(status);
    }
    if (start_date) {
      query += ` AND o.created_at >= ?`;
      params.push(start_date + ' 00:00:00');
    }
    if (end_date) {
      query += ` AND o.created_at <= ?`;
      params.push(end_date + ' 23:59:59');
    }

    query += ` ORDER BY o.created_at DESC`;

    const [orders] = await pool.query(query, params);
    return res.status(200).json(orders);

  } catch (error) {
    console.error('Error fetching all orders:', error);
    return res.status(500).json({ error: 'Failed to retrieve orders.' });
  }
});

// GET Order details (including items)
router.get('/orders/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [orderInfo] = await pool.query(
      `SELECT o.*, 
              (SELECT COALESCE(SUM(quantity_cases), 0) FROM order_items WHERE order_id = o.id) AS total_quantity,
              r.name AS rep_name, r.email AS rep_email,
              d.practice_name AS doctor_practice, d.doctor_first_name, d.doctor_last_name,
              d.address_line1, d.address_line2, d.city, d.state, d.zip, d.phone AS doctor_phone, d.email AS doctor_email,
              d.stripe_customer_id AS stripe_customer_id
       FROM orders o
       JOIN users r ON o.rep_id = r.id
       JOIN doctors d ON o.doctor_id = d.id
       WHERE o.id = ?`,
      [id]
    );

    if (orderInfo.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const [items] = await pool.query(
      `SELECT oi.*, oi.quantity_cases AS quantity, oi.case_price_snapshot AS price_cents, p.name AS product_name, p.images AS product_images
       FROM order_items oi
       LEFT JOIN products p ON oi.product_id = p.id
       WHERE oi.order_id = ?`,
      [id]
    );

    return res.status(200).json({
      order: orderInfo[0],
      items
    });

  } catch (error) {
    console.error('Error fetching order detail:', error);
    return res.status(500).json({ error: 'Failed to retrieve order details.' });
  }
});

// PUT Update Order Status (Admin)
router.put('/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, tracking_number, shipping_carrier, tracking_notes } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Status is required.' });
  }

  const validStatuses = [
    'submitted_warehouse', 'confirmed', 'shipped', 
    'out_for_delivery', 'delivered', 'cancelled', 
    'return_requested', 'return_approved', 'returned', 'refunded'
  ];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid order status.' });
  }

  try {
    // 1. Fetch current order
    const [ord] = await pool.query('SELECT id, status, order_number, stripe_payment_intent_id, stripe_charge_id, total_cents FROM orders WHERE id = ?', [id]);
    if (ord.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    const currentStatus = ord[0].status;
    const orderNumber = ord[0].order_number;
    const stripeChargeId = ord[0].stripe_charge_id;
    const stripePaymentIntentId = ord[0].stripe_payment_intent_id;
    const totalCents = ord[0].total_cents;

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      // 2. Set dynamic parameters based on new status
      let extraSql = '';
      const extraParams = [];

      if (status === 'shipped') {
        extraSql += ', shipped_at = CURRENT_TIMESTAMP';
      } else if (status === 'delivered') {
        extraSql += ', delivered_at = CURRENT_TIMESTAMP';
      } else if (status === 'returned' || status === 'refunded') {
        extraSql += ', return_processed_at = CURRENT_TIMESTAMP';
      }

      // If status is refunded, invoke Stripe refund
      if (status === 'refunded' && currentStatus !== 'refunded') {
        if (stripeChargeId) {
          try {
            const refund = await stripe.refunds.create({
              charge: stripeChargeId,
              amount: totalCents
            });
            console.log('Stripe refund processed successfully:', refund.id);

            // Log the refund in payments table
            await connection.query(
              `INSERT INTO payments (id, order_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, currency, status, brand, last4, error_message)
               VALUES (?, ?, ?, ?, ?, 'usd', 'refunded', NULL, NULL, NULL)`,
              [
                uuidv4(),
                id,
                stripePaymentIntentId || null,
                refund.id,
                -totalCents
              ]
            );
          } catch (stripeError) {
            console.error('Stripe refund API call failed:', stripeError);
            await connection.rollback();
            return res.status(400).json({ error: `Stripe Refund failed: ${stripeError.message}` });
          }
        }
      }

      // Update tracking info if provided
      if (tracking_number !== undefined) {
        extraSql += ', tracking_number = ?';
        extraParams.push(tracking_number);
      }
      if (shipping_carrier !== undefined) {
        extraSql += ', shipping_carrier = ?';
        extraParams.push(shipping_carrier);
      }
      if (tracking_notes !== undefined) {
        extraSql += ', tracking_notes = ?';
        extraParams.push(tracking_notes);
      }

      await connection.query(
        `UPDATE orders 
         SET status = ? ${extraSql} 
         WHERE id = ?`,
         [status, ...extraParams, id]
      );

      // Restock products if status transitions to returned or cancelled and wasn't already returned/cancelled/refunded
      const targetRestock = (status === 'returned' || status === 'cancelled');
      const alreadyRestocked = (currentStatus === 'returned' || currentStatus === 'cancelled' || currentStatus === 'refunded');

      if (targetRestock && !alreadyRestocked) {
        // Fetch order items to restock
        const [items] = await connection.query(
          'SELECT product_id, quantity_cases FROM order_items WHERE order_id = ?',
          [id]
        );

        for (const item of items) {
          // Increment stock
          await connection.query(
            'UPDATE products SET stock_cases = stock_cases + ? WHERE id = ?',
            [item.quantity_cases, item.product_id]
          );

          // Log transaction
          await connection.query(
            `INSERT INTO inventory_transactions (product_id, quantity_change, transaction_type, reference_id, notes)
             VALUES (?, ?, ?, ?, ?)`,
            [
              item.product_id, 
              item.quantity_cases, 
              status === 'returned' ? 'order_returned' : 'manual_adjustment',
              id,
              `Restocked from ${status === 'returned' ? 'returned' : 'cancelled'} order ${orderNumber}`
            ]
          );
        }
      }

      await connection.commit();
      return res.status(200).json({ message: 'Order status updated successfully.' });
    } catch (err) {
      if (connection) await connection.rollback();
      throw err;
    } finally {
      if (connection) connection.release();
    }
  } catch (error) {
    console.error('Error updating order status:', error);
    return res.status(500).json({ error: 'Failed to update order status.' });
  }
});

// 6.7 GET List of all Doctors
router.get('/doctors', async (req, res) => {
  try {
    const [doctors] = await pool.query(
      `SELECT d.*, r.name AS rep_name, r.email AS rep_email 
       FROM doctors d 
       JOIN users r ON d.rep_id = r.id 
       ORDER BY d.practice_name ASC`
    );
    return res.status(200).json(doctors);
  } catch (error) {
    console.error('Error fetching doctors:', error);
    return res.status(500).json({ error: 'Failed to retrieve doctors.' });
  }
});

// 6.7 PUT Reassign Doctor
router.put('/doctors/:id/reassign', async (req, res) => {
  const { id } = req.params;
  const { rep_id } = req.body;

  if (!rep_id) {
    return res.status(400).json({ error: 'New Representative ID is required.' });
  }

  try {
    // Verify rep exists and is active
    const [rep] = await pool.query('SELECT id, active FROM users WHERE id = ? AND role = "rep"', [rep_id]);
    if (rep.length === 0) {
      return res.status(404).json({ error: 'Representative not found.' });
    }
    if (!rep[0].active) {
      return res.status(400).json({ error: 'Cannot reassign to a deactivated representative.' });
    }

    // Verify doctor exists
    const [doc] = await pool.query('SELECT id FROM doctors WHERE id = ?', [id]);
    if (doc.length === 0) {
      return res.status(404).json({ error: 'Doctor account not found.' });
    }

    await pool.query('UPDATE doctors SET rep_id = ? WHERE id = ?', [rep_id, id]);

    return res.status(200).json({ message: 'Doctor practice successfully reassigned.' });
  } catch (error) {
    console.error('Error reassigning doctor:', error);
    return res.status(500).json({ error: 'Failed to reassign doctor practice.' });
  }
});

// POST Add Doctor (Admin)
router.post('/doctors', async (req, res) => {
  const {
    rep_id,
    practice_name,
    doctor_first_name,
    doctor_last_name,
    address_line1,
    address_line2,
    city,
    state,
    zip,
    phone,
    email,
    notes,
    active
  } = req.body;

  // Validation
  if (!rep_id || !practice_name || !doctor_first_name || !doctor_last_name || !address_line1 || !city || !state || !zip || !phone || !email) {
    return res.status(400).json({ error: 'All required practice profile fields must be filled, including Representative.' });
  }

  // ZIP Code validation (5 or 6 digits)
  if (!/^\d{5,6}$/.test(zip)) {
    return res.status(400).json({ error: 'ZIP Code must be 5 or 6 numeric digits.' });
  }

  // Email format validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid practice email address.' });
  }

  try {
    // Verify rep exists and is active
    const [rep] = await pool.query('SELECT id, active FROM users WHERE id = ? AND role = "rep"', [rep_id]);
    if (rep.length === 0) {
      return res.status(404).json({ error: 'Selected representative not found.' });
    }
    if (!rep[0].active) {
      return res.status(400).json({ error: 'Cannot assign a doctor to a deactivated representative.' });
    }

    const newId = uuidv4();
    await pool.query(
      `INSERT INTO doctors (id, rep_id, practice_name, doctor_first_name, doctor_last_name, address_line1, address_line2, city, state, zip, phone, email, notes, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId,
        rep_id,
        practice_name,
        doctor_first_name,
        doctor_last_name,
        address_line1,
        address_line2 || null,
        city,
        state,
        zip,
        phone,
        email,
        notes || null,
        active !== undefined ? active : 1
      ]
    );

    return res.status(201).json({
      message: 'Doctor practice profile created successfully.',
      id: newId
    });
  } catch (error) {
    console.error('Error creating doctor by admin:', error);
    return res.status(500).json({ error: 'Failed to create doctor profile.' });
  }
});

// PUT Edit Doctor (Admin)
router.put('/doctors/:id', async (req, res) => {
  const { id } = req.params;
  const {
    rep_id,
    practice_name,
    doctor_first_name,
    doctor_last_name,
    address_line1,
    address_line2,
    city,
    state,
    zip,
    phone,
    email,
    notes,
    active
  } = req.body;

  // Validation
  if (!rep_id || !practice_name || !doctor_first_name || !doctor_last_name || !address_line1 || !city || !state || !zip || !phone || !email) {
    return res.status(400).json({ error: 'All required practice profile fields must be filled.' });
  }

  if (!/^\d{5,6}$/.test(zip)) {
    return res.status(400).json({ error: 'ZIP Code must be 5 or 6 numeric digits.' });
  }

  try {
    // Verify doctor exists
    const [doc] = await pool.query('SELECT id FROM doctors WHERE id = ?', [id]);
    if (doc.length === 0) {
      return res.status(404).json({ error: 'Doctor account not found.' });
    }

    // Verify rep exists and is active
    const [rep] = await pool.query('SELECT id, active FROM users WHERE id = ? AND role = "rep"', [rep_id]);
    if (rep.length === 0) {
      return res.status(404).json({ error: 'Selected representative not found.' });
    }
    if (!rep[0].active) {
      return res.status(400).json({ error: 'Cannot assign a doctor to a deactivated representative.' });
    }

    await pool.query(
      `UPDATE doctors
       SET rep_id = ?, practice_name = ?, doctor_first_name = ?, doctor_last_name = ?, address_line1 = ?, address_line2 = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?, notes = ?, active = ?
       WHERE id = ?`,
      [
        rep_id,
        practice_name,
        doctor_first_name,
        doctor_last_name,
        address_line1,
        address_line2 || null,
        city,
        state,
        zip,
        phone,
        email,
        notes || null,
        active !== undefined ? active : 1,
        id
      ]
    );

    return res.status(200).json({ message: 'Doctor practice profile updated successfully.' });
  } catch (error) {
    console.error('Error updating doctor by admin:', error);
    return res.status(500).json({ error: 'Failed to update doctor profile.' });
  }
});

// POST Save Doctor's Credit Card (Admin)
router.post('/doctors/:id/card', async (req, res) => {
  const { id } = req.params;
  const { card_brand, last4, exp_month, exp_year } = req.body;

  if (!card_brand || !last4 || !exp_month || !exp_year) {
    return res.status(400).json({ error: 'All card details are required.' });
  }

  try {
    // Verify doctor exists
    const [doc] = await pool.query('SELECT id FROM doctors WHERE id = ?', [id]);
    if (doc.length === 0) {
      return res.status(404).json({ error: 'Doctor account not found.' });
    }

    // Mock saving card info by serializing to JSON inside stripe_customer_id
    const cardInfo = JSON.stringify({
      brand: card_brand,
      last4,
      exp_month,
      exp_year
    });

    await pool.query('UPDATE doctors SET stripe_customer_id = ? WHERE id = ?', [cardInfo, id]);

    return res.status(200).json({ message: 'Credit card on file saved successfully.' });
  } catch (error) {
    console.error('Error saving doctor credit card by admin:', error);
    return res.status(500).json({ error: 'Failed to update credit card.' });
  }
});

module.exports = router;
