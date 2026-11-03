# Daybook

A small journaling app I built because I wanted a nicer way to look back on my days.

You write a few lines about your day (50 to 500 words), pick a mood, and the app turns it into a little illustration. Every day you write adds a book to your shelf, and there's a streak counter to keep you honest.

## What you can do

- Sign up and log in (your journal is private to you)
- Write one entry a day and pick how the day felt
- Get an AI-made image based on your mood and the things you actually mentioned
- Highlight words in your entry with different colours
- Add up to 3 photos and drag them around the page, resize them however you like
- Customise your cover: colour, print and the picture on the front
- Browse past days on your bookshelf

## How it's built

- **Frontend:** plain HTML, CSS and JavaScript in one file
- **Backend:** Node.js and Express, hosted on Render
- **Database:** Postgres on Neon
- **AI:** Cloudflare Workers AI (Llama 3.1 for reading the entry, FLUX.1 schnell for the image)
- **Auth:** bcrypt for passwords, JWT for sessions

## Running it yourself

1. Clone the repo and run `npm install`
2. Copy `.env.example` to `.env` and fill in your own values:
   - `DATABASE_URL` (from Neon)
   - `JWT_SECRET` (any long random string)
   - `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
3. Start the server with `node server.js`. The tables get created automatically the first time.
4. Open `index.html` through a local server (not by double clicking it) and change `BACKEND_URL` near the top of the script to point at your backend.

## Things to know

- The free hosting goes to sleep when nobody's using it, so the first request can take up to a minute.
- You can only write one entry per day.


