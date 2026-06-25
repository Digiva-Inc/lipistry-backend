const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('../config/cloudinary');

// Configure local file uploads directory
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

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
      "SELECT COUNT(*) AS order_count FROM orders WHERE rep_id = ?",
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
       WHERE o.rep_id = ?
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

// Place New wholesale Order
router.post('/orders', async (req, res) => {
  const repId = req.user.id;
  const { doctor_id, items, notes, payment_method } = req.body; // payment_method: 'card_on_file' or 'new_card'

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

    const doctor = docRows[0];

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

    // 3. Check card status
    if (payment_method === 'card_on_file' && !doctor.stripe_customer_id) {
      await connection.rollback();
      return res.status(400).json({ error: 'No credit card on file for this practice. Please add one first.' });
    }

    // 5. Stripe Payment Processing via SDK
    const stripe = require('../config/stripe');
    let stripeCustomerId = null;
    let paymentMethodId = null;
    let brand = null;
    let last4 = null;

    if (doctor.stripe_customer_id) {
      if (doctor.stripe_customer_id.startsWith('{')) {
        try {
          const parsed = JSON.parse(doctor.stripe_customer_id);
          stripeCustomerId = parsed.customerId;
          paymentMethodId = parsed.paymentMethodId || null;
          brand = parsed.brand || null;
          last4 = parsed.last4 || null;
        } catch (e) {
          stripeCustomerId = doctor.stripe_customer_id;
        }
      } else {
        stripeCustomerId = doctor.stripe_customer_id;
      }
    }

    let chargeId = null;
    let intentId = null;
    let stripeError = null;

    try {
      let pmId = paymentMethodId;
      if (!pmId && stripeCustomerId) {
        try {
          const paymentMethods = await stripe.paymentMethods.list({
            customer: stripeCustomerId,
            type: 'card',
          });
          if (paymentMethods.data.length > 0) {
            pmId = paymentMethods.data[0].id;
          }
        } catch (err) {
          console.warn('Could not list Stripe payment methods:', err);
        }
      }

      if (!pmId) {
        // Map mock card brand to test token
        const lowerBrand = (brand || '').toLowerCase();
        if (lowerBrand.includes('visa')) {
          pmId = 'pm_card_visa';
        } else if (lowerBrand.includes('mastercard') || lowerBrand.includes('master')) {
          pmId = 'pm_card_mastercard';
        } else if (lowerBrand.includes('amex') || lowerBrand.includes('american')) {
          pmId = 'pm_card_amex';
        } else if (lowerBrand.includes('discover')) {
          pmId = 'pm_card_discover';
        } else if (lowerBrand.includes('jcb')) {
          pmId = 'pm_card_jcb';
        } else if (lowerBrand.includes('diners')) {
          pmId = 'pm_card_diners';
        } else if (lowerBrand.includes('unionpay') || lowerBrand.includes('union')) {
          pmId = 'pm_card_unionpay';
        } else {
          pmId = 'pm_card_visa'; // Fallback test token
        }
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: totalCents,
        currency: 'usd',
        customer: stripeCustomerId || undefined,
        payment_method: pmId,
        confirm: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never'
        }
      });

      intentId = paymentIntent.id;
      chargeId = paymentIntent.latest_charge || `ch_${uuidv4().replace(/-/g, '').substring(0, 14)}`;
    } catch (err) {
      stripeError = err;
    }

    if (stripeError) {
      // Rollback transaction to release product stock locks
      await connection.rollback();
      connection.release();
      connection = null;

      // Start a separate query to insert failed order and payment log
      try {
        await pool.query(
          `INSERT INTO orders (id, order_number, rep_id, doctor_id, status, stripe_payment_intent_id, stripe_charge_id, subtotal_cents, total_cents, notes)
           VALUES (?, ?, ?, ?, 'failed_payment', ?, NULL, ?, ?, ?)`,
          [
            orderId,
            orderNumber,
            repId,
            doctor_id,
            stripeError.payment_intent ? stripeError.payment_intent.id : null,
            subtotalCents,
            totalCents,
            notes || null
          ]
        );

        for (const d of itemsDetails) {
          await pool.query(
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

        await pool.query(
          `INSERT INTO payments (id, order_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, currency, status, brand, last4, error_message)
           VALUES (?, ?, ?, NULL, ?, 'usd', 'failed', ?, ?, ?)`,
          [
            uuidv4(),
            orderId,
            stripeError.payment_intent ? stripeError.payment_intent.id : null,
            totalCents,
            brand,
            last4,
            stripeError.message || 'Payment failed'
          ]
        );
      } catch (logErr) {
        console.error('Failed to log failed order/payment to database:', logErr);
      }

      console.error('Stripe charge failed:', stripeError);
      return res.status(402).json({ error: `Payment failed: ${stripeError.message}` });
    }

    // 6. Deduct local stock & insert inventory transaction audit logs
    for (const d of itemsDetails) {
      await connection.query(
        "UPDATE products SET stock_cases = stock_cases - ? WHERE id = ?",
        [d.quantity, d.product_id]
      );

      await connection.query(
        `INSERT INTO inventory_transactions (product_id, quantity_change, transaction_type, reference_id, notes)
         VALUES (?, ?, 'order_fulfillment', ?, ?)`,
        [d.product_id, -d.quantity, orderId, `Cases subtracted for order ${orderNumber}`]
      );
    }

    // 7. Insert Order (Sets status immediately to submitted_warehouse on checkout payment success)
    await connection.query(
      `INSERT INTO orders (id, order_number, rep_id, doctor_id, status, stripe_payment_intent_id, stripe_charge_id, subtotal_cents, total_cents, notes)
       VALUES (?, ?, ?, ?, 'submitted_warehouse', ?, ?, ?, ?, ?)`,
      [
        orderId,
        orderNumber,
        repId,
        doctor_id,
        intentId,
        chargeId,
        subtotalCents,
        totalCents,
        notes || null
      ]
    );

    // 8. Insert Order Items
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

    // 9. Log successful payment in payments table
    await connection.query(
      `INSERT INTO payments (id, order_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, currency, status, brand, last4, error_message)
       VALUES (?, ?, ?, ?, ?, 'usd', 'succeeded', ?, ?, NULL)`,
      [
        uuidv4(),
        orderId,
        intentId,
        chargeId,
        totalCents,
        brand,
        last4
      ]
    );

    await connection.commit();
    return res.status(201).json({
      message: 'Wholesale order successfully created, paid via Stripe, and submitted to warehouse for fulfillment.',
      order_id: orderId,
      order_number: orderNumber
    });

  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Error placing rep order:', error);
    return res.status(500).json({ error: 'Failed to place wholesale order.' });
  } finally {
    if (connection) {
      connection.release();
    }
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
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    return res.status(400).json({ error: 'Return reason and description are required.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'A proof of image is required for returns.' });
  }

  let proofUrl = '';
  try {
    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'Lipistry/returns'
    });
    proofUrl = result.secure_url;
    
    // Delete temporary local file
    try {
      fs.unlinkSync(req.file.path);
    } catch (err) {
      console.error('Failed to delete temp file:', err);
    }
  } catch (cloudinaryError) {
    console.error('Cloudinary return proof upload failed:', cloudinaryError);
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
    }
    return res.status(500).json({ error: `Failed to upload return proof image: ${cloudinaryError.message}` });
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
