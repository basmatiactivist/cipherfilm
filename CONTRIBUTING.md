# Contributing

Issues and pull requests are welcome. Please keep changes small and focused.

## Run the tests

```bash
make test         # Go server tests, web type-check, build and unit tests, offline decrypt tool tests (needs Docker)
make e2e          # full browser suite in a throwaway Docker stack, then the plaintext leak check (see e2e/README.md)
```

CI runs all of these on every push and pull request, including the browser suite.

## Ground rules

- **No custom cryptography.** Only libsodium primitives, composed as described in [docs/CRYPTO.md](docs/CRYPTO.md). Changes to the
  format need a version byte and a migration story, and the offline tool in `tools/decrypt` must keep reading the format.
- **Plaintext never leaves the browser.** Do not log names, keys or metadata on the server.
- **Security-relevant changes come with a regression test** and an update to [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) if a claim changes.
- Keep the strict Content-Security-Policy: no inline scripts, no third-party origins.
- Follow [DESIGN.md](DESIGN.md) for visual changes.
- Never commit credentials. Test passwords are generated at run time (`e2e/creds.ts`).
- Commit under your GitHub noreply address if you don't want your e-mail public: a pushed address can't be
  removed again. `git config core.hooksPath .githooks` makes git refuse commits and pushes that carry a real
  address (`scripts/check-identity.sh`); CI checks every commit and tag that lands in this repository.

By contributing you agree that your contribution is licensed under the AGPL-3.0, like the rest of the project.
