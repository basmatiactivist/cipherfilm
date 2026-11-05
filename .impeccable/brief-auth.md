# Surface brief: signed-out and account flows (Operate)

Scope: first-admin setup, invite acceptance with recovery-key screen, login, account recovery, password change, then the signed-in shell (gallery, albums, trash, admin) inheriting the same world. Visitor mode: Operate.

## Job and audience
Family and friends (mixed tech comfort, phone and desktop equally) doing a one-time or rare task that must not go wrong: create an account, save a recovery key, sign in, recover. The admin does setup and invites. Success: nobody loses data through a misunderstood screen; sign-in and unlock are quick.

## Outcome and proof
Primary actions: create account, sign in, save the recovery key, reset the password with it. Truth the UI must carry: the server cannot see photos; lose password plus recovery key and the data is gone. No real data, testimonials or brand assets exist; none are invented.

## Direction contract

THESIS: A sealed-letter system: the airmail envelope's blue and red, chevron-edge band and plain post-office clarity. The one idea: "sealed" is a visible, consistent state. Refuses the generic lock-icon-on-dark-blue "secure app" look and the cream/serif family-album look.

OWN-WORLD: White ground, deep airmail blue (shell header, primary buttons, links), signal red reserved for irreversible or destructive actions and the single active step, ink-dark text, light blue-grey rules. System sans stack only (no web fonts; CSP forbids). The red/blue chevron band is a thin edge motif. Square-ish 6 px corners, 1 px rules, no shadows except focus rings. Recognisable with content removed by the blue header plus chevron edge on sealed objects.

STORY: A visitor understands their library is sealed to them, knows exactly what to save (the recovery key) and why, and gets in with as little friction as the cryptography allows.

FIRST VIEWPORT: Login. Centered 420 px card on white under a blue header bar (wordmark "Cipherfilm" left). Card: e-mail, password, "Sign in" primary blue; below, "Forgot password? Use your recovery key". Chevron band runs along the card's top edge. Phone: card fills the width, header stays, fields 48 px tall. Standard form controls only.

FORM: Standard web forms, tabs and a top-bar nav; world lends palette, type tone, density and the chevron-edge move. Position 4 of the grounded list (airmail); seed: seed:4476a99dcec49c93

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Flows (intent, not CSS)
- Setup: token field, e-mail, password (strength hint, min 10 chars), then recovery key screen.
- Invite: shows the invited e-mail (fixed), sets password, then recovery key screen.
- Recovery key screen (chevron-banded card): 24 numbered words in a 3x8 / 2x12 grid; Copy, Download .txt, Print; plain warning that losing both password and key means losing everything; "I've saved it" checkbox gates Continue.
- Login: e-mail, password, "unlocking... (about 1-2 s)" progress while Argon2 runs; wrong credentials give one generic message.
- Recovery: e-mail + 24 words (paste-friendly, per-word validation), then new password, then a new recovery key screen.
- After reload with live session: "Unlock" screen asking only for the password.
- Admin: users table (status, disable/enable, delete with confirm), invite form producing a copyable link with expiry.

## States and ranges
Loading (Argon2 running), wrong password, rate-limited (429), expired/used invite, checksum/typo in recovery words, network failure, insecure context (not https). Names/emails up to 254 chars; truncate with ellipsis.

## Constraints and open decisions
No inline scripts or styles, no external fonts or CDNs, system fonts only. WCAG 2.2 AA, keyboard operable, 44 px touch targets. Open: exact blue/red values and the chevron geometry are chosen at build and recorded in DESIGN.md at finish.
