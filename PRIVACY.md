# Azkar Guard reminders: privacy policy

*Last updated: 2026-10-05*

This service sends the Azkar Guard web app's reminder notifications. It is only used if you turn reminders on in the app, and it has no accounts, analytics or ads.

## What is stored

When you turn reminders on, the app sends and this service stores:

- **Your browser's push subscription:** the push service address your browser gave the app, and the keys used to encrypt messages to it. It identifies your browser to its push service (Google, Mozilla, Apple or Microsoft), not to us.
- **Your interface language** (English or Arabic), for the notification text.
- **The start and end times of your next morning and evening windows**, for about the next week.
- **Which of those windows you completed**, so reminders stop.
- **When the last reminder was sent.**

**Not stored:** your location, your name, your email, or any account. Your prayer times are calculated on your device, and only the resulting times are sent. Those times could hint at your general region, but not your location.

## Where it is stored

In a Cloudflare D1 database, on Cloudflare's network. Requests pass through Cloudflare, which may keep standard request logs.

## What is sent to others

Each reminder is encrypted end to end to your browser and sent to your browser's push service, which delivers it. The push service can't read it.

## How it is removed

- Turning reminders off in the app deletes your record.
- If your browser drops the subscription (for example, you uninstall the app or clear site data), the push service tells us the next time we try to send, and the record is deleted.

## Contact

Open an issue in the project's GitHub repository.
