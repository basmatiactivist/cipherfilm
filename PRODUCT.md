# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (plus a native Android app and a native Mac app that share its design tokens; DESIGN.md)

## Stack

Decided in PLAN.md: Go + SQLite server, Preact + TypeScript + Vite client, libsodium (WASM), plain CSS, self-hosted assets only (strict CSP, no CDNs or external fonts). Android: Expo / React Native with a Kotlin module (`mobile/`). Mac: Swift and SwiftUI (`mac/`).

## Users

The admin (the owner, technical) plus a small circle of family members and friends the admin invites. Mixed tech comfort. Used about equally on phones and on desktop. Each person has a fully private library; there is no sharing between users in v1.

## Product Purpose

A small self-hosted photo and video gallery with end-to-end encryption: everything is encrypted in the browser before upload and the server stores only ciphertext. Success: people can keep, browse and download their originals privately, without the server operator or admin being able to see anything.

## Positioning

Private by construction rather than by policy: the server never holds a key that can decrypt, not even for the admin. The cost is honest and visible: lose both password and recovery key and the data is gone.

## Operating Context

Reachable over Tailscale (no public ports), behind the operator's own reverse proxy, or on a public domain with Caddy (docs/INSTALL.md). Invite-only: the admin creates an invite link and hands it over manually. No email is ever sent. Originals (JPEG, PNG, WebP, HEIC, MP4/MOV) are stored unchanged. About 100 GB expected. UI language: English.

## Capabilities and Constraints

Setup and auth flows: one-time first-admin setup (token printed in container logs), invite acceptance, login, recovery with the recovery key, password change. Recovery key is shown once with copy, download and print and an "I've saved it" confirmation. Built since: chunked upload, timeline by capture date, albums, favorites, lightbox, video, ZIP download, trash (30 days), admin user management, devices, on-device search and people (computed by the Android and Mac apps), account self-deletion.
Constraints: crypto APIs need a secure context; no inline scripts or third-party origins; no custom crypto; the UI must say plainly that lost password plus lost recovery key means lost data.

## Brand Commitments

Name: "Cipherfilm". Voice: calm and plain; friendly and direct, no jargon, serious and blunt only where data loss is possible.

## Evidence on Hand

The app icon and logo (design/icon/). No real photos or testimonials. Do not fabricate any.

## Product Principles

1. Honesty over reassurance: say plainly what is and is not protected, and what cannot be recovered.
2. Plain language first; technical detail is available but never required.
3. The photos are the interface: chrome stays out of the way once someone is signed in.
4. Fail loudly and safely: tampered or undecryptable items are never displayed, and the user is told why in plain words.
5. Equal care for phone and desktop.

## Accessibility & Inclusion

No product-specific standard established; default to WCAG 2.2 AA, keyboard-operable flows, and large touch targets for phone users.
