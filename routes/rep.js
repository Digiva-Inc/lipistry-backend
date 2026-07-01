const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
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

// Apply JWT authentication and Rep role restriction
router.use(authenticateToken);
router.use(authorizeRoles('rep'));

// Helper to format currency
const formatPrice = (cents) => (cents / 100).toFixed(2);

// 5.2 Get Sales Rep Dashboard stats & recent 10 orders
router.get('/dashboard', async (req, res) => {
  const repId = req.user.id;

  try {
    // 1. Total Doctors count
    const [[{ doctor_count }]] = await pool.query(
      "SELECT COUNT(*) AS doctor_count FROM doctors WHERE rep_id = ? AND active = 1",
      [repId]
    );

    // 2. Total Orders count
    const [[{ order_count }]] = await pool.query(
      "SELECT COUNT(*) AS order_count FROM orders WHERE rep_id = ? AND status NOT IN ('pending_payment', 'failed_payment')",
      [repId]
    );

    // 3. Total Sales Revenue (Paid, submitted, or fulfilled)
    const [[{ total_sales }]] = await pool.query(
      `SELECT COALESCE(SUM(total_cents), 0) AS total_sales FROM orders 
       WHERE rep_id = ? AND status IN ('paid', 'submitted_warehouse', 'fulfilled')`,
      [repId]
    );

    // 4. Recent Orders (Last 10)
    const [recentOrders] = await pool.query(
      `SELECT o.id, o.order_number, o.total_cents, o.status, o.created_at,
              d.practice_name AS doctor_practice, d.doctor_first_name, d.doctor_last_name
       FROM orders o
       JOIN doctors d ON o.doctor_id = d.id
       WHERE o.rep_id = ? AND o.status NOT IN ('pending_payment', 'failed_payment')
       ORDER BY o.created_at DESC
       LIMIT 10`,
      [repId]
    );

    // 5. My Doctors panel preview (Doctors + last order date)
    const [myDoctors] = await pool.query(
      `SELECT d.id, d.practice_name, d.doctor_first_name, d.doctor_last_name, d.city, d.state, d.stripe_customer_id,
              (SELECT MAX(o.created_at) FROM orders o WHERE o.doctor_id = d.id AND o.status != 'draft') AS last_order_date
       FROM doctors d
       WHERE d.rep_id = ? AND d.active = 1
       ORDER BY d.practice_name ASC`,
      [repId]
    );

    return res.status(200).json({
      stats: {
        doctorCount: doctor_count,
        orderCount: order_count,
        totalSalesCents: total_sales
      },
      recentOrders,
      myDoctors
    });

  } catch (error) {
    console.error('Error fetching rep dashboard stats:', error);
    return res.status(500).json({ error: 'Failed to retrieve dashboard data.' });
  }
});

// 5.3 Get list of all Doctors owned by rep
router.get('/doctors', async (req, res) => {
  const repId = req.user.id;
  const { search } = req.query;

  try {
    let query = `
      SELECT d.*, 
             (SELECT MAX(o.created_at) FROM orders o WHERE o.doctor_id = d.id AND o.status != 'draft') AS last_order_date
      FROM doctors d
      WHERE d.rep_id = ? AND d.active = 1
    `;
    const params = [repId];

    if (search) {
      query += ` AND (d.practice_name LIKE ? OR d.doctor_first_name LIKE ? OR d.doctor_last_name LIKE ? OR d.city LIKE ?)`;
      const searchWild = `%${search}%`;
      params.push(searchWild, searchWild, searchWild, searchWild);
    }

    query += ` ORDER BY d.practice_name ASC`;

    
    const [doctors] = await pool.query(query, params);
    return res.status(200).json(doctors);
  } catch (error) {
    console.error('Error fetching rep doctors:', error);
    return res.status(500).json({ error: 'Failed to retrieve doctors list.' });
  }
});

