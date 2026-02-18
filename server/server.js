// server.js
import express from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import admin from 'firebase-admin'; // optional, only if you want to log donations to Firestore
import fs from 'fs';
import crypto from 'crypto';

dotenv.config();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

const app = express();

// Stripe requires the raw body for webhook signature verification.
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // You can save session details to your DB here.
    // Example: save into Firestore (admin SDK)
    if (process.env.FIRESTORE_SERVICE_ACCOUNT_JSON) {
      try {
        if (!admin.apps.length) {
          admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(process.env.FIRESTORE_SERVICE_ACCOUNT_JSON))
          });
        }
        const db = admin.firestore();
        await db.collection('donations').add({
          amount: session.amount_total,
          currency: session.currency,
          checkoutSessionId: session.id,
          paymentStatus: session.payment_status,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {
        console.error('Failed to log donation to Firestore', e);
      }
    }
  }

  res.json({ received: true });
});

// For creating checkout sessions - expect a JSON body
app.use(express.json());

function anonymizeIp(ip) {
  if (!ip) return null;
  if (ip.includes('.')) {
    return ip.split('.').slice(0,3).concat('0').join('.');
  } else if (ip.includes(':')) {
    const p = ip.split(':');
    return p.slice(0,4).join(':') + '::';
  }
  return ip;
}

app.post('/create-checkout-session', async (req, res) => {
  const { amount } = req.body;
  // allow only these amounts (in cents)
  const allowed = [1000,2000,3000,5000,10000];
  if (!allowed.includes(amount)) return res.status(400).json({ error: 'Invalid amount' });

  // Get client IP (behind proxy you may need x-forwarded-for)
  const forwarded = req.headers['x-forwarded-for'];
  const clientIp = forwarded ? forwarded.split(',')[0].trim() : req.ip;
  const anonymizedIp = anonymizeIp(clientIp);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Donation — Hungry Hungry Man' },
          unit_amount: amount
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${process.env.SUCCESS_URL || 'http://localhost:5173'}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CANCEL_URL || 'http://localhost:5173'}/donate-cancel`
    });

    // Optionally store attempt in Firestore (admin)
    if (process.env.FIRESTORE_SERVICE_ACCOUNT_JSON) {
      try {
        if (!admin.apps.length) {
          admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(process.env.FIRESTORE_SERVICE_ACCOUNT_JSON))
          });
        }
        const db = admin.firestore();
        await db.collection('donations_attempts').add({
          checkoutSessionId: session.id,
          amount,
          ip: anonymizedIp,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {
        console.error('Failed to log attempt:', e);
      }
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error', err);
    res.status(500).json({ error: 'stripe_error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
