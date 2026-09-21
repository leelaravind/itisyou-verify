#!/usr/bin/env node
/**
 * Read every owner screen with the owner's OWN signed-in session and report what each one
 * says, so the walkthrough costs the owner one paste rather than ten minutes of clicking.
 *
 * ## What this is not
 *
 * It does not sign anybody in. It cannot: there is no path here that mints a session, asks
 * for a code, or touches the sessions table. It takes a cookie the owner already holds,
 * because they signed in themselves in their own browser, and uses it to GET pages.
 *
 * Nothing is written. Every request is a GET, and any non-GET in this file would be a bug.
 *
 * ## Getting the cookie without pasting a credential into a chat
 *
 * In the browser where you are signed in, open the console on verify.itisyou.app and run:
 *
 *     copy(document.cookie.split('; ').find(c => c.startsWith('__Host-verify_session=')))
 *
 * then save it to a file and point this script at the file:
 *
 *     node scripts/owner-panel-walkthrough.mjs --cookie-file ./session.txt
 *
 * The file is read, never printed. The cookie never appears in the output, and the script
 * refuses to run if it would.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const fileIndex = args.indexOf('--cookie-file');
const base = args.includes('--base') ? (args[args.indexOf('--base') + 1] ?? '') : 'https://verify.itisyou.app';

if (fileIndex === -1) {
  console.error('usage: node scripts/owner-panel-walkthrough.mjs --cookie-file <path> [--base <url>]');
  console.error('The file holds one line: __Host-verify_session=<value>, copied from your own browser.');
  process.exit(2);
}

const cookie = readFileSync(args[fileIndex + 1] ?? '', 'utf8').trim();
if (!cookie.includes('verify_session=')) {
  console.error('That file does not look like a session cookie. Nothing was sent.');
  process.exit(2);
}

/** Every owner screen that answers a GET, in the order the rail lists them. */
const SCREENS = [
  ['Overview', '/owner'],
  ['Customers', '/owner/customers'],
  ['Verification', '/owner/verification'],
  ['Connections', '/owner/connections'],
  ['Ads', '/owner/ads'],
  ['Operations', '/owner/operations'],
  ['Controls', '/owner/controls'],
  ['Approvals', '/owner/approvals'],
  ['Tests', '/owner/quality'],
  ['Cleanup', '/owner/cleanup'],
  ['Settings', '/owner/settings'],
];

const visible = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Redact anything that looks like a credential before a single byte is printed. */
function safe(text) {
  return text
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, (address) => `${address.slice(0, 2)}**@${address.split('@')[1]}`);
}

console.log(`=== owner panel, read with a session the owner created ===\n${base}\n`);

let refused = 0;
for (const [label, path] of SCREENS) {
  const response = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
  if (response.status !== 200) {
    refused += 1;
    console.log(`${String(response.status).padEnd(4)} ${label.padEnd(14)} ${path}`);
    continue;
  }
  const text = visible(await response.text());
  // The heading, and the first sentence after it, is what the screen is actually saying.
  const heading = /(?:Overview|Customers|Verification|Connections|Ads|Operations|Controls|Approvals|Tests|Cleanup|Settings)\s+([A-Z][^.]{0,90}\.)/.exec(
    text,
  );
  console.log(`200  ${label.padEnd(14)} ${path}`);
  console.log(`     ${safe(heading?.[1] ?? text.slice(0, 90))}`);

  // Anything the owner should act on, surfaced rather than buried.
  for (const marker of [
    ['placeholder figures', 'These figures are placeholders'],
    ['unknown figures', 'Some figures are not known yet'],
    ['nothing listening', 'Nothing is listening'],
    ['not checked', 'Not checked'],
    ['waiting for you', 'Waiting for you'],
    ['support waiting', 'Nobody is alerted'],
  ]) {
    if (text.includes(marker[1])) console.log(`     · ${marker[0]}`);
  }
}

console.log(
  `\n${refused === 0 ? 'Every owner screen answered 200.' : `${refused} screen(s) did not answer 200 — if they are 404, the session is not a platform-owner session.`}`,
);
console.log('Nothing was written. Every request above was a GET.');