// 5.5 Get Doctor details (including saved card details and order history)
router.get('/doctors/:id', async (req, res) => {
  const repId = req.user.id;
  const { id } = req.params;

  try {
    // 1. Fetch Doctor details (must belong to this rep)
    const [docRows] = await pool.query(
      "SELECT * FROM doctors WHERE id = ? AND rep_id = ? AND active = 1",
      [id, repId]
    );

    if (docRows.length === 0) {
      return res.status(404).json({ error: 'Doctor account not found or access denied.' });
    }

    const doctor = docRows[0];

    // Decode mock card info from stripe_customer_id if it starts with mock JSON
    let cardInfo = null;
    if (doctor.stripe_customer_id && doctor.stripe_customer_id.startsWith('{')) {
      try {
        cardInfo = JSON.parse(doctor.stripe_customer_id);
      } catch (err) {
        // Fallback
      }
    }

    // 2. Fetch past orders
    const [orders] = await pool.query(
      `SELECT id, order_number, total_cents, status, created_at
       FROM orders
       WHERE doctor_id = ? AND rep_id = ?
       ORDER BY created_at DESC`,
      [id, repId]
    );

    return res.status(200).json({
      doctor,
      cardInfo,
      orders
    });
  } catch (error) {
    console.error('Error fetching doctor details:', error);
    return res.status(500).json({ error: 'Failed to retrieve doctor details.' });
  }
});

