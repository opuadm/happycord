import bcrypt from "bcrypt";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import crypto from "node:crypto";
import { ILike, IsNull, MoreThan } from "typeorm";
import {
    assertIpNotBanned,
    assertRegistrationAllowedForIp,
    assertRegistrationIpCap,
    captchaKeyFrom,
    checkRegistrationCaptcha,
    claimInvite,
    findUsableInvite,
    instanceAutomodMatch,
    normalizeIp,
    onGuildMemberJoin,
    recordAutomodAction,
    recordInvitedUser,
    recordRegistrationForIp,
    registrationCapEndpoint,
    releaseInvite,
} from "@spacebar/api/util";
import { assertIdentityNameAllowed } from "@spacebar/util/util/IdentityModeration";
import { isPrideBadgeSelection } from "@spacebar/api/util/utility/prideBadgeSelection";
import { assessSignup, logSignupAssessment, signupPasswordKey } from "@spacebar/api/util/utility/signupGuard";
import { route } from "@spacebar/api/middlewares";
import { Invite, User, ValidRegistrationToken } from "@spacebar/database";
import { Config, FieldErrors, generateToken, IpDataClient, AbuseIpDbClient } from "@spacebar/util";
import { RegisterSchema } from "@spacebar/schemas";
import { BcryptWorkerPool } from "@spacebar/util/util/workers/bcrypt/BcryptWorkerPool";
import { Stopwatch, TimeSpan, trimSpecial } from "@spacebar/extensions";

const router: Router = Router({ mergeParams: true });

const inviteError = (code: string, message: string) => FieldErrors({ username: { code, message }, instance_invite: { code, message } });

const recentlyBlockedIps: {
    [ip: string]: {
        firstHit: Date;
        lastHit: Date;
        hits: number;
        reason: string;
    };
} = {};

