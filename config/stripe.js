const Stripe = require('stripe');
require('dotenv').config();

let stripeInstance = null;
const isStripeConfigured = !!process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'your_stripe_secret_key_here';

if (isStripeConfigured) {
  try {
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16', // Standard stable version
    });
    console.log('Stripe SDK initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize Stripe SDK:', err);
  }
}

// Custom mock wrapper for development and test scenarios
const mockStripe = {
  customers: {
    create: async (params) => {
      console.log('[MOCK STRIPE] Creating Customer:', params);
      return {
        id: `cus_${Math.random().toString(36).substring(2, 16)}`,
        email: params.email,
        name: params.name,
      };
    }
  },
  paymentMethods: {
    attach: async (pmId, params) => {
      console.log(`[MOCK STRIPE] Attaching PaymentMethod ${pmId} to Customer ${params.customer}`);
      return {
        id: pmId,
        customer: params.customer,
      };
    },
    retrieve: async (pmId) => {
      console.log(`[MOCK STRIPE] Retrieving PaymentMethod ${pmId}`);
      return {
        id: pmId,
        card: {
          brand: 'Visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2030,
        }
      };
    }
  },
  paymentIntents: {
    create: async (params) => {
      console.log('[MOCK STRIPE] Creating PaymentIntent:', params);
      const isFailed = params.payment_method === 'pm_card_chargeDeclined' || params.payment_method === 'pm_card_chargeDeclinedInsufficientFunds';
      if (isFailed) {
        throw new Error('Your card was declined. Insufficient funds.');
      }
      return {
        id: `pi_${Math.random().toString(36).substring(2, 16)}`,
        status: 'succeeded',
        latest_charge: `ch_${Math.random().toString(36).substring(2, 16)}`,
        amount: params.amount,
        currency: params.currency,
      };
    }
  },
  refunds: {
    create: async (params) => {
      console.log('[MOCK STRIPE] Creating Refund:', params);
      return {
        id: `re_${Math.random().toString(36).substring(2, 16)}`,
        status: 'succeeded',
        amount: params.amount,
      };
    }
  }
};

module.exports = isStripeConfigured ? stripeInstance : mockStripe;
