import definePlugin from "@utils/types";

import { FosscordAuthor } from "../fosscordCore/shared";

export default definePlugin({
    name: "FosscordLimits",
    description:
        "Uses the instance's message, bio, server, friend, nickname, emoji, sticker and soundboard limits from the admin settings instead of Discord's built-in ones, on desktop and mobile web.",
    authors: [FosscordAuthor],
    required: true,

    patches: [
        {
            find: '"getGroupDMRecipientLimit"',
            all: true,
            replacement: {
                match: /return (\i)\?\.isStaff\(\)\?\i\.\i:\i&&\(0,\i\.\i\)\(\1,\i\.PremiumTypes\.TIER_2\)&&\(0,\i\.\i\)\("getGroupDMRecipientLimit"\)\.enabled\?25:\i\.\i/,
                replace: "return (window.GLOBAL_ENV?.INSTANCE_LIMITS?.channel?.maxGroupDmRecipients||25)",
            },
        },
        {
            find: /\i\.\i\.canUseIncreasedMessageLength\(\i\.getCurrentUser\(\)\)\?/,
            replacement: {
                match: /\i\.\i\.canUseIncreasedMessageLength\(\i\.getCurrentUser\(\)\)\?\i\.\i:\i\.\i/,
                replace: "(window.GLOBAL_ENV?.INSTANCE_LIMITS?.message?.maxCharacters||4000)",
            },
        },
        {
            find: "Message Too Long Alert",
            all: true,
            replacement: {
                match: /let (\i)=\i\?\i\.\i:\i\.\i;if\((\i)\.length>\1\)\{if\((\i)\|\|null==(\i)\)/,
                replace: "let $1=(window.GLOBAL_ENV?.INSTANCE_LIMITS?.message?.maxCharacters||4000);if($2.length>$1){if($3||null==$4)",
            },
        },
        {
            find: '[i.ForwardContextMessage=6]="ForwardContextMessage"',
            replacement: {
                match: /=\i\(\d+\)\.\i\+500/,
                replace: "=(window.GLOBAL_ENV?.INSTANCE_LIMITS?.message?.maxCharacters||4000)+500",
            },
        },
        {
            find: "uploadPromptCharacterCount",
            replacement: {
                match: /uploadPromptCharacterCount:\i\.\i/,
                replace: "uploadPromptCharacterCount:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.message?.maxCharacters||4000)",
            },
        },
        {
            find: "premiumMaxMessageLength:",
            replacement: {
                match: /premiumMaxMessageLength:\i\.\i/,
                replace: "premiumMaxMessageLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.message?.maxCharacters||4000)",
            },
        },
        {
            find: '"2026-08-user-bio-max-length"',
            replacement: {
                match: /defaultConfig:\{maxLength:\i\.\i\},variations:\{0:\{maxLength:\i\.\i\},1:\{maxLength:\i\.\i\}\}/,
                replace:
                    "defaultConfig:{maxLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxBio||190)},variations:{0:{maxLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxBio||190)},1:{maxLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxBio||190)}}",
            },
        },
        {
            find: "ttJ/hj",
            replacement: {
                match: /\i\.\i\.canUseIncreasedGuildCap\(\i\)\|\|\i\?\.isStaff\(\)\?\i\.\i:\i\.\i/,
                replace: "(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxGuilds||200)",
            },
        },
        {
            find: "maxFriends:",
            all: true,
            replacement: {
                match: /maxFriends:\i\.\i/,
                replace: "maxFriends:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxFriends||5000)",
            },
        },
        {
            find: '"new_nick"',
            replacement: {
                match: /("new_nick",displayName:"new_nick",type:\i\.\i\.STRING.{0,400}?)maxLength:\i\.\i/,
                replace: "$1maxLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxUsername||32)",
            },
        },
        {
            find: /getGuildCount\(\)>=\i\.\i/,
            replacement: {
                match: /getGuildCount\(\)>=\i\.\i/,
                replace: "getGuildCount()>=(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxGuilds||200)",
            },
        },
        {
            find: "getMaxAttachmentsCount(){return",
            all: true,
            replacement: {
                match: /getMaxAttachmentsCount\(\)\{return (?:\i\.\i|\d+)\}/,
                replace: "getMaxAttachmentsCount(){return (window.GLOBAL_ENV?.INSTANCE_LIMITS?.message?.maxAttachments||15)}",
            },
        },
        {
            find: /"username",(?:value:\i,maxLength|setRef:)/,
            all: true,
            replacement: {
                match: /("username".{0,400}?)maxLength\s*:\s*(?:32\b|\i\.\i)/,
                replace: "$1maxLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxUsername||32)",
            },
        },
        {
            find: "onPronounsChange",
            replacement: {
                match: /(pendingPronouns[\s\S]{0,400}?)maxLength:40/,
                replace: "$1maxLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxPronouns||40)",
            },
        },
        {
            find: '"global_name",value:',
            replacement: {
                match: /("(?:displayName|display_name|globalName|global_name)".{0,400}?)maxLength\s*:\s*(?:32\b|\i\.\i)/,
                replace: "$1maxLength:(window.GLOBAL_ENV?.INSTANCE_LIMITS?.user?.maxUsername||32)",
            },
        },
        {
            find: 'TIER_0=3]="TIER_0"',
            replacement: {
                match: /\{(\[\i\.\i\.NONE\]:)\i,(\[\i\.\i\.TIER_1\]:10,\[\i\.\i\.TIER_2\]:15,\[\i\.\i\.TIER_3\]:30)\}/,
                replace: "{$1(window.GLOBAL_ENV?.INSTANCE_LIMITS?.guild?.maxStickers||500),$2}",
            },
        },
        {
            find: /additionalEmojiSlots\?\?0\);return/,
            replacement: [
                {
                    match: /let (\i)=\i\.DEFAULT_EMOJI_SLOTS\+\(\i\.premiumFeatures\?\.additionalEmojiSlots\?\?0\);/,
                    replace: "let $1=(window.GLOBAL_ENV?.INSTANCE_LIMITS?.guild?.maxEmojis||2000);",
                },
                {
                    match: /return Math\.max\(\i\.features\.has\(\i\.\i\.MORE_EMOJI\)\?\i\.EMOJI_MAX_SLOTS_MORE:\i\.DEFAULT_EMOJI_SLOTS,(\i)\)/,
                    replace: "return $1;",
                },
                {
                    match: /function (\i)\((\i),(\i)\)\{return null!=\3&&\3\.features\.has\(\i\.\i\.MORE_STICKERS\)&&\2===\i\.\i\.TIER_3\?\i\.\i\.MAX_STICKER_SLOTS:\i\.\i\[\2\]\}/,
                    replace: "function $1($2,$3){return (window.GLOBAL_ENV?.INSTANCE_LIMITS?.guild?.maxStickers||500)}",
                },
                {
                    match: /function (\i)\((\i)\)\{let \i=\i\.\i\+\(\2\.premiumFeatures\?\.additionalSoundSlots\?\?0\);return Math\.max\(\2\.features\.has\(\i\.\i\.MORE_SOUNDBOARD\)\?\i\.\i:\i\.\i,\i\)\}/,
                    replace: "function $1($2){return 48}",
                },
            ],
        },
    ],
});