router.post(
    "/",
    route({
        requestBody: "RegisterSchema",
        responses: {
            200: { body: "TokenOnlyResponse" },
            400: { body: "APIErrorOrCaptchaResponse" },
        },
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const totalSw = Stopwatch.startNew();
        const incSw = Stopwatch.startNew();
        const logTrace = (...data: unknown[]) => {
            if (process.env.LOG_VERBOSE_TRACES !== "true") return;
            console.log("[Register]", ...data, `[${totalSw.elapsed().toString()} (+${incSw.getElapsedAndReset().totalMilliseconds}ms)]`);
        };

        const body = req.body as RegisterSchema;
        const { register, limits } = Config.get();
        const ip = req.ip!;
        await assertIpNotBanned(ip, "Your IP is blocked from registration");

        const captchaKey = captchaKeyFrom(req);
        const captcha = await checkRegistrationCaptcha(captchaKey, false);
        if (captcha) return res.status(400).json(captcha);

        // Reg tokens
        // They're a one time use token that bypasses registration limits ( rates, disabled reg, etc )
        let regTokenUsed = false;
        if (req.get("Referrer") && req.get("Referrer")?.includes("token=")) {
            // eg theyre on https://staging.spacebar.chat/register?token=whatever
            const token = req.get("Referrer")?.split("token=")[1].split("&")[0];
            if (token) {
                const regToken = await ValidRegistrationToken.findOneOrFail({
                    where: { token, expires_at: MoreThan(new Date()) },
                });
                await regToken.remove();
                regTokenUsed = true;
                console.log("[REGISTER] Registration invitation used");
            } else {
                console.log("[REGISTER] Invalid registration invitation");
            }
        }

        // check if registration is allowed
        if (!regTokenUsed && !register.allowNewRegistration) {
            throw FieldErrors({
                username: {
                    code: "REGISTRATION_DISABLED",
                    message: req.t("auth:register.REGISTRATION_DISABLED"),
                },
            });
        }

        // check if the user agreed to the Terms of Service
        if (!body.consent) {
            throw FieldErrors({
                consent: {
                    code: "CONSENT_REQUIRED",
                    message: req.t("auth:register.CONSENT_REQUIRED"),
                },
            });
        }

        if (body.pride_badges !== undefined && !isPrideBadgeSelection(body.pride_badges)) {
            throw FieldErrors({
                pride_badges: {
                    code: "BASE_TYPE_INVALID",
                    message: "Choose flags from the pride badge catalog.",
                },
            });
        }

        if (!regTokenUsed && register.disabled) {
            throw FieldErrors({
                username: {
                    code: "DISABLED",
                    message: "Registration is disabled on this instance",
                },
            });
        }

        if (!regTokenUsed && !register.allowMultipleAccounts) {
            // TODO: check if fingerprint was eligible generated
            const exists = body.fingerprint
                ? await User.findOne({
                      where: { fingerprints: body.fingerprint },
                      select: { id: true },
                  })
                : null;

            if (exists) {
                throw FieldErrors({
                    email: {
                        code: "EMAIL_ALREADY_REGISTERED",
                        message: req.t("auth:register.EMAIL_ALREADY_REGISTERED"),
                    },
                });
            }
        }

        if (!regTokenUsed) await assertRegistrationAllowedForIp(ip, body.username ?? body.global_name);
        if (!regTokenUsed) await assertRegistrationIpCap(ip, body.username ?? body.global_name);

        const reasonField = "join_reason" in body ? "join_reason" : "username";
        const joinReason = typeof body.join_reason === "string" ? body.join_reason.trim() : "";
        const reasonRules = register.joinReason;
        if (reasonRules.required && joinReason.length < reasonRules.minLength)
            throw FieldErrors({
                [reasonField]: {
                    code: "JOIN_REASON_REQUIRED",
                    message: joinReason
                        ? `Tell us a bit more about why you want to join. Use at least ${reasonRules.minLength} characters.`
                        : `This instance asks why you want to join. Write at least ${reasonRules.minLength} characters.`,
                },
            });
        if (joinReason.length > reasonRules.maxLength)
            throw FieldErrors({ join_reason: { code: "BASE_TYPE_BAD_LENGTH", message: `Must be ${reasonRules.maxLength} or fewer in length.` } });
        const reasonMatch = instanceAutomodMatch(joinReason, true);
        if (reasonMatch) {
            await recordAutomodAction({
                username: (body.username ?? body.global_name ?? "").slice(0, 64) || null,
                rule: reasonMatch.rule,
                match: reasonMatch,
                source: "registration",
                action: "block",
                text: joinReason,
            }).catch(() => undefined);
            throw FieldErrors({ [reasonField]: { code: "JOIN_REASON_NOT_ALLOWED", message: "Your answer contains words that aren't allowed on this instance." } });
        }

        logTrace("Basic checks");

        //region IP checks
        if (register.enableAbuseIpDb || register.enableIpData) {
            const cacheBlockedIp = (ip: string, reason: string) => {
                recentlyBlockedIps[ip] = {
                    firstHit: new Date(),
                    lastHit: new Date(),
                    hits: 0,
                    reason,
                };
                console.log(`[Register] ${ip} blocked from registration:`, reason);
            };

            if (!regTokenUsed && recentlyBlockedIps[ip]) {
                if (new TimeSpan(recentlyBlockedIps[ip].firstHit.getTime(), new Date().getTime()).totalHours >= 24) delete recentlyBlockedIps[ip];
                else {
                    recentlyBlockedIps[ip].lastHit = new Date();
                    recentlyBlockedIps[ip].hits++;
                    console.log(
                        `[Register] ${ip} blocked from registration: blocked since ${recentlyBlockedIps[ip].firstHit} with ${recentlyBlockedIps[ip].hits} hits and reason:`,
                        recentlyBlockedIps[ip].reason,
                    );
                    throw new HTTPError("Your IP is blocked from registration");
                }
            }

            if (!regTokenUsed && register.enableAbuseIpDb) {
                const blacklist = await AbuseIpDbClient.getBlacklist();
                if (blacklist) {
                    const entry = blacklist.data.find((e) => e.ipAddress === ip);

                    if (entry && entry.abuseConfidenceScore >= register.blockAbuseIpDbAboveScore) {
                        cacheBlockedIp(ip, `AbuseIPDB score ${entry.abuseConfidenceScore} >= ${register.blockAbuseIpDbAboveScore} (BLACKLIST)`);
                        throw new HTTPError("Your IP is blocked from registration");
                    }
                }

                const checkIp = await AbuseIpDbClient.checkIpAddress(ip);
                if (checkIp?.data && checkIp.data.abuseConfidenceScore >= register.blockAbuseIpDbAboveScore) {
                    cacheBlockedIp(ip, `AbuseIPDB score ${checkIp.data.abuseConfidenceScore} >= ${register.blockAbuseIpDbAboveScore} (CHECK)`);
                    throw new HTTPError("Your IP is blocked from registration");
                }
            }

            if (!regTokenUsed && register.enableIpData) {
                const ipData = await IpDataClient.getIpInfo(ip);
                if (ipData) {
                    if (!ipData.threat) {
                        console.log("Invalid IPData.co response, missing threat field", ipData);
                    }
                    const categories = Object.entries(ipData.threat)
                        .filter(([key, value]) => key.startsWith("is_") && value === true)
                        .map(([key]) => key.replace("is_", ""));
                    const blockedCategories = new Set(categories).intersection(new Set(register.blockIpDataCoThreatTypes));
                    if (blockedCategories.size > 0) {
                        cacheBlockedIp(ip, `IPData.co threat types ${Array.from(blockedCategories).join(", ")}`);
                        throw new HTTPError("Your IP is blocked from registration");
                    }

                    if (ipData.asn.type && register.blockAsnTypes.includes(ipData.asn.type)) {
                        cacheBlockedIp(ip, `IPData.co ASN type ${ipData.asn.type} is blocked`);
                        throw new HTTPError("Your IP is blocked from registration");
                    } else if (!ipData.asn.type) {
                        console.log("[Register] IPData.co response missing asn.type field", ipData);
                    }

                    if (ipData.asn.asn && register.blockAsns.includes(ipData.asn.asn)) {
                        cacheBlockedIp(ip, `IPData.co ASN ${ipData.asn.name} is blocked`);
                        throw new HTTPError("Your IP is blocked from registration");
                    } else if (!ipData.asn.asn) {
                        console.log("[Register] IPData.co response missing asn.asn field", ipData);
                    }
                }
            }
            logTrace("IP checks");
        }
        //endregion

        // TODO: gift_code_sku_id?
        // TODO: check password strength

        const email = body.email;
        if (email) {
            // replace all dots and chars after +, if its a gmail.com email
            if (!email) {
                throw FieldErrors({
                    email: {
                        code: "INVALID_EMAIL",
                        message: req?.t("auth:register.INVALID_EMAIL"),
                    },
                });
            }

            // check if there is already an account with this email
            const exists = await User.findOne({ where: { email: email } });

            if (exists) {
                throw FieldErrors({
                    email: {
                        code: "EMAIL_ALREADY_REGISTERED",
                        message: req.t("auth:register.EMAIL_ALREADY_REGISTERED"),
                    },
                });
            }
        } else if (register.email.required) {
            throw FieldErrors({
                email: {
                    code: "BASE_TYPE_REQUIRED",
                    message: req.t("common:field.BASE_TYPE_REQUIRED"),
                },
            });
        }

        logTrace("Email checks");

        if (body.date_of_birth) {
            const parsedDob = new Date(body.date_of_birth);
            if (Number.isNaN(parsedDob.getTime())) {
                throw FieldErrors({
                    date_of_birth: {
                        code: "DATE_OF_BIRTH_INVALID",
                        message: req.t("auth:register.DATE_OF_BIRTH_INVALID"),
                    },
                });
            }

            const minimum = new Date();
            minimum.setFullYear(minimum.getFullYear() - register.dateOfBirth.minimum);
            if (parsedDob > minimum) {
                throw FieldErrors({
                    date_of_birth: {
                        code: "DATE_OF_BIRTH_UNDERAGE",
                        message: req.t("auth:register.DATE_OF_BIRTH_UNDERAGE", {
                            years: register.dateOfBirth.minimum,
                        }),
                    },
                });
            }
        }

        const passwordKey = !regTokenUsed && body.password ? signupPasswordKey(body.password) : null;
        if (body.password) {
            const min = register.password.minLength ?? 8;

            if (body.password.length < min) {
                throw FieldErrors({
                    password: {
                        code: "PASSWORD_REQUIREMENTS_MIN_LENGTH",
                        message: req.t("auth:register.PASSWORD_REQUIREMENTS_MIN_LENGTH", { min: min }),
                    },
                });
            }
            // the salt is saved in the password refer to bcrypt docs
            // body.password = await BcryptWorkerPool.GetBcryptWorker().hashPassword(body.password, 12);
            body.password = await bcrypt.hash(body.password, 12);
        } else if (register.password.required) {
            throw FieldErrors({
                password: {
                    code: "BASE_TYPE_REQUIRED",
                    message: req.t("common:field.BASE_TYPE_REQUIRED"),
                },
            });
        }
        logTrace("Password checks");

        const instanceInvite = typeof body.instance_invite === "string" ? body.instance_invite.trim() : "";
        const inviteRequired = !regTokenUsed && register.requireInvite;
        if (inviteRequired && !instanceInvite) throw inviteError("INVITE_ONLY", "This instance is invite-only. Open the invite link a member sent you to sign up.");
        if (inviteRequired && !(await findUsableInvite(instanceInvite)))
            throw inviteError("INVALID_INVITE", "This invite is invalid, expired or used up. Ask for a new invite link.");

        if (
            !regTokenUsed &&
            limits.absoluteRate.register.enabled &&
            (await User.count({
                where: {
                    created_at: MoreThan(new Date(Date.now() - limits.absoluteRate.register.window)),
                    federated_instance: IsNull(),
                },
            })) >= limits.absoluteRate.register.limit
        ) {
            console.log(`Global register ratelimit exceeded for ${req.ip}, ${req.body.username}, ${req.body.invite || "No invite given"}`);
            throw FieldErrors({
                username: {
                    code: "TOO_MANY_REGISTRATIONS",
                    message: req.t("auth:register.TOO_MANY_REGISTRATIONS"),
                },
            });
        }
        logTrace("Absolute register rate checks");

        if (!body.username) {
            const base =
                (body.global_name ?? "")
                    .normalize("NFKD")
                    .toLowerCase()
                    .replace(/[^a-z0-9_.]/g, "")
                    .replace(/\.{2,}/g, ".")
                    .slice(0, 24) || "user";
            let candidate = base.length < 2 ? `${base}_` : base;
            while (await User.exists({ where: { username: ILike(candidate.replace(/[\\%_]/g, "\\$&")) } })) candidate = `${base}${crypto.randomInt(1000, 100000)}`;
            body.username = candidate;
        }

        const { maxUsername } = Config.get().limits.user;
        if (body.username.length > maxUsername) {
            throw FieldErrors({
                username: {
                    code: "BASE_TYPE_BAD_LENGTH",
                    message: `Must be between 2 and ${maxUsername} in length.`,
                },
            });
        }

        body.username = trimSpecial(body.username);
        assertIdentityNameAllowed(body.username, "username", { source: "registration" });
        assertIdentityNameAllowed(body.global_name, "global_name", { source: "registration", username: body.username });
        User.assertUsernameAllowed(body.username);
        if (await User.isUsernameTaken(body.username))
            throw FieldErrors({
                username: {
                    code: "USERNAME_ALREADY_TAKEN",
                    message: "Username is unavailable. Try adding numbers, letters, underscores _ , or periods.",
                },
            });

        const assessment = regTokenUsed ? null : await assessSignup({ username: body.username, email: body.email, passwordKey, captchaToken: captchaKey });

        if (register.requireCaptcha && registrationCapEndpoint() === "/api/v9/auth/cap/") {
            const claimed = await checkRegistrationCaptcha(captchaKey);
            if (claimed) return res.status(400).json(claimed);
        }

        const claimedInvite = instanceInvite ? await claimInvite(instanceInvite) : null;
        if (inviteRequired && !claimedInvite) throw inviteError("INVALID_INVITE", "This invite is invalid, expired or used up. Ask for a new invite link.");

        let user: User;
        try {
            user = await User.register({ ...body, username: body.username, req, registration_ip: normalizeIp(ip) });
        } catch (error) {
            if (claimedInvite) await releaseInvite(claimedInvite.code);
            throw error;
        }
        if (claimedInvite) await recordInvitedUser(user.id, claimedInvite);
        logTrace("Register user");
        await recordRegistrationForIp(ip);

        await logSignupAssessment(user, assessment);
        const pending = !regTokenUsed && (register.requireApproval || assessment?.verdict === "hold");
        if (joinReason || pending) await User.update({ id: user.id }, { join_reason: joinReason || null, join_status: pending ? "pending" : null });
        if (pending)
            throw FieldErrors({
                [reasonField]: {
                    code: "ACCOUNT_PENDING_APPROVAL",
                    message: "Your account was created. A moderator needs to approve it before you can log in, so try logging in later.",
                },
            });

        if (body.invite) {
            // await to fail if the invite doesn't exist (necessary for requireInvite to work properly) (username only signups are possible)
            const target = await Invite.findOne({ where: { code: body.invite }, relations: { guild: true } });
            const paused = target?.guild?.incidents_data?.invites_disabled_until;
            if (!paused || new Date(paused).getTime() <= Date.now()) {
                const { new_member } = await Invite.joinGuild(user.id, body.invite);
                if (new_member) await onGuildMemberJoin(target!.guild_id, user.id, body.invite);
            }
            logTrace("Accept invite");
        }

        res.json({ token: await generateToken(user.id) });
        logTrace("Generate token");
    },
);

export default router;

/**
 * POST /auth/register
 * @argument { "fingerprint":"805826570869932034.wR8vi8lGlFBJerErO9LG5NViJFw", "email":"qo8etzvaf@gmail.com", "username":"qp39gr98", "password":"wtp9gep9gw", "invite":null, "consent":true, "date_of_birth":"2000-04-04", "gift_code_sku_id":null, "captcha_key":null}
 *
 * Field Error
 * @returns { "code": 50035, "errors": { "consent": { "_errors": [{ "code": "CONSENT_REQUIRED", "message": "You must agree to Discord's Terms of Service and Privacy Policy." }]}}, "message": "Invalid Form Body"}
 *
 * Success 200:
 * @returns {token: "OMITTED"}
 */