// 5.4 POST Add New Doctor
router.post('/doctors', async (req, res) => {
  const repId = req.user.id;
  const {
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
    notes
  } = req.body;

  // Validation
  if (!practice_name || !doctor_first_name || !doctor_last_name || !address_line1 || !city || !state || !zip || !phone || !email) {
    return res.status(400).json({ error: 'All required practice profile fields must be filled.' });
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
    const newId = uuidv4();
    await pool.query(
      `INSERT INTO doctors (id, rep_id, practice_name, doctor_first_name, doctor_last_name, address_line1, address_line2, city, state, zip, phone, email, notes, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        newId,
        repId,
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
        notes || null
      ]
    );

    return res.status(201).json({
      message: 'Doctor practice profile created successfully.',
      id: newId
    });
  } catch (error) {
    console.error('Error creating doctor:', error);
    return res.status(500).json({ error: 'Failed to create doctor profile.' });
  }
});

// 5.4 PUT Edit Doctor
router.put('/doctors/:id', async (req, res) => {
  const repId = req.user.id;
  const { id } = req.params;
  const {
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
    notes
  } = req.body;

  // Validation
  if (!practice_name || !doctor_first_name || !doctor_last_name || !address_line1 || !city || !state || !zip || !phone || !email) {
    return res.status(400).json({ error: 'All required practice profile fields must be filled.' });
  }

  if (!/^\d{5,6}$/.test(zip)) {
    return res.status(400).json({ error: 'ZIP Code must be 5 or 6 numeric digits.' });
  }

  try {
    // Verify ownership
    const [doc] = await pool.query('SELECT id FROM doctors WHERE id = ? AND rep_id = ? AND active = 1', [id, repId]);
    if (doc.length === 0) {
      return res.status(404).json({ error: 'Doctor account not found or access denied.' });
    }

    await pool.query(
      `UPDATE doctors
       SET practice_name = ?, doctor_first_name = ?, doctor_last_name = ?, address_line1 = ?, address_line2 = ?, city = ?, state = ?, zip = ?, phone = ?, email = ?, notes = ?
       WHERE id = ?`,
      [
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
        id
      ]
    );

    return res.status(200).json({ message: 'Doctor practice profile updated successfully.' });
  } catch (error) {
    console.error('Error updating doctor:', error);
    return res.status(500).json({ error: 'Failed to update doctor profile.' });
  }
});

// 5.5 POST Update Doctor's Credit Card
router.post('/doctors/:id/card', async (req, res) => {
  const repId = req.user.id;
  const { id } = req.params;
  const { card_brand, last4, exp_month, exp_year, payment_method_id } = req.body;

  try {
    // Verify ownership
    const [doc] = await pool.query('SELECT * FROM doctors WHERE id = ? AND rep_id = ? AND active = 1', [id, repId]);
    if (doc.length === 0) {
      return res.status(404).json({ error: 'Doctor account not found or access denied.' });
    }
    const doctor = doc[0];

    const stripe = require('../config/stripe');

    let stripeCustomerId = null;
    if (doctor.stripe_customer_id) {
      if (doctor.stripe_customer_id.startsWith('{')) {
        try {
          const parsed = JSON.parse(doctor.stripe_customer_id);
          stripeCustomerId = parsed.customerId;
        } catch (e) {
          stripeCustomerId = doctor.stripe_customer_id;
        }
      } else {
        stripeCustomerId = doctor.stripe_customer_id;
      }
    }

    // Create Stripe customer if none exists
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: doctor.email,
        name: `Dr. ${doctor.doctor_first_name} ${doctor.doctor_last_name} - ${doctor.practice_name}`,
      });
      stripeCustomerId = customer.id;
    }

    let finalBrand = card_brand;
    let finalLast4 = last4;
    let finalExpMonth = exp_month;
    let finalExpYear = exp_year;
    let pmId = payment_method_id || null;

    if (payment_method_id) {
      // Retrieve PM details from Stripe
      const pm = await stripe.paymentMethods.retrieve(payment_method_id);
      // Attach to customer
      await stripe.paymentMethods.attach(payment_method_id, { customer: stripeCustomerId });
      
      finalBrand = pm.card.brand;
      finalLast4 = pm.card.last4;
      finalExpMonth = pm.card.exp_month;
      finalExpYear = pm.card.exp_year;
      pmId = pm.id;
    }

    if (!finalBrand || !finalLast4 || !finalExpMonth || !finalExpYear) {
      return res.status(400).json({ error: 'Card brand, last 4 digits, and expiration are required.' });
    }

    // Save Customer ID and card details as JSON inside stripe_customer_id column
    const stripeCustomerPayload = JSON.stringify({
      customerId: stripeCustomerId,
      paymentMethodId: pmId,
      brand: finalBrand,
      last4: finalLast4,
      expiry: `${finalExpMonth}/${finalExpYear}`
    });

    await pool.query(
      'UPDATE doctors SET stripe_customer_id = ? WHERE id = ?',
      [stripeCustomerPayload, id]
    );

    return res.status(200).json({ message: 'Credit card on file updated successfully.' });
  } catch (error) {
    console.error('Error saving credit card info:', error);
    return res.status(500).json({ error: `Failed to update payment card on file: ${error.message}` });
  }
});

// Get catalog products list for placing order
router.get('/products', async (req, res) => {
  try {
    const [products] = await pool.query('SELECT * FROM products WHERE active = 1 ORDER BY name ASC');
    return res.status(200).json(products);
  } catch (error) {
    console.error('Error fetching catalog products:', error);
    return res.status(500).json({ error: 'Failed to load catalog products.' });
  }
});

// Place New wholesale Order (Draft/Pending Payment)
router.post('/orders', async (req, res) => {
  const repId = req.user.id;
  const { doctor_id, items, notes } = req.body; 

  if (!doctor_id || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Doctor ID and at least one catalog item are required.' });
  }

  let connection;
  const orderId = uuidv4();
  const randSuffix = Math.floor(1000 + Math.random() * 9000);
  const orderNumber = `LIP-${new Date().getFullYear()}-${randSuffix}`;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Fetch Doctor details (must belong to this rep)
    const [docRows] = await connection.query(
      "SELECT * FROM doctors WHERE id = ? AND rep_id = ? AND active = 1",
      [doctor_id, repId]
    );

    if (docRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Doctor account not found or access denied.' });
    }

    // 2. Fetch products, lock rows, validate local stock, and calculate total cents
    let subtotalCents = 0;
    const itemsDetails = [];

    for (const item of items) {
      const [prodRows] = await connection.query(
        "SELECT * FROM products WHERE id = ? AND active = 1 FOR UPDATE",
        [item.product_id]
      );

      if (prodRows.length === 0) {
        await connection.rollback();
        return res.status(400).json({ error: `Product with ID ${item.product_id} is no longer active in the catalog.` });
      }

      const product = prodRows[0];
      const quantity = parseInt(item.quantity);
      if (isNaN(quantity) || quantity <= 0) {
        await connection.rollback();
        return res.status(400).json({ error: 'Item quantities must be positive integers.' });
      }

      // Local Stock Check
      if (product.stock_cases < quantity) {
        await connection.rollback();
        return res.status(400).json({ 
          error: `Insufficient stock for product "${product.name}". Available: ${product.stock_cases} cases, requested: ${quantity} cases.`
        });
      }

      const lineTotal = product.case_price * quantity;
      subtotalCents += lineTotal;

      itemsDetails.push({
        product_id: product.id,
        name: product.name,
        sku: product.sku,
        case_price: product.case_price,
        units_per_case: product.units_per_case,
        quantity,
        lineTotal
      });
    }

    const totalCents = subtotalCents;

    // 3. Deduct local stock & insert inventory transaction audit logs
    for (const d of itemsDetails) {
      await connection.query(
        "UPDATE products SET stock_cases = stock_cases - ? WHERE id = ?",
        [d.quantity, d.product_id]
      );

      await connection.query(
        `INSERT INTO inventory_transactions (product_id, quantity_change, transaction_type, reference_id, notes)
         VALUES (?, ?, 'order_fulfillment', ?, ?)`,
        [d.product_id, -d.quantity, orderId, `Cases reserved for order ${orderNumber}`]
      );
    }

    // 4. Insert Order (status pending_payment)
    await connection.query(
      `INSERT INTO orders (id, order_number, rep_id, doctor_id, status, stripe_payment_intent_id, stripe_charge_id, subtotal_cents, total_cents, notes)
       VALUES (?, ?, ?, ?, 'pending_payment', NULL, NULL, ?, ?, ?)`,
      [
        orderId,
        orderNumber,
        repId,
        doctor_id,
        subtotalCents,
        totalCents,
        notes || null
      ]
    );

    // 5. Insert Order Items
    for (const d of itemsDetails) {
      await connection.query(
        `INSERT INTO order_items (id, order_id, product_id, product_name_snapshot, sku_snapshot, case_price_snapshot, units_per_case, quantity_cases, line_total_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          orderId,
          d.product_id,
          d.name,
          d.sku,
          d.case_price,
          d.units_per_case,
          d.quantity,
          d.lineTotal
        ]
      );
    }

    await connection.commit();
    return res.status(201).json({
      message: 'Order created and pending payment.',
      order_id: orderId,
      order_number: orderNumber
    });

  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Error placing rep order:', error);
    return res.status(500).json({ error: 'Failed to create wholesale order.' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// Create Stripe Checkout Session for an existing pending order
router.post('/orders/create-checkout-session', async (req, res) => {
  const repId = req.user.id;
  const { orderId } = req.body;

  try {
    // 1. Fetch Order and Doctor
    const [orderRows] = await pool.query(
      `SELECT o.*, d.email, d.practice_name, d.doctor_first_name, d.doctor_last_name, d.stripe_customer_id, d.id as doc_id
       FROM orders o
       JOIN doctors d ON o.doctor_id = d.id
       WHERE o.id = ? AND o.rep_id = ?`,
      [orderId, repId]
    );

    if (orderRows.length === 0) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const order = orderRows[0];
    if (order.status !== 'pending_payment' && order.status !== 'failed_payment') {
      return res.status(400).json({ error: `Order cannot be paid because it is in status: ${order.status}` });
    }

    const totalCents = order.total_cents;
    const stripe = require('../config/stripe');

    // Parse stripe_customer_id if it's a JSON string
    let stripeCustomerId = null;
    if (order.stripe_customer_id) {
      if (order.stripe_customer_id.startsWith('{')) {
        try {
          const parsed = JSON.parse(order.stripe_customer_id);
          stripeCustomerId = parsed.customerId;
        } catch (e) {
          stripeCustomerId = order.stripe_customer_id;
        }
      } else {
        stripeCustomerId = order.stripe_customer_id;
      }
    }

    // Create a new customer dynamically if none exists for this doctor
    if (!stripeCustomerId) {
      try {
        const customer = await stripe.customers.create({
          email: order.email,
          name: `Dr. ${order.doctor_first_name} ${order.doctor_last_name} - ${order.practice_name}`,
        });
        stripeCustomerId = customer.id;

        // Save back to DB
        await pool.query('UPDATE doctors SET stripe_customer_id = ? WHERE id = ?', [stripeCustomerId, order.doc_id]);
      } catch (err) {
        console.warn('Could not create Stripe customer:', err);
      }
    }

    // Fetch actual line items
    const [orderItems] = await pool.query(`
      SELECT oi.*, p.name as product_name
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `, [orderId]);

    const stripeLineItems = orderItems.map(item => ({
      price_data: {
        currency: 'inr',
        product_data: {
          name: item.product_name,
          description: `Case of ${item.units_per_case} units (SKU: ${item.sku_snapshot})`,
        },
        unit_amount: item.case_price_snapshot,
      },
      quantity: item.quantity_cases,
    }));

    const clientUrl = process.env.CLIENT_URL;

    // 2. Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'upi'],
      customer: stripeCustomerId || undefined,
      client_reference_id: orderId,
      expires_at: Math.floor(Date.now() / 1000) + (30 * 60), // Stripe minimum expiration is 30 minutes
      line_items: stripeLineItems,
      mode: 'payment',
      success_url: `${clientUrl}/rep/orders/confirmation?id=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/rep/orders/pay?id=${orderId}`,
    });

    // Save session ID to order
    await pool.query('UPDATE orders SET stripe_checkout_session_id = ? WHERE id = ?', [session.id, orderId]);

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    return res.status(500).json({ error: 'Failed to initialize payment gateway.' });
  }
});

// Verify Payment Realtime Fallback
router.get('/orders/:id/verify-payment', async (req, res) => {
  const repId = req.user.id;
  const orderId = req.params.id;
  const querySessionId = req.query.session_id;

  try {
    const stripe = require('../config/stripe');
    // Verify ownership
    const [orders] = await pool.query('SELECT * FROM orders WHERE id = ? AND rep_id = ?', [orderId, repId]);
    if (orders.length === 0) return res.status(404).json({ error: 'Order not found.' });

    const order = orders[0];
    const sessionId = querySessionId || order.stripe_checkout_session_id;

    if (!sessionId) {
      return res.status(400).json({ error: 'Missing session ID.' });
    }

    // Retrieve session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if ((session.payment_status === 'paid' || session.status === 'complete') && (order.status === 'pending_payment' || order.status === 'failed_payment' || order.status === 'draft')) {
      // Sync it locally!
      await pool.query(
        "UPDATE orders SET status = 'submitted_warehouse', stripe_payment_intent_id = ? WHERE id = ?",
        [session.payment_intent, order.id]
      );
      console.log(`Fallback Verification: Order ${order.order_number} marked as paid.`);

      // Log to the payments table since webhooks aren't running locally
      const [existingPayments] = await pool.query(
        'SELECT * FROM payments WHERE order_id = ? AND status = "succeeded"',
        [order.id]
      );

      if (existingPayments.length === 0) {
        let brand = 'Unknown';
        let last4 = '0000';
        let chargeId = null;

        // Try to fetch payment intent details
        if (session.payment_intent) {
          try {
             const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
             chargeId = pi.latest_charge || null;
             if (pi.payment_method_details?.card) {
               brand = pi.payment_method_details.card.brand;
               last4 = pi.payment_method_details.card.last4;
             } else if (pi.payment_method_details?.upi) {
               brand = 'UPI / QR Code';
               last4 = pi.payment_method_details.upi.vpa || 'unknown';
             }
          } catch (e) {
             console.warn("Failed to fetch payment intent details for logging", e);
          }
        }

        await pool.query(
          `INSERT INTO payments (id, order_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, currency, status, brand, last4, error_message)
           VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, NULL)`,
          [uuidv4(), order.id, session.payment_intent || null, chargeId, session.amount_total, session.currency || 'inr', brand, last4]
        );
      }

      return res.status(200).json({ message: 'Order successfully verified and updated.' });
    }

    return res.status(200).json({ message: 'Order status unchanged.' });
  } catch (error) {
    console.error('Error verifying payment:', error);
    return res.status(500).json({ error: 'Failed to verify payment.' });
  }
});

// Mark Paid Direct (for Personal UPI)
router.post('/orders/:id/mark-paid-direct', async (req, res) => {
  const repId = req.user.id;
  const orderId = req.params.id;

  try {
    // Verify ownership
    const [orders] = await pool.query('SELECT * FROM orders WHERE id = ? AND rep_id = ?', [orderId, repId]);
    if (orders.length === 0) return res.status(404).json({ error: 'Order not found.' });

    const order = orders[0];
    
    if (order.status === 'pending_payment' || order.status === 'failed_payment' || order.status === 'draft') {
      await pool.query(
        "UPDATE orders SET status = 'submitted_warehouse', stripe_payment_intent_id = 'direct_upi' WHERE id = ?",
        [order.id]
      );
      return res.status(200).json({ message: 'Order successfully marked as paid via Direct UPI.' });
    }

    return res.status(400).json({ error: 'Order is not in a valid state to be marked as paid.' });
  } catch (error) {
    console.error('Error marking order paid direct:', error);
    return res.status(500).json({ error: 'Failed to process payment status.' });
  }
});

// List rep's own past orders
router.get('/orders', async (req, res) => {
  const repId = req.user.id;

  try {
    const [orders] = await pool.query(
      `SELECT o.*, 
              (SELECT COALESCE(SUM(quantity_cases), 0) FROM order_items WHERE order_id = o.id) AS total_quantity,
              d.practice_name AS doctor_practice, d.doctor_first_name, d.doctor_last_name, d.stripe_customer_id AS stripe_customer_id
       FROM orders o
       JOIN doctors d ON o.doctor_id = d.id
       WHERE o.rep_id = ?
       ORDER BY o.created_at DESC`,
      [repId]
    );

    return res.status(200).json(orders);
  } catch (error) {
    console.error('Error fetching rep orders:', error);
    return res.status(500).json({ error: 'Failed to retrieve orders log.' });
  }
});

// GET details of a single order belonging to rep
router.get('/orders/:id', async (req, res) => {
  const repId = req.user.id;
  const { id } = req.params;

  try {
    const [orderInfo] = await pool.query(
      `SELECT o.*, 
              (SELECT COALESCE(SUM(quantity_cases), 0) FROM order_items WHERE order_id = o.id) AS total_quantity,
              d.practice_name AS doctor_practice, d.doctor_first_name, d.doctor_last_name,
              d.address_line1, d.address_line2, d.city, d.state, d.zip, d.phone AS doctor_phone, d.email AS doctor_email,
              d.stripe_customer_id AS stripe_customer_id
       FROM orders o
       JOIN doctors d ON o.doctor_id = d.id
       WHERE o.id = ? AND o.rep_id = ?`,
      [id, repId]
    );

    if (orderInfo.length === 0) {
      return res.status(404).json({ error: 'Order not found or access denied.' });
    }

    const [items] = await pool.query(
      `SELECT oi.*, p.name AS product_name, p.images AS product_images
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
    console.error('Error fetching order details:', error);
    return res.status(500).json({ error: 'Failed to load order details.' });
  }
});

// POST Submit Return Request (Sales Rep)
router.post('/orders/:id/return', upload.single('file'), async (req, res) => {
  const repId = req.user.id;
  const { id } = req.params;
  const { reason, description } = req.body;

  if (!reason || !description) {
    return res.status(400).json({ error: 'Return reason and description are required.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'A proof of image is required for returns.' });
  }

  let proofUrl = '';
  try {
    // Upload memory buffer to Cloudinary
    const result = await uploadFromBuffer(req.file.buffer, 'Lipistry/returns');
    proofUrl = result.secure_url;
  } catch (cloudinaryError) {
    console.error('Cloudinary return proof upload failed:', cloudinaryError);
    return res.status(500).json({ error: `Cloudinary return proof upload failed: ${cloudinaryError.message}` });
  }

  try {
    // 1. Fetch order and verify it belongs to this rep
    const [ord] = await pool.query('SELECT * FROM orders WHERE id = ? AND rep_id = ?', [id, repId]);
    if (ord.length === 0) {
      return res.status(404).json({ error: 'Order not found or access denied.' });
    }

    const order = ord[0];

    // 2. Verify status is 'delivered'
    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Only delivered orders can be returned.' });
    }

    // 3. Verify return window is within 7 days
    const orderDate = order.delivered_at ? new Date(order.delivered_at) : new Date(order.created_at);
    const currentDate = new Date();
    const diffTime = Math.abs(currentDate - orderDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays > 7) {
      return res.status(400).json({ error: 'Return policy window of 7 days has expired for this order.' });
    }

    // 4. Update order to return_requested
    await pool.query(
      `UPDATE orders 
       SET status = 'return_requested', 
           return_reason = ?, 
           return_description = ?, 
           return_proof_image = ?, 
           return_requested_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reason, description, proofUrl, id]
    );

    return res.status(200).json({ message: 'Return request submitted successfully.', return_proof_image: proofUrl });
  } catch (error) {
    console.error('Error submitting return request:', error);
    return res.status(500).json({ error: 'Failed to submit return request.' });
  }
});

module.exports = router;
