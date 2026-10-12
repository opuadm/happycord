# Captcha work and automated browsers

[signup.md](signup.md) describes the Cap widget, the signup form and the token rules. This page covers how much work a solve costs, how each place that shows a captcha gets its own settings, and how the server refuses solves from automated browsers.

## Challenge work per place

Cap core sends the browser a set of SHA-256 proof-of-work challenges. `count` is how many challenges one solve has, `size` is the length of each salt and `difficulty` is how many leading hex digits each hash has to match. One challenge at difficulty 5 needs about 16^5, or roughly a million, hashes on average, and the work grows sixteenfold per step of difficulty.

Each place that asks for a captcha has its own challenge settings under `security.captcha.challenges`:

| Place          | Key                                         | Default                              | Challenge endpoint                 |
| -------------- | ------------------------------------------- | ------------------------------------ | ---------------------------------- |
| Registration   | `security.captcha.challenges.register`      | 64 challenges, size 32, difficulty 5 | `/api/v9/auth/cap/`                |
| Sign-in        | `security.captcha.challenges.login`         | 16 challenges, size 32, difficulty 5 | `/api/v9/auth/cap/login/`          |
| Password reset | `security.captcha.challenges.passwordReset` | 16 challenges, size 32, difficulty 5 | `/api/v9/auth/cap/password_reset/` |

The server clamps `count` to 1 through 500, `size` to 16 through 64 and `difficulty` to 1 through 8, and it uses the default for a value that is not a whole number. Site settings in the admin dashboard has the same 3 fields for each place under Captcha. The settings apply to Cap core. A Cap Standalone server sets its own difficulty.

`GET /api/v9/auth/captcha` returns the endpoint for each place in `endpoints`, and `assets/client_patches/55-simple-signup.js` solves against the endpoint for the flow it is in. Sign-in and password reset only show a captcha when `security.captcha.enabled` is on together with `login.requireCaptcha` or `passwordReset.requireCaptcha`. Every place signs its challenges with its own scope, so a proof solved for sign-in can't be redeemed at the registration endpoint. A solved registration token is accepted for sign-in and password reset too, because registration costs more.

The registration default was raised from 50 challenges at difficulty 4 to 64 at difficulty 5, which is about 20 times the work. Measured on an Apple M3 MacBook in Brave, headful, with Cap's 4 solver workers:

| Load on the machine      | Registration solve time, 3 to 6 runs |
| ------------------------ | ------------------------------------ |
| Normal desktop use       | 3.3 to 6.1 seconds                   |
| Load average 27, 8 cores | 8.8 to 10.7 seconds                  |

A phone or an older laptop takes longer. Lower `difficulty` to 4 for a sixteenth of the work if your members sign up from slow devices.

## Refusing automated browsers

`security.captcha.blockAutomatedBrowsers` is on by default. While it is on, every Cap core challenge carries Cap's browser instrumentation, and the server adds its own checks to the same script. The script runs in a sandboxed iframe while the browser solves and its result travels back inside the solve, bound to the server-issued challenge token. The server judges the result when the solve is redeemed and refuses the solve with reason `automated_browser`. It logs `[Cap] refused an automated browser for <place>: <reasons>`.

Cap core itself refuses `navigator.webdriver`, a `HeadlessChrome` user agent and a few other headless markers. `src/api/util/utility/automationSignals.ts` adds these checks:

| Reason                  | Kind   | What the browser reported                                                               |
| ----------------------- | ------ | --------------------------------------------------------------------------------------- |
| `webdriver`             | strong | `navigator.webdriver` is true                                                           |
| `headless_user_agent`   | strong | `HeadlessChrome` in the user agent or the client hint brands                            |
| `zero_window`           | strong | an outer window size of 0 by 0                                                          |
| `software_renderer`     | weak   | WebGL renders with SwiftShader, llvmpipe or another software renderer                   |
| `no_plugins`            | weak   | a desktop Chromium browser with no plugins and no MIME types                            |
| `missing_chrome_object` | weak   | a desktop Chromium browser without `window.chrome`                                      |
| `notification_mismatch` | weak   | `Notification.permission` is `denied` while the permissions API says `prompt`           |
| `signals_missing`       | strong | the solve carries no result from the added checks                                       |

One strong reason refuses the solve, and weak reasons refuse it from 2 together. A virtual machine without a GPU can show a software renderer, so a single weak reason is never enough. Firefox, Safari and phones skip the Chromium-only checks. `signals_missing` means a client can't strip the added checks out of the result to get through.

These checks stop cheap bots, meaning headless Chromium driven by Playwright, Puppeteer or Selenium with their default settings. Measured against this server, headless Brave under Playwright was refused, and so was headful Brave launched by Playwright with its automation flags. Headful Brave launched without the automation flags passed, which is the same browser a person uses. Someone who runs a real browser, patches the reported values or pays a captcha solving service gets through. The proof of work still costs them seconds of CPU per account, and the registration rate limits still apply. Treat the checks as a filter for low-effort signups, not as bot detection.

The admin dashboard shows the switch as Block automated browsers under Captcha. Turning it off keeps Cap's instrumentation running without refusing anything.

## Development

The dev scripts solve captchas in headless Brave, so `scripts/dev/worktree-setup.sh` writes `"security": { "captcha": { "blockAutomatedBrowsers": false } }` into the worktree's `config.json`. That is the only place it is turned off, and the production defaults never skip the check. To test the refusal on a dev instance, turn the switch on in Site settings and run `scripts/dev/cap-token.mjs` or a probe. The registration fails with `Instrumentation blocked (automated_browser)`.

`scripts/tests/cap-automation-signals.test.cjs` covers the verdicts, the wrapped script and the token check. `scripts/tests/cap-contexts.test.cjs` covers the settings for each place, the scopes and refusing or accepting a solve with the switch on and off.
