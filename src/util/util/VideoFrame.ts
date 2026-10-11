import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_VIDEO_SIZE = 64 * 1024 * 1024;
const MAX_FRAME_SIZE = 4 * 1024 * 1024;
const MAX_PREVIEW_JOBS = 4;
const MAX_TIMEOUT_MS = 15000;
const previewJobs = new Map<string, Promise<Buffer | null>>();
let ffmpegMissing = false;

const runFfmpeg = (file: string, timeoutMs: number) =>
    new Promise<Buffer | null>((resolve) => {
        const ffmpeg = spawn(
            process.env.FFMPEG_PATH || "ffmpeg",
            [
                "-loglevel",
                "error",
                "-format_whitelist",
                "mov,matroska,webm,avi,ogg,mpeg,mpegts,flv",
                "-protocol_whitelist",
                "file,pipe",
                "-max_alloc",
                "67108864",
                "-threads",
                "1",
                "-i",
                file,
                "-frames:v",
                "1",
                "-vf",
                "scale=min(iw\\,1280):min(ih\\,1280):force_original_aspect_ratio=decrease:force_divisible_by=2",
                "-threads",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "mjpeg",
                "-q:v",
                "4",
                "pipe:1",
            ],
            { stdio: ["ignore", "pipe", "ignore"] },
        );
        const chunks: Buffer[] = [];
        let bytes = 0;
        let stopped = false;
        const stop = () => {
            stopped = true;
            chunks.length = 0;
            ffmpeg.kill("SIGKILL");
        };
        const timer = setTimeout(stop, timeoutMs);
        ffmpeg.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") ffmpegMissing = true;
            clearTimeout(timer);
            resolve(null);
        });
        ffmpeg.stdout.on("data", (chunk: Buffer) => {
            if (stopped) return;
            bytes += chunk.length;
            if (bytes > MAX_FRAME_SIZE) return stop();
            chunks.push(chunk);
        });
        ffmpeg.on("close", (code) => {
            clearTimeout(timer);
            resolve(!stopped && code === 0 && chunks.length ? Buffer.concat(chunks, bytes) : null);
        });
    });

const createVideoFrame = async (data: Buffer, timeoutMs: number): Promise<Buffer | null> => {
    let file: string | undefined;
    try {
        file = path.join(tmpdir(), `sb-frame-${randomBytes(16).toString("hex")}`);
        await writeFile(file, data, { flag: "wx", mode: 0o600 });
        return await runFfmpeg(file, timeoutMs);
    } catch {
        return null;
    } finally {
        if (file) await rm(file, { force: true }).catch(() => undefined);
    }
};

export async function extractVideoFrame(input: Buffer, timeoutMs = MAX_TIMEOUT_MS): Promise<Buffer | null> {
    if (ffmpegMissing || input.length > MAX_VIDEO_SIZE) return null;
    const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutMs))) : MAX_TIMEOUT_MS;
    const digest = createHash("sha256").update(input).digest("hex");
    const key = `${digest}:${timeout}`;
    const existing = previewJobs.get(key);
    if (existing) return existing;
    if (previewJobs.size >= MAX_PREVIEW_JOBS) return null;
    const job = createVideoFrame(input, timeout);
    previewJobs.set(key, job);
    try {
        return await job;
    } finally {
        previewJobs.delete(key);
    }
}

export const readVideoDimensions = (buf: Buffer): { width: number; height: number } | undefined => {
    for (let i = buf.indexOf("tkhd"); i !== -1; i = buf.indexOf("tkhd", i + 4)) {
        const start = i - 4;
        const size = start >= 0 ? buf.readUInt32BE(start) : 0;
        if (size < 84 || start + size > buf.length) continue;
        const width = buf.readUInt32BE(start + size - 8) >>> 16;
        const height = buf.readUInt32BE(start + size - 4) >>> 16;
        if (width && height) return { width, height };
    }
    const readVint = (at: number) => {
        const first = buf[at];
        const length = Math.clz32(first) - 23;
        if (length < 1 || length > 8) return undefined;
        let value = first & ((1 << (8 - length)) - 1);
        for (let j = 1; j < length; j++) value = value * 256 + buf[at + j];
        return { length, value };
    };
    for (let i = buf.indexOf(0xe0); i !== -1; i = buf.indexOf(0xe0, i + 1)) {
        const size = readVint(i + 1);
        if (!size || size.value > 256) continue;
        const end = i + 1 + size.length + size.value;
        const dims: Record<number, number> = {};
        for (let at = i + 1 + size.length; at < end && at < buf.length; ) {
            const id = buf[at];
            const len = readVint(at + 1);
            if (!len) break;
            const valueAt = at + 1 + len.length;
            if ((id === 0xb0 || id === 0xba) && len.value <= 4) dims[id] = buf.readUIntBE(valueAt, len.value);
            at = valueAt + len.value;
        }
        if (dims[0xb0] && dims[0xba]) return { width: dims[0xb0], height: dims[0xba] };
    }
};
