/* SPDX-License-Identifier: AGPL-3.0-only */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const collector = `function(){var out={};try{var c=document.createElement("canvas");var g=c.getContext("webgl")||c.getContext("experimental-webgl");if(g){var d=g.getExtension("WEBGL_debug_renderer_info");out.gl=String(g.getParameter(d?d.UNMASKED_RENDERER_WEBGL:g.RENDERER)||"")}else out.gl=null}catch(e){out.gl=null}try{out.pl=navigator.plugins?navigator.plugins.length:-1;out.mt=navigator.mimeTypes?navigator.mimeTypes.length:-1}catch(e){out.pl=-1;out.mt=-1}try{out.ch=typeof window.chrome}catch(e){out.ch="error"}try{out.np=typeof Notification==="undefined"?null:Notification.permission}catch(e){out.np=null}out.nq=null;var q=Promise.resolve();try{if(navigator.permissions&&navigator.permissions.query)q=navigator.permissions.query({name:"notifications"}).then(function(s){out.nq=s.state},function(){})}catch(e){}return Promise.race([q,new Promise(function(r){setTimeout(r,1500)})]).then(function(){return out})}`;

const relay = `{postMessage:function(m,o){var send=function(x){try{m.result.p.fx=x}catch(e){}window.parent.postMessage(m,o)};if(!m||!m.result||!m.result.p||typeof m.result.p!=="object")return window.parent.postMessage(m,o);(${collector})().then(send,function(){send(null)})}}`;

export function withAutomationSignals(instrumentation: string) {
    const script = inflateRawSync(Buffer.from(instrumentation, "base64")).toString("utf8");
    return deflateRawSync(Buffer.from(`(function(parent){${script}\n})(${relay});`, "utf8"), { level: 1 }).toString("base64");
}

export interface AutomationVerdict {
    automated: boolean;
    reasons: string[];
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software rasterizer|mesa offscreen|basic render driver/i;
const MOBILE = /Android|iPhone|iPad|iPod|Mobile/i;

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

export function judgeAutomation(probe: unknown): AutomationVerdict {
    const p = record(probe);
    const fx = record(p?.fx);
    if (!p || !fx) return { automated: true, reasons: ["signals_missing"] };

    const ua = typeof p.ua === "string" ? p.ua : "";
    const uaData = record(p.uaData);
    const brands = Array.isArray(uaData?.brands) ? uaData.brands.map(String).join(" ") : "";
    const outer = Array.isArray(p.outerWH) ? p.outerWH : [];
    const chromium = p.uaDataPresent === true;
    const mobile = uaData?.mobile === true || MOBILE.test(ua);

    const strong = [
        p.webdriver === true && "webdriver",
        /HeadlessChrome/i.test(`${ua} ${brands}`) && "headless_user_agent",
        outer.length === 2 && outer[0] === 0 && outer[1] === 0 && "zero_window",
    ].filter((reason): reason is string => !!reason);

    const weak = [
        typeof fx.gl === "string" && SOFTWARE_RENDERER.test(fx.gl) && "software_renderer",
        chromium && !mobile && fx.pl === 0 && fx.mt === 0 && "no_plugins",
        chromium && !mobile && fx.ch === "undefined" && "missing_chrome_object",
        fx.np === "denied" && fx.nq === "prompt" && "notification_mismatch",
    ].filter((reason): reason is string => !!reason);

    return { automated: strong.length > 0 || weak.length >= 2, reasons: [...strong, ...weak] };
}

export function tokenHasInstrumentation(token: unknown) {
    if (typeof token !== "string") return false;
    const [, payload] = token.split(".");
    if (!payload) return false;
    try {
        return !!record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))?.ei;
    } catch {
        return false;
    }
}
