const express = require('express');
const router = express.Router();
const stripe = require('../config/stripe');
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');

// Stripe Webhook Endpoint
// Note: This requires the RAW body buffer for signature verification
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (webhookSecret && sig) {
      // Production mode: verify signature using raw body
      event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, webhookSecret);
    } else {
      // Local development fallback: parse raw body if it is a Buffer, otherwise use body
      console.warn('⚠️ Stripe Webhook Secret or Signature missing. Skipping signature verification (Development Mode).');
      const payloadString = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
      event = typeof payloadString === 'string' ? JSON.parse(payloadString) : payloadString;
    }
  } catch (err) {
    console.error(`❌ Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const { type, data } = event;
  console.log(`✉️ Received Stripe Webhook Event: ${type}`);

  try {
    if (type === 'payment_intent.succeeded') {
      const paymentIntent = data.object;
      const intentId = paymentIntent.id;
      const chargeId = paymentIntent.latest_charge || null;
      const totalCents = paymentIntent.amount;
      const brand = paymentIntent.payment_method_details?.card?.brand || null;
      const last4 = paymentIntent.payment_method_details?.card?.last4 || null;

      // Find order by payment intent ID
      const [orders] = await pool.query('SELECT * FROM orders WHERE stripe_payment_intent_id = ?', [intentId]);
      if (orders.length > 0) {
        const order = orders[0];

        // 1. Update order status if it's draft or failed_payment
        if (order.status === 'draft' || order.status === 'failed_payment' || order.status === 'pending_payment') {
          await pool.query(
            "UPDATE orders SET status = 'submitted_warehouse', stripe_charge_id = ? WHERE id = ?",
            [chargeId, order.id]
          );
          console.log(`Order ${order.order_number} marked as paid & submitted to warehouse via Webhook.`);
        }

        // 2. Check if payment log already exists
        const [existingPayments] = await pool.query(
          'SELECT * FROM payments WHERE stripe_payment_intent_id = ? AND status = "succeeded"',
          [intentId]
        );

        if (existingPayments.length === 0) {
          // Log payment
          await pool.query(
            `INSERT INTO payments (id, order_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, currency, status, brand, last4, error_message)
             VALUES (?, ?, ?, ?, ?, 'usd', 'succeeded', ?, ?, NULL)`,
            [uuidv4(), order.id, intentId, chargeId, totalCents, brand, last4]
          );
          console.log(`Successful payment logged for order ${order.order_number} via Webhook.`);
        }
      } else {
        console.warn(`No order found matching Stripe Payment Intent ID: ${intentId}`);
      }

    } else if (type === 'payment_intent.payment_failed') {
      const paymentIntent = data.object;
      const intentId = paymentIntent.id;
      const totalCents = paymentIntent.amount;
      const errorMessage = paymentIntent.last_payment_error?.message || 'Payment failed';

      // Find order
      const [orders] = await pool.query('SELECT * FROM orders WHERE stripe_payment_intent_id = ?', [intentId]);
      if (orders.length > 0) {
        const order = orders[0];

        if (order.status !== 'failed_payment') {
          await pool.query("UPDATE orders SET status = 'failed_payment' WHERE id = ?", [order.id]);
          console.log(`Order ${order.order_number} marked as failed_payment via Webhook.`);
        }

        // Log the failure
        await pool.query(
          `INSERT INTO payments (id, order_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, currency, status, brand, last4, error_message)
           VALUES (?, ?, ?, NULL, ?, 'usd', 'failed', NULL, NULL, ?)`,
          [uuidv4(), order.id, intentId, totalCents, errorMessage]
        );
        console.log(`Failed payment logged for order ${order.order_number} via Webhook.`);
      }

    } else if (type === 'charge.refunded') {
      const charge = data.object;
      const chargeId = charge.id;
      const refundId = charge.refunds?.data[0]?.id || null;
      const totalCents = charge.amount_refunded || charge.amount;

      // Find order by charge ID
      const [orders] = await pool.query('SELECT * FROM orders WHERE stripe_charge_id = ?', [chargeId]);
      if (orders.length > 0) {
        const order = orders[0];

        if (order.status !== 'refunded') {
          await pool.query(
            "UPDATE orders SET status = 'refunded', return_processed_at = CURRENT_TIMESTAMP WHERE id = ?",
            [order.id]
          );
          console.log(`Order ${order.order_number} marked as refunded via Webhook.`);
        }

        // Check if payment log already exists
        const [existingRefunds] = await pool.query(
          'SELECT * FROM payments WHERE stripe_charge_id = ? AND status = "refunded"',
          [refundId]
        );

        if (existingRefunds.length === 0) {
          // Log refund
          await pool.query(
            `INSERT INTO payments (id, order_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, currency, status, brand, last4, error_message)
             VALUES (?, ?, ?, ?, ?, 'usd', 'refunded', NULL, NULL, NULL)`,
            [uuidv4(), order.id, order.stripe_payment_intent_id || null, refundId || chargeId, -totalCents]
          );
          console.log(`Refund logged for order ${order.order_number} via Webhook.`);
        }
      }
    }
  } catch (dbError) {
    console.error(`❌ Webhook Database Update Failed: ${dbError.message}`);
    return res.status(500).send(`Webhook DB Error: ${dbError.message}`);
  }

  res.json({ received: true });
});

module.exports = router;
