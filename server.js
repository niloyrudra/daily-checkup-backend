require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const twilio = require('twilio');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Firebase Initialization
const serviceAccount = require('./config/firebase-service-account.json');
initializeApp({ credential: cert(serviceAccount) });
// Initiate DB
const db = getFirestore();

// Twilio Initialization
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Server Initiate
const app = express();
// MiddleWares
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const otpStore = new Map(); // Temporary in-memory storage

app.get("/", (req, res) => {
    res.send(`
        <div style="display:flex;flex-direction:column;justify-conent:flex-start;align-items:center;">
            <h1>Welcome to Daily Checkup APP.</h1>
            <p>Stripe Secret Key: ${process.env.STRIPE_SECRET_KEY}</p>
            <p>Stripe Free Price ID: ${process.env.STRIPE_FREE_PRICE_ID}</p>
            <p>Stripe Monthly Price ID: ${process.env.STRIPE_MONTHLY_PRICE_ID}</p>
            <p>Stripe Yearly Price ID: ${process.env.STRIPE_YEARLY_PRICE_ID}</p>
        </div>
    `);
})

// Stripe Checkout
app.post("/api/create-checkout-session", (req, res) => {
  const { plan, quantity = 1 } = req.body;

  const priceMap = {
    free: process.env.STRIPE_FREE_PRICE_ID,
    monthly: process.env.STRIPE_MONTHLY_PRICE_ID,
    yearly: process.env.STRIPE_YEARLY_PRICE_ID,
  };

  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ success: false, message: "Invalid plan" });

  stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price: priceId,
      quantity: quantity,
    }],
    mode: 'subscription',
    success_url: 'https://daily-checkup.niloyrudra.com/success',
    cancel_url: 'https://daily-checkup.niloyrudra.com/cancel',
  })
    .then(session => res.json({ success: true, url: session.url }))
    .catch(err => {
      console.error("❌ Stripe error:", err.message);
      res.status(500).json({ success: false, message: "Checkout failed", error: err });
    });
});

// Stripe Redirect Endpoints
app.get("/success", (req, res) => {
  res.sendFile(__dirname + "/public/success.html");
});

app.get("/cancel", (req, res) => {
  res.sendFile(__dirname + "/public/cancel.html");
});

// Send OTP **************************************************************
app.post("/api/send-otp", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ message: 'Phone is required' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(phone, otp);

    if (!twilioClient) return res.status(400).json({ message: 'Twilio Client is missing.' });

    try{
        twilioClient.messages.create({
            body: `Your verification code is: ${otp}`,
            from: process.env.TWILIO_PHONE_NUMBER,
            to: phone,
          })
            .then(() => res.json({ success: true }))
            .catch(err => {
              console.error(err);
              res.status(500).json({ success: false, message: 'OTP send failed after process', error: err });
            });
    }
    catch( err ) {
        res.status(500).json({ success: false, message: 'OTP send failed dring process', error: err });
    }

});

// Verify OTP **********************************************************
app.post("/api/verify-otp", (req, res) => {
  const { phone, otp } = req.body;
  if (otpStore.get(phone) === otp) {
    otpStore.delete(phone);
    res.json({ success: true });
  } else {
    res.status(422).json({ success: false, message: 'Invalid OTP' });
  }
});


// Emergency check cron (every minute)
cron.schedule("* * * * *", () => {
  console.log("⏰ Running emergency check...");
  const now = new Date();

  db.collection('users').get()
    .then(snapshot => {
      snapshot.forEach(doc => {
        const user = doc.data();
        const { phoneNumber, schedules, contactNumbers, state = {} } = user;
        const uid = doc.id;

        if (!phoneNumber || !schedules) return;

        const scheduledHour = parseInt(schedules.hour);
        const scheduledMinute = parseInt(schedules.minute);

        if (
          now.getHours() === scheduledHour &&
          now.getMinutes() === scheduledMinute &&
          !state.lastMessageSent
        ) {
          sendMessage(uid, phoneNumber, "Hi! This is your Daily Checkup. Please reply 'OK'.")
            .then(() => {
              return db.collection('users').doc(uid).update({
                state: {
                  lastMessageSent: now.toISOString(),
                  attempts: 1,
                  callScheduled: false,
                  emergencyCalled: false
                }
              });
            });
        } else if (state.lastMessageSent && !state.callScheduled) {
          const lastSent = new Date(state.lastMessageSent);
          const diffMinutes = Math.floor((now - lastSent) / 60000);

          if (diffMinutes >= 15 && state.attempts < 3) {
            sendMessage(uid, phoneNumber, `Reminder ${state.attempts + 1}: Please reply 'OK'.`)
              .then(() => {
                return db.collection('users').doc(uid).update({
                  "state.attempts": state.attempts + 1
                });
              });
          }

          if (diffMinutes >= 60 && state.attempts >= 3) {
            makeCall(phoneNumber).then(() => {
              db.collection('users').doc(uid).update({
                "state.callScheduled": true,
                "state.callTime": now.toISOString()
              });
            });
          }
        } else if (state.callScheduled && !state.emergencyCalled) {
          const callTime = new Date(state.callTime);
          const diffMinutes = Math.floor((now - callTime) / 60000);
          if (diffMinutes >= 60) {
            const calls = (contactNumbers || []).map(contact =>
              makeCall(contact.phoneNumber)
            );
            Promise.all(calls).then(() => {
              db.collection('users').doc(uid).update({
                "state.emergencyCalled": true
              });
            });
          }
        }
      });
    })
    .catch(err => console.error("❌ Firebase read error:", err.message));
});

function sendMessage(uid, to, body) {
  return twilioClient.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  })
    .then(() => console.log(`✅ Message sent to ${to}`))
    .catch(err => console.error(`❌ Failed to send SMS to ${to}`, err.message));
}

function makeCall(to) {
  return twilioClient.calls.create({
    twiml: '<Response><Say>This is a Daily Checkup emergency alert. Please respond immediately.</Say></Response>',
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  })
    .then(() => console.log(`📞 Call placed to ${to}`))
    .catch(err => console.error(`❌ Failed to call ${to}`, err.message));
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
