/* SPDX-License-Identifier: AGPL-3.0-only */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Rights } from "@spacebar/util/util/Rights";
import { bucketStarts, canReadMetric, fillBuckets, parseTimeseriesQuery, timeseriesWindow } from "./adminTimeseries";

const NOW = Date.parse("2026-10-13T15:42:10.000Z");

test("24 hour range has 24 hourly buckets ending with the current hour", () => {
    const window = timeseriesWindow("24h", NOW);
    assert.equal(window.bucket, "hour");
    assert.equal(window.buckets, 24);
    const starts = bucketStarts(window);
    assert.equal(starts.length, 24);
    assert.equal(starts[0], "2026-10-12T16:00:00.000Z");
    assert.equal(starts[23], "2026-10-13T15:00:00.000Z");
    assert.equal(window.end, NOW);
    assert.equal(window.previousStart, Date.parse("2026-10-11T16:00:00.000Z"));
    assert.equal(window.previousEnd, NOW - 24 * 60 * 60 * 1000);
});

test("day ranges bucket by day and end with today", () => {
    for (const [range, days] of [
        ["7d", 7],
        ["30d", 30],
        ["90d", 90],
    ] as const) {
        const window = timeseriesWindow(range, NOW);
        const starts = bucketStarts(window);
        assert.equal(window.bucket, "day");
        assert.equal(starts.length, days);
        assert.equal(starts.at(-1), "2026-10-13T00:00:00.000Z");
        assert.equal(Date.parse(starts[1]) - Date.parse(starts[0]), 24 * 60 * 60 * 1000);
    }
});

test("a UTC offset moves day boundaries to local midnight", () => {
    const window = timeseriesWindow("7d", NOW, 120);
    assert.equal(bucketStarts(window).at(-1), "2026-10-12T22:00:00.000Z");
    const behind = timeseriesWindow("7d", Date.parse("2026-10-13T02:00:00.000Z"), -300);
    assert.equal(bucketStarts(behind).at(-1), "2026-10-12T05:00:00.000Z");
});

test("empty buckets are zero and rows outside the window are ignored", () => {
    const window = timeseriesWindow("7d", NOW);
    const points = fillBuckets(window, [
        { bucket: "0", value: "4" },
        { bucket: 6, value: 2 },
        { bucket: "6", value: "1" },
        { bucket: "7", value: "99" },
        { bucket: "-1", value: "99" },
        { bucket: null, value: "99" },
        { bucket: "2.5", value: "99" },
    ]);
    assert.deepEqual(points, [4, 0, 0, 0, 0, 0, 3]);
});

test("the query parser accepts known metrics and ranges and defaults to 7 days", () => {
    assert.deepEqual(parseTimeseriesQuery({ metric: "messages" }), { metric: "messages", range: "7d", utcOffset: 0 });
    assert.deepEqual(parseTimeseriesQuery({ metric: "accounts", range: "24h", utc_offset: "-330" }), { metric: "accounts", range: "24h", utcOffset: -330 });
});

test("the query parser rejects unknown metrics, ranges and offsets with 400", () => {
    const rejects = (query: Record<string, unknown>, pattern: RegExp) =>
        assert.throws(
            () => parseTimeseriesQuery(query),
            (error: Error & { code?: number }) => error.code === 400 && pattern.test(error.message),
        );
    rejects({}, /metric/);
    rejects({ metric: "toString" }, /metric/);
    rejects({ metric: ["messages"] }, /metric/);
    rejects({ metric: "messages", range: "1y" }, /range/);
    rejects({ metric: "messages", range: "__proto__" }, /range/);
    rejects({ metric: "messages", utc_offset: "61" }, /utc_offset/);
    rejects({ metric: "messages", utc_offset: "900" }, /utc_offset/);
    rejects({ metric: "messages", utc_offset: "1e2" }, /utc_offset/);
});

test("metrics follow the rights of the pages they come from", () => {
    const moderator = new Rights(Rights.FLAGS.VIEW_MODERATION);
    const support = new Rights(Rights.FLAGS.SUPPORT_USERS);
    const operator = new Rights(Rights.FLAGS.OPERATOR);
    const nobody = new Rights(0n);
    assert.equal(canReadMetric(moderator, "messages"), true);
    assert.equal(canReadMetric(moderator, "reports_opened"), true);
    assert.equal(canReadMetric(moderator, "attachment_bytes"), false);
    assert.equal(canReadMetric(support, "accounts"), true);
    assert.equal(canReadMetric(support, "automod_actions"), false);
    assert.equal(canReadMetric(operator, "federation"), true);
    assert.equal(canReadMetric(nobody, "messages"), false);
});
