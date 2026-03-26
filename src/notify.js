const WEBHOOK = process.env.BRRR_WEBHOOK;
const API = 'https://api.brrr.now/v1/';

export async function notify(title, message, sound = 'default') {
  if (!WEBHOOK) return;
  try {
    await fetch(API + WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message, sound }),
    });
  } catch {} // never crash the bot over a notification
}
